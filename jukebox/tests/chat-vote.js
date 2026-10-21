'use strict';
/**
 * 「聊天室 + 昵称唯一性 + 投票切歌」端到端测试
 * ------------------------------------------------------------
 * 用 mock 音源 + mock 播放引擎跑真链路，验证：
 *   ① 昵称唯一：无 clientId / 空名 / 超长 被拒；重名被别人占 → 409；
 *      本人回来可复用；改名后旧昵称被释放
 *   ② 在线人数：靠心跳判定；掉线自动算离开；没昵称的人不算"进了聊天室"
 *   ③ 聊天室：没昵称不能发言、空消息/超长/刷屏被拒、增量拉取、消息落盘
 *   ④ 点歌会在聊天室留下系统消息（聊天室有"场上上下文"）
 *   ⑤ 投票切歌：「超过在线人数一半」才切；可撤票；歌一换票全作废；
 *      管理员带对的口令可直接切
 *   ⑥ 重启后聊天记录与昵称占用都不丢
 *
 * 用法：node tests/chat-vote.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const APP_PORT = 58187;
const MOCK_PORT = 58086;
const MOCK_SRC_PORT = 58085;
const RUN_DIR = path.join(__dirname, '.run-chatvote');
const MUSIC_DIR = path.join(RUN_DIR, 'music');
const DATA_DIR = path.join(RUN_DIR, 'data');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, interval = 300, label = '条件' } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`${label} 超时（${timeout}ms）${last ? '：' + last.message : ''}`);
}

const APP = `http://127.0.0.1:${APP_PORT}`;
const j = async (url, opt) => {
  const r = await fetch(url, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
};
const post = (url, body) =>
  j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

/** 需要看状态码的请求（409/403/429 这类"应该被拒"的用例） */
async function postRaw(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data: d };
}

const state = () => j(`${APP}/api/state`);
const live = (clientId, nick, since) => post(`${APP}/api/live`, { clientId, nick, since: since || 0 });
const chat = (since, limit) => j(`${APP}/api/chat?since=${since || 0}&limit=${limit || 100}`);

const A = 'client-aaa';
const B = 'client-bbb';
const NOPICK = 'client-nickless';

let mockProc = null;
let srcProc = null;
let appProc = null;
const appLog = [];

async function killApp() {
  if (appProc && !appProc.killed) {
    try { appProc.kill(); } catch {}
  }
  appProc = null;
  await sleep(500);
}

/** 起（或重启）点歌台 */
async function startApp() {
  appProc = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, JB_CONFIG: path.join(RUN_DIR, 'config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appProc.stdout.on('data', (d) => appLog.push(d.toString()));
  appProc.stderr.on('data', (d) => appLog.push(d.toString()));
  await waitFor(async () => (await j(`${APP}/api/health`)).ok, { label: '点歌台就绪', timeout: 20000 });
}

async function cleanup() {
  for (const p of [appProc, mockProc, srcProc]) {
    if (p && !p.killed) { try { p.kill(); } catch {} }
  }
  await sleep(400);
}

async function main() {
  console.log('\n===== 聊天室 / 昵称唯一性 / 投票切歌 端到端测试 =====\n');

  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const cfg = {
    port: APP_PORT,
    publicBase: APP,
    musicDir: MUSIC_DIR,
    dataDir: DATA_DIR,
    engine: {
      type: 'songloft',
      base: `http://127.0.0.1:${MOCK_PORT}`,
      prefix: '/api/v1/jsplugin/miot',
      username: 'admin',
      password: 'mock-pass',
    },
    searchSources: ['netease', 'kugou'],
    sources: ['netease', 'kugou'],
    gdApi: `http://127.0.0.1:${MOCK_SRC_PORT}/`,
    retry: 1,
    volume: 0,
    pollIntervalMs: 500,
    minPlaySec: 0,
    overtimeGraceSec: 600, // 别让"超时兜底"来切歌，切歌只能由投票触发
    prefetchCount: 0,
    maxTries: 3,
    rateCooldownMs: 5000,
    // ---- 本次要测的几项 ----
    onlineWindowMs: 5000,   // 5 秒没心跳就算离开（代码里也有 5 秒下限）
    chatMinGapMs: 300,
    chatMaxLen: 40,
    nickMaxLen: 12,
    skipVoteEnabled: true,
    logLevel: 'info',
  };
  fs.writeFileSync(path.join(RUN_DIR, 'config.json'), JSON.stringify(cfg, null, 2));

  mockProc = spawn(NODE, [path.join(__dirname, 'mock-songloft.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '600', MOCK_SPEED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srcProc = spawn(NODE, [path.join(__dirname, 'mock-source.js')], {
    env: { ...process.env, MOCK_SRC_PORT: String(MOCK_SRC_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`)).ok, { label: 'mock 引擎就绪', timeout: 10000 });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_SRC_PORT}/?types=search&name=x&count=1`)).ok, {
    label: 'mock 音源就绪', timeout: 10000,
  });

  await startApp();
  check('mock 引擎 + mock 音源 + 点歌台 全部启动', true, `:${MOCK_PORT} / :${MOCK_SRC_PORT} / :${APP_PORT}`);

  // ============================================================ ① 昵称唯一性
  console.log('\n--- ① 昵称唯一性 ---');
  const c1 = await postRaw(`${APP}/api/nick/claim`, { nick: '小明' });
  check('没有 clientId → 拒绝占名', c1.status === 400, `HTTP ${c1.status} ${c1.data.error || ''}`);

  const c2 = await postRaw(`${APP}/api/nick/claim`, { clientId: A, nick: '   ' });
  check('空昵称 → 拒绝', c2.status === 400, `HTTP ${c2.status} ${c2.data.error || ''}`);

  const c3 = await postRaw(`${APP}/api/nick/claim`, { clientId: A, nick: '这个昵称实在是太长了一定超过十二个字' });
  check('超长昵称 → 拒绝', c3.status === 400 && /最多/.test(c3.data.error || ''), c3.data.error);

  const c4 = await postRaw(`${APP}/api/nick/claim`, { clientId: A, nick: '小明' });
  check('A 占名「小明」成功', c4.ok && c4.data.nick === '小明', `online=${c4.data.online}`);

  const c5 = await postRaw(`${APP}/api/nick/claim`, { clientId: B, nick: '小明' });
  check('B 用同一个昵称 → 被拒（409）', c5.status === 409 && c5.data.taken === true, `HTTP ${c5.status} ${c5.data.error || ''}`);

  const c6 = await postRaw(`${APP}/api/nick/claim`, { clientId: A, nick: '小明' });
  check('A 自己回来可复用同一昵称', c6.ok, `nick=${c6.data.nick}`);

  const c7 = await postRaw(`${APP}/api/nick/claim`, { clientId: B, nick: '小红' });
  check('B 换个昵称就成功', c7.ok && c7.data.nick === '小红', `nick=${c7.data.nick}`);

  const chk1 = await j(`${APP}/api/nick/check?nick=${encodeURIComponent('小明')}&clientId=${B}`);
  const chk2 = await j(`${APP}/api/nick/check?nick=${encodeURIComponent('小明')}&clientId=${A}`);
  const chk3 = await j(`${APP}/api/nick/check?nick=${encodeURIComponent('没人用的名字')}&clientId=${B}`);
  check('查重接口：别人占着 → taken;自己 → 不算被占;没人用 → 可用',
    chk1.taken === true && chk2.taken === false && chk3.taken === false,
    `B看小明=${chk1.taken}, A看小明=${chk2.taken}, 空名=${chk3.taken}`);

  const c8 = await postRaw(`${APP}/api/nick/claim`, { clientId: A, nick: '小明王' });
  const c9 = await postRaw(`${APP}/api/nick/claim`, { clientId: B, nick: '小明' });
  check('A 改名后，旧昵称「小明」被释放，B 立刻能用',
    c8.ok && c9.ok, `改名为 ${c8.data.nick} → B 占「${c9.data.nick}」${c9.ok ? '成功' : '失败'}`);
  await postRaw(`${APP}/api/nick/claim`, { clientId: B, nick: '小红' }); // B 改回小红，后面用例好认

  // ============================================================ ② 在线人数
  console.log('\n--- ② 在线人数（心跳判定） ---');
  const l1 = await live(A, '小明王');
  const l2 = await live(B, '小红');
  check('两人心跳后 online=2，切歌门槛 need=2（过半）',
    l1.online === 2 && l1.need === 2, `online=${l1.online} need=${l1.need}`);

  const l3 = await live(NOPICK, '还没起名字的人');
  check('没占过昵称的 clientId 不算"进了聊天室"（online 不变、needNick=true）',
    l3.online === 2 && l3.needNick === true, `online=${l3.online} needNick=${l3.needNick}`);

  const l4 = await live(A, '小明王', 0);
  check('已设昵称的人 needNick=false，且返回在线名单',
    l4.needNick === false && (l4.users || []).length === 2,
    `users=${(l4.users || []).map((u) => u.nick).join('/')}`);

  await sleep(5600);
  const l5 = await live(A, '小明王');
  check('超过心跳窗口没动静 → 自动算离开（只剩刚心跳的 1 人）',
    l5.online === 1 && l5.need === 1, `online=${l5.online} need=${l5.need}`);

  // ============================================================ ③ 聊天室
  console.log('\n--- ③ 聊天室 ---');
  const m0 = await postRaw(`${APP}/api/chat/send`, { clientId: NOPICK, text: '我没起名字' });
  check('没设昵称就发言 → 403 被挡', m0.status === 403 && m0.data.needNick === true, `HTTP ${m0.status}`);

  await live(A, '小明王'); await live(B, '小红');
  const m1 = await postRaw(`${APP}/api/chat/send`, { clientId: A, text: '大家好，我是小明王' });
  check('正常发言成功', m1.ok && m1.data.msg && m1.data.msg.nick === '小明王', `id=${m1.data.msg && m1.data.msg.id}`);

  const m2 = await postRaw(`${APP}/api/chat/send`, { clientId: B, text: '   ' });
  check('空消息 → 拒绝', m2.status === 400, `HTTP ${m2.status} ${m2.data.error || ''}`);

  const m3 = await postRaw(`${APP}/api/chat/send`, { clientId: B, text: 'x'.repeat(100) });
  check('超长消息 → 拒绝', m3.status === 400 && /最多/.test(m3.data.error || ''), m3.data.error);

  await sleep(400);
  const g1 = await postRaw(`${APP}/api/chat/send`, { clientId: B, text: '第二句' });
  const g2 = await postRaw(`${APP}/api/chat/send`, { clientId: B, text: '第三句（太快了）' });
  check('连发太快 → 429 被限流', g1.ok && g2.status === 429, `第一句 ${g1.status} / 第二句 ${g2.status}`);

  const all = await chat(0, 100);
  check('聊天记录可拉取，且带昵称/时间戳',
    all.msgs.length >= 2 && all.msgs.every((m) => m.id && m.at && m.nick !== undefined),
    `${all.msgs.length} 条`);

  const lastId = all.msgs[all.msgs.length - 1].id;
  await sleep(400);
  await postRaw(`${APP}/api/chat/send`, { clientId: B, text: '增量测试' });
  const inc = await chat(lastId, 100);
  check('since=<id> 只返回之后的新消息（增量）',
    inc.msgs.length >= 1 && inc.msgs.every((m) => m.id > lastId),
    `新增 ${inc.msgs.length} 条，最小 id=${inc.msgs[0] && inc.msgs[0].id}`);

  check('聊天记录已落盘 chat.json', fs.existsSync(path.join(DATA_DIR, 'chat.json')));
  check('昵称占用已落盘 nicks.json', fs.existsSync(path.join(DATA_DIR, 'nicks.json')));

  // ============================================================ ④ 点歌 → 系统消息
  console.log('\n--- ④ 点歌进入聊天室（系统消息） ---');
  const s1 = await j(`${APP}/api/search?q=` + encodeURIComponent('晴天'));
  const songA = s1.results.find((x) => x.name === '晴天') || s1.results[0];
  await post(`${APP}/api/enqueue`, { song: songA, requester: '小明王' });
  await waitFor(async () => {
    const st = await state();
    return st.current && st.current.status === 'playing' ? st : null;
  }, { label: '起播', timeout: 25000 });

  const all2 = await chat(0, 100);
  const sysMsg = all2.msgs.filter((m) => m.kind === 'sys').slice(-3);
  check('点歌产生系统消息（含点歌人与歌名）',
    sysMsg.some((m) => /点了一首/.test(m.text) && m.text.includes('小明王') && m.text.includes(songA.name)),
    sysMsg.map((m) => m.text).join(' | '));

  const stA = await state();
  const qidA = stA.current.qid;
  check('/api/state 暴露在线人数与投票门槛', stA.online >= 1 && stA.voteNeed >= 1 && stA.voteEnabled === true,
    `online=${stA.online} need=${stA.voteNeed} enabled=${stA.voteEnabled}`);

  // ============================================================ ⑤ 投票切歌
  console.log('\n--- ⑤ 投票切歌（超过在线人数一半） ---');
  await live(A, '小明王'); await live(B, '小红');
  const need2 = (await live(A, '小明王')).need;
  check('两人都在线 → 需要 2 票', need2 === 2, `need=${need2}`);

  const vNoNick = await postRaw(`${APP}/api/skip`, { clientId: NOPICK });
  check('没设昵称的人不能投票（否则分母和票数都能被灌水）',
    vNoNick.status === 400 && vNoNick.data.needNick === true,
    `HTTP ${vNoNick.status} ${vNoNick.data.error || ''}`);

  const v1 = await post(`${APP}/api/skip`, { clientId: A, nick: '小明王' });
  const stV1 = await state();
  check('A 投 1 票：不足半数，歌没被切',
    v1.switched === false && v1.votes === 1 && v1.need === 2 && stV1.current && stV1.current.qid === qidA,
    `votes=${v1.votes}/${v1.need} switched=${v1.switched}`);

  const v1b = await post(`${APP}/api/skip`, { clientId: A, nick: '小明王' });
  check('A 再点一次 = 撤票',
    v1b.switched === false && v1b.votes === 0, `votes=${v1b.votes}/${v1b.need}`);

  await post(`${APP}/api/skip`, { clientId: A, nick: '小明王' });
  const v2 = await post(`${APP}/api/skip`, { clientId: B, nick: '小红' });
  await sleep(600);
  const stV2 = await state();
  check('第二票到齐 → 票数过半，切歌成功',
    v2.switched === true && (!stV2.current || stV2.current.qid !== qidA),
    `switched=${v2.switched}, current=${stV2.current ? stV2.current.name : '(空)'}`);

  const chatVote = await chat(0, 30);
  check('切歌成功会在聊天室播报',
    chatVote.msgs.some((m) => m.kind === 'sys' && /票数过半/.test(m.text)),
    chatVote.msgs.filter((m) => m.kind === 'sys').slice(-1).map((m) => m.text).join(''));

  // 歌换了 → 旧票作废
  const s2 = await j(`${APP}/api/search?q=` + encodeURIComponent('稻香'));
  const songB = s2.results.find((x) => x.name === '稻香') || s2.results[0];
  await post(`${APP}/api/enqueue`, { song: songB, requester: '小红' });
  await waitFor(async () => {
    const st = await state();
    return st.current && st.current.status === 'playing' ? st : null;
  }, { label: '第二首起播', timeout: 25000 });
  await live(A, '小明王'); await live(B, '小红');
  await post(`${APP}/api/skip`, { clientId: A, nick: '小明王' });
  const stV3 = await state();
  check('新的一首开始时，针对上一首的票已清零',
    stV3.vote.qid === stV3.current.qid && stV3.vote.votes === 1,
    `vote.qid==current.qid=${stV3.vote.qid === stV3.current.qid}, votes=${stV3.vote.votes}`);

  // 管理员直切
  console.log('\n--- ⑤-2 管理员可以直接切 ---');
  const badPin = await postRaw(`${APP}/api/skip`, { clientId: A, pin: '0000' });
  check('口令不对 → 按普通投票处理（不直切）',
    badPin.ok && badPin.data.mode === 'vote', `mode=${badPin.data.mode}`);

  await post(`${APP}/api/admin/setup`, { pin: '123456' });
  const vAdmin = await post(`${APP}/api/skip`, { clientId: A, nick: '小明王', pin: '123456' });
  await sleep(600);
  const stV4 = await state();
  check('管理员带对的口令 → 直接切歌，无需投票',
    vAdmin.mode === 'direct' && vAdmin.switched === true && (!stV4.current || stV4.current.qid !== stV3.current.qid),
    `mode=${vAdmin.mode}, current=${stV4.current ? stV4.current.name : '(空)'}`);

  // ============================================================ ⑥ 重启后不丢
  console.log('\n--- ⑥ 重启后聊天记录 / 昵称占用仍在 ---');
  const before = await chat(0, 200);
  await killApp();
  await startApp();
  const after = await chat(0, 200);
  check('聊天记录重启后完整恢复',
    after.msgs.length === before.msgs.length && after.seq === before.seq,
    `重启前 ${before.msgs.length} 条 → 重启后 ${after.msgs.length} 条`);

  const reClaim = await postRaw(`${APP}/api/nick/claim`, { clientId: 'client-other', nick: '小明王' });
  check('昵称占用重启后仍在（别人依然抢不走）',
    reClaim.status === 409, `HTTP ${reClaim.status} ${reClaim.data.error || ''}`);

  const reback = await postRaw(`${APP}/api/nick/claim`, { clientId: A, nick: '小明王' });
  check('本人重启后回来，昵称依然是自己的', reback.ok, `nick=${reback.data.nick}`);

  const lv = await live(A, '小明王');
  check('重启后心跳正常，online 重新计数',
    lv.ok && lv.online === 1 && lv.needNick === false, `online=${lv.online}`);

  // ============================================================ 汇总
  console.log('\n===== 结果 =====');
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`  通过 ${pass}/${results.length}${fail ? `  ❌ 失败 ${fail}` : '  🎉 全绿'}`);
  if (fail) {
    console.log('\n失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ❌ ${r.name} — ${r.detail}`));
    console.log('\n--- 服务端日志尾部 ---');
    console.log(appLog.join('').split('\n').slice(-25).join('\n'));
  }
  await cleanup();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\n测试异常：', e);
  console.log('\n--- 服务端日志尾部 ---');
  console.log(appLog.join('').split('\n').slice(-30).join('\n'));
  await cleanup();
  process.exit(1);
});

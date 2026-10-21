'use strict';
/**
 * 队列「👍 往前挪一位」+ 删除功能下线（离线端到端）
 * ------------------------------------------------------------
 * 用户 2026-10-21 的要求：
 *   ① 「去掉删除列表歌曲的功能」
 *   ② 「置顶改成点赞超过 2 名才能往前进一步」
 *
 * 验的判据：
 *   · 页面上没有删除按钮（`data-del` 没了），接口删歌必须带管理员口令；
 *   · 一个人点不动（1 票不挪），两个人也不够（need=3 = "超过 2 名"）；
 *   · 凑够 3 个**不同的人**才挪，而且只往前**一位**，不是飞到最前；
 *   · 挪完票清零；同一人再点 = 撤票；已在第 1 位不挪；
 *   · 服务端只认"起过昵称"的 clientId（防一个人开三个标签页刷票）。
 *
 * 用法：node tests/queue-top.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const MOCK_PORT = 58221; // 播放引擎
const MOCK_SRC_PORT = 58222; // 音源
const APP_PORT = 58220;
const RUN_DIR = path.join(__dirname, '.run-queue-top');
const PIN = '2468';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 300, label = '条件' } = {}) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error(`${label} 超时（${timeout}ms）${lastErr ? '：' + lastErr.message : ''}`);
}

const j = async (url, opt) => {
  const r = await fetch(url, opt);
  const raw = await r.text();
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    d = { raw };
  }
  if (!r.ok) {
    const e = new Error(d.error || `HTTP ${r.status}`);
    e.status = r.status;
    e.body = d;
    throw e;
  }
  return d;
};
const post = (url, body) =>
  j(`http://127.0.0.1:${APP_PORT}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
const postSoft = async (url, body) => {
  try {
    return { ok: true, status: 200, data: await post(url, body) };
  } catch (e) {
    return { ok: false, status: e.status, data: e.body || { error: e.message } };
  }
};
const get = (p) => j(`http://127.0.0.1:${APP_PORT}${p}`);

const procs = {};
const logs = {};
function start(name, file, env) {
  const p = spawn(NODE, [path.join(__dirname, file)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const bucket = logs[name] || (logs[name] = []);
  p.stdout.on('data', (d) => bucket.push(d.toString()));
  p.stderr.on('data', (d) => bucket.push(d.toString()));
  procs[name] = p;
  return p;
}
async function cleanup() {
  for (const p of Object.values(procs)) {
    if (p && !p.killed) {
      try {
        p.kill();
      } catch {}
    }
  }
  await sleep(500);
}

/** 队列快照：qid + 名字，方便断言"只往前一位" */
async function queueNames() {
  const st = await get('/api/state');
  return st.queue.map((q) => `${q.rank === undefined ? '' : ''}${q.name}`);
}

async function main() {
  console.log('\n===== 队列点赞前挪（need=3）+ 删除下线 =====\n');

  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DIR, 'music'), { recursive: true });
  fs.mkdirSync(path.join(RUN_DIR, 'data'), { recursive: true });
  const cfgPath = path.join(RUN_DIR, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: APP_PORT,
    publicBase: `http://127.0.0.1:${APP_PORT}`,
    musicDir: path.join(RUN_DIR, 'music'),
    dataDir: path.join(RUN_DIR, 'data'),
    engine: {
      type: 'songloft',
      base: `http://127.0.0.1:${MOCK_PORT}`,
      prefix: '/api/v1/jsplugin/miot',
      username: 'admin',
      password: 'mock-pass',
    },
    gdApi: `http://127.0.0.1:${MOCK_SRC_PORT}/`,
    searchSources: ['netease'],
    sources: ['netease'],
    adminPin: PIN,
    queueTopNeed: 3,
    retry: 1,
    volume: 15,
    pollIntervalMs: 800,
    minPlaySec: 0,
    overtimeGraceSec: 600, // 别让测试中途自己切歌
    prefetchCount: 0,
    logLevel: 'info',
  }, null, 2));

  console.log('[1/5] 起 mock + 点歌台…');
  start('mock', 'mock-songloft.js', { MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '600', MOCK_SPEED: '1' });
  start('src', 'mock-source.js', { MOCK_SRC_PORT: String(MOCK_SRC_PORT) });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`)).ok, { label: 'mock 引擎', timeout: 12000 });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_SRC_PORT}/?types=search&name=x&count=1`)).ok, { label: 'mock 音源', timeout: 12000 });
  start('app', '../server.js', { JB_CONFIG: cfgPath, JB_PORT: String(APP_PORT) });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)).ok, { label: '点歌台就绪', timeout: 20000 });
  check('环境就绪', true, `:${APP_PORT}`);

  // ---------- 三个人（票要"不同的人"） ----------
  const people = [
    { id: 'qt-a', nick: '点赞甲' },
    { id: 'qt-b', nick: '点赞乙' },
    { id: 'qt-c', nick: '点赞丙' },
  ];
  for (const p of people) {
    await post('/api/nick/claim', { clientId: p.id, nick: p.nick });
    await post('/api/live', { clientId: p.id, nick: p.nick });
  }
  const st0 = await get('/api/state');
  check('三个人都在线（投票按人算）', st0.online === 3, `在线 ${st0.online}`);
  check('state 下发 queueTopNeed=3（"超过 2 名"= 3 个人）', st0.queueTopNeed === 3, `need=${st0.queueTopNeed}`);

  // ---------- 造队列：1 首在播 + 4 首待播（mock 音源池就 5 首） ----------
  const found = await get('/api/search?q=' + encodeURIComponent('测试'));
  const songs = (found.results || []).slice(0, 6);
  if (!songs.length) throw new Error('搜索没结果，测不了');
  for (let i = 0; i < songs.length; i++) {
    await post('/api/enqueue', { song: songs[i], requester: people[i % 3].nick });
  }
  await waitFor(async () => {
    const st = await get('/api/state');
    return st.current && st.current.status === 'playing' && st.queue.length >= 4 ? st : null;
  }, { label: '第一首起播 + 队列 4 首', timeout: 25000 });
  const st1 = await get('/api/state');
  const names = st1.queue.map((q) => q.name);
  check('队列 4 首都在（不含正在播的那首）', names.length === 4, names.join(' / '));
  check('每首都带 👍 票数（初始 0）',
    st1.queue.every((q) => q.tops && q.tops.votes === 0 && Array.isArray(q.tops.voters)), 'votes=0');

  const target = st1.queue[3]; // 第 4 位：要验证"只往前一位"，不是飞到最前
  console.log(`  目标曲目：《${target.name}》 现在第 4 位`);

  // ---------- ① 门槛：一个人 / 两个人都不够 ----------
  console.log('\n[2/5] ① 点赞门槛');
  const noCid = await postSoft('/api/top', { qid: target.qid });
  check('不带 clientId → 400（认不出人就不给票）', noCid.status === 400, `HTTP ${noCid.status} / ${noCid.data.error}`);

  const ghost = await postSoft('/api/top', { qid: target.qid, clientId: 'qt-ghost' });
  check('没起过昵称的 clientId → 403（防一个人开几个标签页刷票）',
    ghost.status === 403, `HTTP ${ghost.status} / ${ghost.data.error}`);

  const v1 = await post('/api/top', { qid: target.qid, clientId: people[0].id });
  check('第 1 个人点赞：不挪（1/3）', v1.voted === true && v1.moved === false && v1.votes === 1,
    `votes=${v1.votes}/${v1.need}, moved=${v1.moved}`);
  const qAfter1 = (await get('/api/state')).queue;
  check('第 1 票后位置没变（还是第 4 位）',
    qAfter1.findIndex((q) => q.qid === target.qid) === 3,
    `现在第 ${qAfter1.findIndex((q) => q.qid === target.qid) + 1} 位`);

  const v2 = await post('/api/top', { qid: target.qid, clientId: people[1].id });
  check('★ 第 2 个人点赞：还是不挪（"超过 2 名"才算，2 票不够）',
    v2.moved === false && v2.votes === 2, `votes=${v2.votes}/${v2.need}, moved=${v2.moved}`);

  const undo = await post('/api/top', { qid: target.qid, clientId: people[1].id });
  check('同一个人再点 = 撤票（2 → 1）', undo.voted === false && undo.votes === 1 && undo.moved === false,
    `votes=${undo.votes}, voted=${undo.voted}`);

  // ---------- ② 凑够 3 个不同的人 → 只前进一步 ----------
  console.log('\n[3/5] ② 凑够 3 人：只往前挪一位');
  const v2b = await post('/api/top', { qid: target.qid, clientId: people[1].id });
  check('（补回第 2 票）', v2b.votes === 2 && v2b.moved === false, `votes=${v2b.votes}`);
  const v3 = await post('/api/top', { qid: target.qid, clientId: people[2].id });
  check('★ 第 3 个人点赞 → 挪一位（不是飞到最前）',
    v3.moved === true && v3.votes === 0 && v3.index === 2,
    `moved=${v3.moved}, index=${v3.index}（0 基）, votes=${v3.votes}`);
  const qAfter3 = (await get('/api/state')).queue;
  const newIdx = qAfter3.findIndex((q) => q.qid === target.qid);
  check('★ 位置从第 4 位 → 第 3 位（只前进一位）', newIdx === 2, `现在第 ${newIdx + 1} 位`);
  check('★ 名字顺序真的换了（它上面那首被挤下去）',
    qAfter3[2].qid === target.qid && qAfter3[3].name === names[2],
    qAfter3.map((q) => q.name).join(' / '));
  check('★ 挪完票清零（要再攒 3 个人才能再挪）',
    qAfter3[2].tops.votes === 0 && qAfter3[2].tops.voters.length === 0,
    `votes=${qAfter3[2].tops.votes}`);

  // ---------- ③ 已经在第 1 位 ----------
  console.log('\n[4/5] ③ 已经最前面的不挪');
  const first = (await get('/api/state')).queue[0];
  for (const p of people) await post('/api/top', { qid: first.qid, clientId: p.id });
  const stFirst = await get('/api/state');
  check('第 1 位凑够 3 票也不动（first=true，不会绕到队尾/越界）',
    stFirst.queue[0].qid === first.qid, `队首仍是《${stFirst.queue[0].name}》`);

  // ---------- ④ 删除功能下线 ----------
  console.log('\n[5/5] ④ 删除列表歌曲：页面没按钮，接口要口令');
  const page = await fetch(`http://127.0.0.1:${APP_PORT}/`).then((r) => r.text());
  check('★ 页面里没有"删除队列歌曲"按钮（data-del 已移除）', !page.includes('data-del'), '没有 data-del');
  check('★ 页面里没有 /api/remove 的调用', !page.includes('/api/remove'), '前端不再调这个接口');

  const delNoPin = await postSoft('/api/remove', { qid: target.qid });
  check('★ 不带口令删歌 → 403（普通人删不了别人的歌）',
    delNoPin.status === 403 && !delNoPin.data.ok, `HTTP ${delNoPin.status} / ${delNoPin.data.error}`);
  const stillThere = (await get('/api/state')).queue.some((q) => q.qid === target.qid);
  check('被拒后歌还在队列里', stillThere === true);

  const delOk = await postSoft('/api/remove', { qid: target.qid, pin: PIN });
  check('带对管理员口令仍可删（排障/脚本留的口子）', delOk.ok === true && delOk.data.ok === true,
    JSON.stringify(delOk.data).slice(0, 80));
  const gone = (await get('/api/state')).queue.some((q) => q.qid === target.qid);
  check('删完队列里就没有它了', gone === false);

  // ---------- 汇总 ----------
  await cleanup();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====\n`);
  if (pass !== results.length) {
    console.log('失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ❌ ${r.name}  — ${r.detail}`));
    console.log('\n---- 服务端日志尾部 ----');
    console.log((logs.app || []).join('').split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error('\n测试异常：', e.message);
  await cleanup();
  process.exit(1);
});

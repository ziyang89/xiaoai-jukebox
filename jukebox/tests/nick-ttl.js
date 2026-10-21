'use strict';
/**
 * 「昵称占用 TTL（自动释放）」端到端测试
 * ------------------------------------------------------------
 * 要解决的真实问题：clientId 存在浏览器 localStorage 里 —— 一旦清了浏览器数据、
 * 换手机或换浏览器，那个人就换了新 clientId，**旧昵称会永久锁死**
 * （家庭场景比如「妈妈」换台设备就再也用不了这个名字）。
 *
 * 所以给昵称占用加了有效期（nickTtlSec，默认 7 天）：原主人在期限内出现过
 * （心跳/发言/点歌都算）就续期；超期没人用 → 视为弃用，别人可以认领。
 *
 * 本测试把 TTL 压到 3 秒来验证这些行为：
 *   ① 没过期 → 别人抢不走（409）；过期后 → 可以认领
 *   ② 原主人持续心跳 → 一直续期，别人始终抢不走
 *   ③ nickTtlSec=0 → 永不过期（退回旧行为）
 *   ④ 落盘 v2 格式（带 lastSeen）；过期的条目不落盘
 *   ⑤ 兼容读旧的 v1 格式（裸 clientId 字符串）→ 当作"刚刚还在用"，不误抢
 *   ⑥ /api/state 与 /api/nick/check 暴露 TTL 信息（前端文案用）
 *   ⑦ 管理员可立刻释放某个昵称（TTL 要等好几天，这是换设备时的自救口子）
 *
 * 用法：node tests/nick-ttl.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const APP_PORT = 58184;
const MOCK_PORT = 58083;
const MOCK_SRC_PORT = 58082;
const RUN_DIR = path.join(__dirname, '.run-nickttl');
const MUSIC_DIR = path.join(RUN_DIR, 'music');
const DATA_DIR = path.join(RUN_DIR, 'data');
const NICK_FILE = path.join(DATA_DIR, 'nicks.json');
const CFG_FILE = path.join(RUN_DIR, 'config.json');

/** 测试用 TTL：3 秒（不然等不起 7 天） */
const TTL_SEC = 3;
/** 等过期时留点余量，免得卡在边界上 */
const PAST_TTL = (TTL_SEC + 1.5) * 1000;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, interval = 250, label = '条件' } = {}) {
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

/** 需要看状态码的请求（409/403/404 这类"应该被拒"的用例） */
async function postRaw(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data: d };
}

const state = () => j(`${APP}/api/state`);
const live = (clientId, nick) => post(`${APP}/api/live`, { clientId, nick });
const claim = (clientId, nick) => postRaw(`${APP}/api/nick/claim`, { clientId, nick });
const nickCheck = (nick, clientId) =>
  j(`${APP}/api/nick/check?nick=${encodeURIComponent(nick)}&clientId=${encodeURIComponent(clientId || '')}`);

const A = 'ttl-a';
const B = 'ttl-b';
const C = 'ttl-c';

let mockProc = null;
let srcProc = null;
let appProc = null;
const appLog = [];

function writeCfg(ttlSec) {
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
    searchSources: ['netease'],
    sources: ['netease'],
    gdApi: `http://127.0.0.1:${MOCK_SRC_PORT}/`,
    retry: 1,
    volume: 0,
    pollIntervalMs: 2000,
    minPlaySec: 0,
    overtimeGraceSec: 600,
    prefetchCount: 0,
    maxTries: 2,
    onlineWindowMs: 5000,
    chatMinGapMs: 100,
    chatMaxLen: 50,
    nickMaxLen: 12,
    nickTtlSec: ttlSec,
    skipVoteEnabled: true,
    logLevel: 'info',
  };
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
}

async function killApp() {
  if (appProc && !appProc.killed) {
    try {
      appProc.kill();
    } catch {
      /* ignore */
    }
  }
  appProc = null;
  await sleep(600);
}

async function startApp() {
  appProc = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, JB_CONFIG: CFG_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appProc.stdout.on('data', (d) => appLog.push(d.toString()));
  appProc.stderr.on('data', (d) => appLog.push(d.toString()));
  await waitFor(async () => (await j(`${APP}/api/health`)).ok, { label: '点歌台就绪', timeout: 20000 });
}

async function cleanup() {
  for (const p of [appProc, mockProc, srcProc]) {
    if (p && !p.killed) {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }
  }
  await sleep(400);
}

const readNickFile = () => JSON.parse(fs.readFileSync(NICK_FILE, 'utf8'));

async function main() {
  console.log('\n===== 昵称占用 TTL（自动释放）端到端测试 =====');
  console.log(`     TTL = ${TTL_SEC}s（测试里压到秒级，线上默认 7 天）\n`);

  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeCfg(TTL_SEC);

  mockProc = spawn(NODE, [path.join(__dirname, 'mock-songloft.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '600', MOCK_SPEED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srcProc = spawn(NODE, [path.join(__dirname, 'mock-source.js')], {
    env: { ...process.env, MOCK_SRC_PORT: String(MOCK_SRC_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`)).ok, {
    label: 'mock 引擎就绪',
    timeout: 10000,
  });

  await startApp();
  check('mock 引擎 + 点歌台 已启动', true, `:${MOCK_PORT} / :${APP_PORT}`);

  // ============================================================ ① 过期前抢不走 / 过期后可认领
  console.log('\n--- ① 过期前抢不走，过期后可认领 ---');
  const st0 = await state();
  check('state 暴露 nickTtlSec（原始秒数，0 = 永不过期）',
    st0.nickTtlSec === TTL_SEC, `nickTtlSec=${st0.nickTtlSec} nickCount=${st0.nickCount}`);

  const a1 = await claim(A, '妈妈');
  check('A 占名「妈妈」成功', a1.ok && a1.data.nick === '妈妈', `HTTP ${a1.status}`);

  const b1 = await claim(B, '妈妈');
  check('TTL 内别人抢 → 409', b1.status === 409 && b1.data.taken === true, `HTTP ${b1.status}`);

  const ck1 = await nickCheck('妈妈', B);
  check('查重返回"还有多久自动释放"（releasesInSec > 0）',
    ck1.taken === true && ck1.releasesInSec > 0, `taken=${ck1.taken} releasesInSec=${ck1.releasesInSec}`);

  const st1 = await state();
  check('state.nickCount 统计到被占的昵称', st1.nickCount === 1, `nickCount=${st1.nickCount}`);

  console.log(`     等 ${Math.round(PAST_TTL / 1000)} 秒让占用过期（期间不做任何心跳）…`);
  await sleep(PAST_TTL);

  const ck2 = await nickCheck('妈妈', B);
  check('过期后查重 → 不再算被占（taken=false）', ck2.taken === false, `taken=${ck2.taken}`);

  const b2 = await claim(B, '妈妈');
  check('过期后别人可以直接认领', b2.ok && b2.data.nick === '妈妈', `HTTP ${b2.status}`);

  const a2 = await claim(A, '妈妈');
  check('原主人回来时名字已经不属于他了 → 409', a2.status === 409, `HTTP ${a2.status}`);

  // ============================================================ ② 持续心跳 → 一直续期
  console.log('\n--- ② 原主人持续出现 → 一直续期 ---');
  const a3 = await claim(A, '爸爸');
  check('A 占名「爸爸」成功', a3.ok, `nick=${a3.data.nick}`);

  console.log(`     保持心跳 ${Math.round((TTL_SEC * 2 + 1) * 1000 / 1000)} 秒（远超 TTL=${TTL_SEC}s）…`);
  const beats = Math.ceil((TTL_SEC * 2 + 1) * 1000 / 800);
  for (let i = 0; i < beats; i++) {
    await live(A, '爸爸');
    await sleep(800);
  }

  const b3 = await claim(B, '爸爸');
  check('期间别人始终抢不走（每次心跳都在续期）', b3.status === 409, `HTTP ${b3.status}`);

  console.log('     停止心跳，再等一个 TTL…');
  await sleep(PAST_TTL);
  const b4 = await claim(B, '爸爸');
  check('停止露面超过 TTL → 可以被认领', b4.ok, `HTTP ${b4.status}`);

  // ============================================================ ③ 落盘格式
  console.log('\n--- ③ 落盘格式（v2，带 lastSeen） ---');
  await claim(A, '落盘测试');
  await sleep(900); // 等防抖落盘（400ms）
  const f1 = readNickFile();
  const item = (f1.nicks || {})['落盘测试'];
  check('文件版本是 v2', f1.version === 2, `version=${f1.version}`);
  check('条目存的是 {clientId, lastSeen} 而不是裸字符串',
    !!item && typeof item === 'object' && !!item.clientId && typeof item.lastSeen === 'number',
    JSON.stringify(item));
  check('lastSeen 是最近的时刻',
    item && Math.abs(Date.now() - item.lastSeen) < 60000, item ? new Date(item.lastSeen).toLocaleTimeString('zh-CN') : '-');

  // ============================================================ ④ 重启后载入 / 兼容 v1 / 丢弃过期
  console.log('\n--- ④ 重启：兼容 v1 旧格式 + 丢弃已过期 ---');
  await killApp();
  fs.writeFileSync(
    NICK_FILE,
    JSON.stringify({
      version: 2,
      nicks: {
        // v1 时代的旧格式：值是裸 clientId 字符串
        老式名字: 'legacy-client',
        // v2 且刚刚还在用
        刚用过的: { clientId: 'recent-client', lastSeen: Date.now() - 1000 },
        // v2 但早就过期了（远超过 3s）
        很久没用的: { clientId: 'stale-client', lastSeen: Date.now() - 600000 },
      },
    }),
    'utf8'
  );
  await startApp();

  const lv1 = await claim(B, '老式名字');
  check('v1 旧格式条目不会被误判过期（当作"刚刚还在用"）', lv1.status === 409, `HTTP ${lv1.status}`);

  const lv2 = await claim(B, '刚用过的');
  check('v2 未过期条目仍被占', lv2.status === 409, `HTTP ${lv2.status}`);

  const startLog = appLog.join('');
  check('启动日志里能看到"丢弃 N 个已过期的昵称占用"', /丢弃 1 个已过期的昵称占用/.test(startLog),
    (startLog.match(/昵称占用[^\n]*/g) || []).slice(0, 3).join(' | '));

  // 触发一次落盘：被拒的操作（409）不会写盘，得有个成功的变动才看得出文件长什么样
  await claim(C, '触发落盘');
  await sleep(900);
  const f2 = readNickFile();
  check('落盘时不会把已过期的条目写回去',
    !('很久没用的' in (f2.nicks || {})), Object.keys(f2.nicks || {}).join('、'));
  check('未过期的条目照常保留',
    '老式名字' in (f2.nicks || {}) && '刚用过的' in (f2.nicks || {}),
    Object.keys(f2.nicks || {}).join('、'));

  const lv3 = await claim(B, '很久没用的');
  check('v2 已过期条目在启动时就被丢弃 → 可以认领', lv3.ok, `HTTP ${lv3.status}`);

  // ============================================================ ⑤ 管理员立刻释放
  console.log('\n--- ⑤ 管理员立刻释放昵称（换设备自救） ---');
  const noPin = await postRaw(`${APP}/api/admin/nicks`, {});
  check('没设口令时 → 拒绝（403，并提示去设置）',
    noPin.status === 403 && /还没设/.test(noPin.data.error || ''),
    `HTTP ${noPin.status} ${noPin.data.error || ''}`);

  await post(`${APP}/api/admin/setup`, { pin: '9527' });
  const badPin = await postRaw(`${APP}/api/admin/nicks`, { pin: '0000' });
  check('口令不对 → 403', badPin.status === 403, `HTTP ${badPin.status}`);

  await claim(A, '要释放的名字');
  const list = await post(`${APP}/api/admin/nicks`, { pin: '9527' });
  const row = (list.nicks || []).find((n) => n.nick === '要释放的名字');
  check('管理员能看到昵称占用列表（含闲置时长/自动释放倒计时）',
    !!row && typeof row.idleDays === 'number' && typeof row.releasesInSec === 'number',
    JSON.stringify(row));

  const rel404 = await postRaw(`${APP}/api/admin/nick/release`, { pin: '9527', nick: '没占用的名字' });
  check('释放一个没人占的昵称 → 404', rel404.status === 404, `HTTP ${rel404.status}`);

  await live(A, '要释放的名字'); // A 先上线，验证"被释放的人会被摘掉"
  const rel = await post(`${APP}/api/admin/nick/release`, { pin: '9527', nick: '要释放的名字' });
  check('管理员释放成功', rel.ok && rel.nick === '要释放的名字', `剩余占用 ${rel.nickCount} 个`);

  const b5 = await claim(B, '要释放的名字');
  check('释放后别人可以立刻认领', b5.ok, `HTTP ${b5.status}`);

  const aLive = await live(A, '要释放的名字');
  check('被释放的人下次心跳 → 被告知要重新起名（needNick=true）',
    aLive.needNick === true, `needNick=${aLive.needNick}`);

  // 造一个"已过期但没人认领"的占用 → 它不该出现在管理列表里
  // （放在最后做：等过期期间不会波及其他用例）
  await claim(C, '过期未认领');
  await sleep(PAST_TTL);
  const list2 = await post(`${APP}/api/admin/nicks`, { pin: '9527' });
  check('管理列表里不含已过期的条目',
    !(list2.nicks || []).some((n) => n.nick === '过期未认领'),
    (list2.nicks || []).map((n) => n.nick).join('、'));
  check('管理接口回报的 ttlSec 与配置一致', list2.ttlSec === TTL_SEC, `ttlSec=${list2.ttlSec}`);

  // ============================================================ ⑥ TTL = 0 → 永不过期
  console.log('\n--- ⑥ nickTtlSec=0 → 永不过期（退回旧行为） ---');
  await killApp();
  writeCfg(0);
  fs.rmSync(NICK_FILE, { force: true });
  await startApp();

  const st2 = await state();
  check('state.nickTtlSec = 0（表示永不过期）', st2.nickTtlSec === 0, `nickTtlSec=${st2.nickTtlSec}`);

  await claim(A, '永不释放');
  await sleep(PAST_TTL);
  const b6 = await claim(B, '永不释放');
  check('超过原 TTL 时长后仍然抢不走', b6.status === 409, `HTTP ${b6.status}`);

  const ck3 = await nickCheck('永不释放', B);
  check('查重时不显示自动释放倒计时（releasesInSec=0）',
    ck3.taken === true && ck3.releasesInSec === 0, `taken=${ck3.taken} releasesInSec=${ck3.releasesInSec}`);

  // ============================================================
  await cleanup();

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n===== 结果：${pass}/${results.length} 通过 =====`);
  if (fail) {
    console.log('失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log('  - ' + r.name + (r.detail ? '  — ' + r.detail : '')));
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\n测试自身异常：', e);
  await cleanup();
  process.exit(2);
});

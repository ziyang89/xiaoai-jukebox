'use strict';
/**
 * 回归测试：音源限流时，点的歌**不能凭空消失**
 * ------------------------------------------------------------
 * 用户报的 bug：「加了歌曲，队列还是空的」。
 * 真因：GD Studio 挂在 Cloudflare 后，密集请求必被 503 → 进入冷却；
 * 老逻辑把冷却当成"永久失败"，曲目一入队就被取走、下载失败、直接从队列
 * 抹掉，界面上只剩一个空队列。
 *
 * 本测试用 mock 音源注入 503 故障窗口，断言：
 *   ① 限流期间点歌，曲目**必须留在队列里**（而不是消失）
 *   ② 接口要给出可见提示（notice / cooldownLeftSec / retryInSec）
 *   ③ 冷却结束后**自动重试成功**，不需要用户重新点
 *   ④ 不该在 history 里留下"失败"记录（因为根本没失败，只是要等）
 *
 * 用法：node tests/rate-limit.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const APP_PORT = 58190;
const MOCK_PORT = 58096;
const MOCK_SRC_PORT = 58095;
const RUN_DIR = path.join(__dirname, '.run-ratelimit');

const COOLDOWN_MS = 5000;
const FAULT_MS = 7000;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 400, label = '条件' } = {}) {
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

const APP = `http://127.0.0.1:${APP_PORT}`;
const SRC = `http://127.0.0.1:${MOCK_SRC_PORT}`;

const j = async (url, opt) => {
  const r = await fetch(url, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
};
const post = (url, body) =>
  j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const state = () => j(`${APP}/api/state`);

const procs = [];
let appLog = '';

async function cleanup() {
  for (const p of procs) {
    if (p && !p.killed) {
      try {
        p.kill();
      } catch {}
    }
  }
  await sleep(400);
}

async function main() {
  console.log('\n===== 回归测试：音源限流不丢歌 =====\n');
  console.log(`（冷却 ${COOLDOWN_MS}ms，故障窗口 ${FAULT_MS}ms，均为测试压缩值）\n`);

  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DIR, 'music'), { recursive: true });
  fs.mkdirSync(path.join(RUN_DIR, 'data'), { recursive: true });

  const cfg = {
    port: APP_PORT,
    publicBase: APP,
    musicDir: path.join(RUN_DIR, 'music'),
    dataDir: path.join(RUN_DIR, 'data'),
    engine: {
      type: 'songloft',
      base: `http://127.0.0.1:${MOCK_PORT}`,
      prefix: '/api/v1/jsplugin/miot',
      username: 'admin',
      password: 'mock-pass',
    },
    searchSources: ['netease'],
    sources: ['netease'],
    gdApi: `${SRC}/`,
    retry: 2,
    volume: 15,
    pollIntervalMs: 600,
    minPlaySec: 0,
    overtimeGraceSec: 5,
    prefetchCount: 1,
    rateCooldownMs: COOLDOWN_MS,
    maxTries: 4,
    logLevel: 'info',
  };
  const cfgPath = path.join(RUN_DIR, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  console.log('[1/5] 启动 mock 播放引擎 / 音源 / 点歌台…');
  const mk = (args, env) =>
    spawn(NODE, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });

  const engine = mk([path.join(__dirname, 'mock-songloft.js')], {
    MOCK_PORT: String(MOCK_PORT),
    MOCK_DURATION: '20',
    MOCK_SPEED: '8',
  });
  procs.push(engine);
  const src = mk([path.join(__dirname, 'mock-source.js')], { MOCK_SRC_PORT: String(MOCK_SRC_PORT) });
  procs.push(src);

  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`)).ok, { label: 'mock 引擎就绪', timeout: 10000 });
  await waitFor(async () => (await fetch(`${SRC}/?types=search&name=x&count=1`)).ok, { label: 'mock 音源就绪', timeout: 10000 });

  const app = mk([path.join(ROOT, 'server.js')], { JB_CONFIG: cfgPath });
  procs.push(app);
  app.stdout.on('data', (d) => (appLog += d.toString()));
  app.stderr.on('data', (d) => (appLog += d.toString()));

  await waitFor(async () => (await j(`${APP}/api/health`)).ok, { label: '点歌台就绪', timeout: 20000 });
  await waitFor(async () => (await state()).engineOk, { label: '引擎握手', timeout: 15000 });
  check('三个服务全部就绪', true, `app:${APP_PORT} engine:${MOCK_PORT} src:${MOCK_SRC_PORT}`);

  // ---------- 搜索（趁故障窗口还没开）----------
  console.log('\n[2/5] 搜索取歌…');
  const s = await j(`${APP}/api/search?q=` + encodeURIComponent('晴天'));
  const song = (s.results || [])[0];
  check('搜索到曲目', !!song, song ? `《${song.name}》- ${song.artist}` : '无结果');
  if (!song) return;

  // ---------- 打开故障窗口：所有取直链请求 503 ----------
  console.log('\n[3/5] 开启音源限流窗口（取直链一律 503）…');
  await post(`${SRC}/__fault`, { url503Ms: FAULT_MS });
  const f = await j(`${SRC}/__fault`);
  check('故障窗口已开启', f.url503 === true, `剩余 ${f.leftMs}ms`);

  // ---------- 限流期间点歌 ----------
  console.log('\n[4/5] 限流期间点歌，检查曲目是否被"秒杀"…');
  await post(`${APP}/api/enqueue`, { song, requester: '回家测' });

  // 给它一段时间去撞限流（预热/起播都会失败）
  await sleep(2600);
  const st1 = await state();
  const inQueue = st1.queue.some((q) => q.name === song.name);
  check('★ 曲目仍在队列里（没有被丢掉）', inQueue, `队列 ${st1.queue.length} 首：${st1.queue.map((q) => q.name).join(' / ') || '空'}`);
  check('当前曲目为空（还没能播）', st1.current === null, st1.current ? st1.current.name : '');
  check('给出了可见提示 notice', !!st1.notice && /限流|重试|冷却/.test(st1.notice.text || ''), st1.notice ? st1.notice.text : '无');
  check('暴露冷却剩余时间给前端', st1.cooldownLeftSec > 0, `cooldownLeftSec=${st1.cooldownLeftSec}`);
  check('暴露自动重试倒计时', st1.retryInSec > 0, `retryInSec=${st1.retryInSec}`);
  check('没有往历史里写入"失败"', !st1.history.some((h) => h.name === song.name && /失败/.test(h.reason || '')), JSON.stringify(st1.history.slice(0, 2)));

  // ---------- 等自动重试 ----------
  console.log('\n[5/5] 等冷却结束，看是否自动重试成功…');
  let played = null;
  try {
    played = await waitFor(
      async () => {
        const st = await state();
        return st.current && st.current.status === 'playing' && st.current.name === song.name ? st : null;
      },
      { label: '自动重试后起播', timeout: 40000, interval: 700 }
    );
    check('★ 冷却结束后自动重试成功', true, `《${played.current.name}》`);
    check('重试成功后清掉了提示', played.notice === null, played.notice ? played.notice.text : '');
    check('队列已消费完', played.queue.length === 0, `剩 ${played.queue.length}`);
  } catch (e) {
    check('★ 冷却结束后自动重试成功', false, e.message);
  }
}

main()
  .catch((e) => {
    console.error('\n💥 测试异常终止：', e.message);
    results.push({ name: '测试流程完整执行', ok: false, detail: e.message });
  })
  .finally(async () => {
    await cleanup();
    const pass = results.filter((r) => r.ok).length;
    const total = results.length;
    console.log('\n══════════════ 测试汇总 ══════════════');
    for (const r of results) console.log(` ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
    console.log(`\n 结果：${pass}/${total} 通过`);
    if (pass < total) {
      console.log('\n----- 点歌台日志（末 45 行）-----');
      console.log(appLog.split('\n').slice(-45).join('\n'));
    }
    console.log('');
    process.exit(pass === total ? 0 : 1);
  });

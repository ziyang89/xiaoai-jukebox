'use strict';
/**
 * QQ 自建音源端到端测试（离线，不碰外网）
 * ------------------------------------------------------------
 * 验的是"接进来之后整条链路还在不在"，不是"QQ 今天的接口通不通"
 * （那是 tests/probe-qq.js / probe-qq-deep.js 的活，需要真 key + 外网）。
 *
 * 覆盖：
 *   ① 凭据：管理员热写入（不重启即生效）；state 只给脱敏 QQ 号，key 一个字都不许出现
 *   ② 搜索：QQ 优先，够 3 条就不再打扰 GD（GD 请求数必须为 0）
 *   ③ 签名：mock 用同一份算法复算，对不上就拒（badSign 必须为 0）
 *   ④ 播放：点歌 → QQ 取链 → 下载落 NAS 曲库 → 推流
 *   ⑤ 降级：320k 拿不到时自动退 128k
 *   ⑥ 兜底：QQ 彻底没链时回落 netease，歌不能丢
 *   ⑦ 管理员接口：自测 / 改档位 / 清除；错口令 403
 *
 * 用法：node tests/qq-source.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const MOCK_PORT = 58099; // 播放引擎
const MOCK_SRC_PORT = 58098; // GD 音源
const MOCK_QQ_PORT = 58097; // QQ 接口
const APP_PORT = 58192;
const RUN_DIR = path.join(__dirname, '.run-qq');
const PIN = '2468';
const QQ_KEY = 'Q_H_L_TESTKEY_0123456789abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789';
const QQ_UIN = '100200300';

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
  j(url.startsWith('http') ? url : `http://127.0.0.1:${APP_PORT}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
const get = (p) => j(`http://127.0.0.1:${APP_PORT}${p}`);
const getJson = async (url) => (await fetch(url)).json();

const procs = {};
const logs = { mock: [], src: [], qq: [], app: [] };

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

async function main() {
  console.log('\n===== QQ 自建音源端到端测试 =====\n');

  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DIR, 'music'), { recursive: true });
  fs.mkdirSync(path.join(RUN_DIR, 'data'), { recursive: true });

  // ⚠️ 配置里故意**不写** QQ 凭据：先证明"没配也能跑"，再走管理员接口热写入
  const cfg = {
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
      deviceId: 'mock-device',
    },
    gdApi: `http://127.0.0.1:${MOCK_SRC_PORT}/`,
    // ⚠️ 故意写成"老配置"只有 netease：验证代码会把已配置的 qq 自动排到最前
    searchSources: ['netease'],
    sources: ['netease'],
    searchEnough: 3,
    adminPin: PIN,
    retry: 2,
    volume: 15,
    pollIntervalMs: 700,
    minPlaySec: 0,
    overtimeGraceSec: 5,
    prefetchCount: 0,
    logLevel: 'info',
  };
  const cfgPath = path.join(RUN_DIR, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // ---------- ① 起 mock
  console.log('[1/7] 启动 mock（播放引擎 / GD 音源 / QQ 接口）…');
  start('mock', 'mock-songloft.js', { MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '20', MOCK_SPEED: '8' });
  start('src', 'mock-source.js', { MOCK_SRC_PORT: String(MOCK_SRC_PORT) });
  start('qq', 'mock-qq.js', { MOCK_QQ_PORT: String(MOCK_QQ_PORT) });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`)).ok, { label: '播放引擎 mock', timeout: 12000 });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_SRC_PORT}/?types=search&name=x&count=1`)).ok, {
    label: 'GD mock',
    timeout: 12000,
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_QQ_PORT}/__stats`)).ok, { label: 'QQ mock', timeout: 12000 });
  check('三个 mock 都起来了', true, `:${MOCK_PORT} / :${MOCK_SRC_PORT} / :${MOCK_QQ_PORT}`);

  // ---------- ② 起点歌台（未配 QQ）
  console.log('\n[2/7] 启动点歌台（尚未配置 QQ）…');
  start('app', '../server.js', { JB_CONFIG: cfgPath, JB_PORT: String(APP_PORT), JB_QQ_API: `http://127.0.0.1:${MOCK_QQ_PORT}` });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)).ok, { label: '点歌台就绪', timeout: 20000 });
  const st0 = await get('/api/state');
  check('启动后引擎就绪', st0.engineOk === true, `device=${st0.device?.name || '?'}`);
  check('没配 QQ 时 configured=false（不该崩）', st0.qq && st0.qq.configured === false);

  // ---------- ③ 凭据热写入
  console.log('\n[3/7] ① 凭据：管理员热写入');
  let denied = null;
  try {
    await post('/api/admin/qq', { pin: '0000', key: QQ_KEY, uin: QQ_UIN });
  } catch (e) {
    denied = e;
  }
  check('错口令被拒（403）', denied && denied.status === 403, `HTTP ${denied && denied.status}`);

  let badUin = null;
  try {
    await post('/api/admin/qq', { pin: PIN, uin: 'abc' });
  } catch (e) {
    badUin = e;
  }
  check('QQ 号格式不对被拒（400）', badUin && badUin.status === 400, badUin && badUin.body?.error);

  const set = await post('/api/admin/qq', { pin: PIN, key: QQ_KEY, uin: QQ_UIN, quality: '320k' });
  check('★ 写入后立刻自测通过（搜索/取链/CDN 全通）', set.test && set.test.ok === true,
    `${set.test?.song || ''} ${set.test?.quality} HTTP ${set.test?.http} ${set.test?.format} ${set.test?.ms}ms`);
  const st1 = await get('/api/state');
  check('热生效：不用重启 configured=true', st1.qq && st1.qq.configured === true);
  check('QQ 号已脱敏', st1.qq && st1.qq.uin === '100****00', `uin=${st1.qq && st1.qq.uin}`);
  const stRaw = JSON.stringify(st1) + JSON.stringify(set);
  check('★ key 不出现在任何接口响应里', !stRaw.includes(QQ_KEY) && !stRaw.includes('TESTKEY'));
  check('★ 老配置只写了 netease，也已自动把 qq 排到最前',
    Array.isArray(st1.searchSources) && st1.searchSources[0] === 'qq' && st1.searchSources.includes('netease'),
    JSON.stringify(st1.searchSources));
  check('取链链同样把 qq 排到最前', Array.isArray(st1.sources) && st1.sources[0] === 'qq', JSON.stringify(st1.sources));

  // ---------- ④ 搜索
  console.log('\n[4/7] ② 搜索优先走 QQ');
  await post(`http://127.0.0.1:${MOCK_SRC_PORT}/__stats`, { clear: true });
  await post(`http://127.0.0.1:${MOCK_QQ_PORT}/__stats`, { clear: true });
  const s1 = await get(`/api/search?q=${encodeURIComponent('晴天 周杰伦')}`);
  check('搜到结果', s1.count > 0, `${s1.count} 条`);
  check('结果来源是 qq', s1.results[0] && s1.results[0].source === 'qq', s1.results[0] && s1.results[0].source);
  check('结果带 mediaMid（取链必需）', !!(s1.results[0] && s1.results[0].mediaMid), s1.results[0] && s1.results[0].mediaMid);
  const gdStats = await getJson(`http://127.0.0.1:${MOCK_SRC_PORT}/__stats`);
  check('★ QQ 够 3 条时 GD 一次都没被请求', !gdStats.netease || gdStats.netease.search === 0, JSON.stringify(gdStats.netease || {}));
  const qqStats1 = await getJson(`http://127.0.0.1:${MOCK_QQ_PORT}/__stats`);
  check('★ 签名被 mock 复算通过（badSign=0）', qqStats1.badSign === 0, `search=${qqStats1.search} badSign=${qqStats1.badSign}`);

  // ---------- ⑤ 播放
  console.log('\n[5/7] ④ 播放链路');
  const pick = s1.results[0];
  await post('/api/enqueue', { song: pick, requester: '验收员Q' });
  // state.current 在**下载前**就被赋值了，所以必须等 status=playing 才算真的播上
  const playing = await waitFor(async () => {
    const s = await get('/api/state');
    return s.current && s.current.name === pick.name && s.current.status === 'playing' ? s : null;
  }, { label: '起播', timeout: 30000 });
  check('点歌后开始播放', true, `《${playing.current.name}》status=${playing.current.status}`);
  check('★ 下载日志显示来源是 qq', logs.app.join('').includes(`开始下载《${pick.name}》← qq`), '日志「开始下载《…》← qq」');

  const files = await waitFor(() => {
    const f = fs.readdirSync(path.join(RUN_DIR, 'music')).filter((x) => /\.(mp3|flac)$/i.test(x));
    return f.length ? f : null;
  }, { label: '音频落盘', timeout: 15000 });
  check('音频已落到 NAS 曲库', files.length > 0, files.join(', ').slice(0, 80));
  const qqStats2 = await getJson(`http://127.0.0.1:${MOCK_QQ_PORT}/__stats`);
  check('取链请求打到 QQ', qqStats2.vkey > 0, `vkey=${qqStats2.vkey} 文件=${(qqStats2.lastFiles || []).slice(-2).join(',')}`);
  check('会员凭据确实带上了（authst 非空）', !!qqStats2.lastAuthst && qqStats2.lastAuthst !== '…', qqStats2.lastAuthst);
  check('QQ 号随取链请求带上了', qqStats2.lastUin === QQ_UIN, qqStats2.lastUin);

  const diag = await get('/api/diag');
  check('/api/diag 给出音源现状', diag.sources && diag.sources.qq && diag.sources.qq.configured === true);

  // ---------- ⑥ 音质降级
  console.log('\n[6/7] ⑤ 音质降级（320k → 128k）');
  await post(`http://127.0.0.1:${MOCK_QQ_PORT}/__mode`, { denyQuality: ['320k'] });
  await post(`http://127.0.0.1:${MOCK_QQ_PORT}/__stats`, { clear: true });
  const s2 = await get(`/api/search?q=${encodeURIComponent('七里香 周杰伦')}`);
  const pick2 = s2.results.find((x) => x.source === 'qq') || s2.results[0];
  await post('/api/enqueue', { song: pick2, requester: '验收员Q' });
  await waitFor(async () => {
    const s = await get('/api/state');
    return s.current && s.current.name === pick2.name && s.current.status === 'playing';
  }, { label: '降级曲目起播', timeout: 30000 });
  const qqStats3 = await getJson(`http://127.0.0.1:${MOCK_QQ_PORT}/__stats`);
  const tried = (qqStats3.lastFiles || []).join(' ');
  check('★ 先试 320k 再退 128k', /M800/.test(tried) && /M500/.test(tried), tried || '无记录');
  check('降级后仍然播上了', true, `《${pick2.name}》`);

  // ---------- ⑦ QQ 无链 → 回落 GD
  console.log('\n[7/7] ⑥ QQ 无链时回落 GD');
  await post(`http://127.0.0.1:${MOCK_QQ_PORT}/__mode`, { clear: true, emptyPurl: true });
  await post(`http://127.0.0.1:${MOCK_SRC_PORT}/__stats`, { clear: true });
  const s3 = await get(`/api/search?q=${encodeURIComponent('稻香 周杰伦')}`);
  const pick3 = s3.results.find((x) => x.source === 'qq') || s3.results[0];
  await post('/api/enqueue', { song: pick3, requester: '验收员Q' });
  const fallback = await waitFor(async () => {
    const s = await get('/api/state');
    return s.current && s.current.name === pick3.name && s.current.status === 'playing' ? s : null;
  }, { label: '兜底起播', timeout: 40000 });
  check('★ QQ 没链时歌没丢，回落 GD 播上了', logs.app.join('').includes(`开始下载《${pick3.name}》← netease`), '日志显示来源 netease');
  const gd2 = await getJson(`http://127.0.0.1:${MOCK_SRC_PORT}/__stats`);
  check('真的问了 GD（netease 有请求）', gd2.netease && gd2.netease.search > 0, JSON.stringify(gd2.netease || {}));

  // ---------- ⑧ 凭据落盘位置 + 清除
  console.log('\n[补] ⑦ 凭据落盘与清除');
  await post(`http://127.0.0.1:${MOCK_QQ_PORT}/__mode`, { clear: true });
  const saved = await post('/api/admin/qq', { pin: PIN, quality: 'flac', test: false });
  check('改音质生效', saved.qq && saved.qq.quality === 'flac', saved.qq && saved.qq.quality);
  const rcFile = path.join(RUN_DIR, 'data', 'runtime-config.json');
  const rc = fs.existsSync(rcFile) ? JSON.parse(fs.readFileSync(rcFile, 'utf8')) : {};
  check('凭据落在数据卷的 runtime-config.json', !!(rc.qq && rc.qq.key === QQ_KEY && rc.qq.uin === QQ_UIN), rcFile);
  check('★ 没有写进 config.json（镜像/模板里不留凭据）', !fs.readFileSync(cfgPath, 'utf8').includes('TESTKEY'));

  const cleared = await post('/api/admin/qq', { pin: PIN, clear: true });
  check('可以清除凭据（回落 GD）', cleared.cleared === true && cleared.qq.configured === false, JSON.stringify(cleared.qq));
  const st2 = await get('/api/state');
  check('清除后 state 同步变回未配置', st2.qq && st2.qq.configured === false);
}

main()
  .then(async () => {
    await cleanup();
    const pass = results.filter((r) => r.ok).length;
    const fail = results.length - pass;
    console.log(`\n===== 结果：${pass}/${results.length} 通过${fail ? `，${fail} 失败` : '  🎉 全绿'} =====`);
    if (fail) {
      for (const r of results.filter((x) => !x.ok)) console.log(`  ❌ ${r.name}  ${r.detail}`);
      console.log('\n---- 最近日志 ----');
      for (const [k, arr] of Object.entries(logs)) {
        const text = arr.join('').split('\n').filter(Boolean).slice(-25).join('\n');
        if (text) console.log(`\n[${k}]\n${text}`);
      }
    }
    process.exit(fail ? 1 : 0);
  })
  .catch(async (e) => {
    console.error('\n测试异常：', e.message);
    await cleanup();
    for (const [k, arr] of Object.entries(logs)) {
      const text = arr.join('').split('\n').filter(Boolean).slice(-30).join('\n');
      if (text) console.log(`\n[${k}]\n${text}`);
    }
    process.exit(1);
  });

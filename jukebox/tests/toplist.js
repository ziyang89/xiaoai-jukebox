'use strict';
/**
 * 排行榜（QQ 榜单）端到端测试（离线，不碰外网）
 * ------------------------------------------------------------
 * 覆盖：
 *   ① 接口形状：榜单列表（分组）/ 某个榜的曲目 / 名次与字段
 *   ② 缓存：30 分钟内重复请求不再打 QQ；force=1 才强刷；脏参数被夹紧
 *   ③ 兜底：QQ 榜单接口报错时，有缓存就用缓存（stale），没缓存才报错
 *   ④ 点歌：榜单曲目能直接走 /api/enqueue → 取链 → 落 NAS → 起播（复用现有链路）
 *   ⑤ 权限：榜单接口不需要管理员口令；未配 QQ 的实例给出 503 引导
 *   ⑥ 落盘：<dataDir>/toplist.json 里有榜单与详情，重启可复用
 *
 * 用法：node tests/toplist.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const MOCK_PORT = 58211; // 播放引擎
const MOCK_SRC_PORT = 58212; // GD 音源（故意指死，证明榜单不依赖公共源）
const MOCK_QQ_PORT = 58213; // QQ 接口 mock
const APP_PORT = 58210;
const APP2_PORT = 58214; // 未配 QQ 的实例
const RUN_DIR = path.join(__dirname, '.run-toplist');
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
const get = (p, port = APP_PORT) => j(`http://127.0.0.1:${port}${p}`);
const getSoft = async (p, port = APP_PORT) => {
  try {
    return { ok: true, data: await get(p, port) };
  } catch (e) {
    return { ok: false, status: e.status, data: e.body || { error: e.message } };
  }
};
const qqStats = async () => (await fetch(`http://127.0.0.1:${MOCK_QQ_PORT}/__stats`)).json();
const qqMode = (b) =>
  fetch(`http://127.0.0.1:${MOCK_QQ_PORT}/__mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  }).then((r) => r.json());

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

function makeCfg(port, withQQ) {
  return {
    port,
    publicBase: `http://127.0.0.1:${port}`,
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
    // 只留 QQ：榜单故意不依赖公共源
    searchSources: withQQ ? ['qq'] : ['netease'],
    sources: withQQ ? ['qq'] : ['netease'],
    qq: withQQ ? { key: QQ_KEY, uin: QQ_UIN, quality: '320k' } : {},
    adminPin: PIN,
    toplistCount: 5,
    toplistTtlMin: 30,
    retry: 1,
    volume: 15,
    pollIntervalMs: 700,
    minPlaySec: 0,
    overtimeGraceSec: 5,
    prefetchCount: 0,
    logLevel: 'info',
  };
}

async function main() {
  console.log('\n===== 排行榜（QQ 榜单）端到端测试 =====\n');

  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DIR, 'music'), { recursive: true });
  fs.mkdirSync(path.join(RUN_DIR, 'data'), { recursive: true });

  const cfgPath = path.join(RUN_DIR, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(makeCfg(APP_PORT, true), null, 2));
  const cfg2Path = path.join(RUN_DIR, 'config-noqq.json');
  fs.writeFileSync(cfg2Path, JSON.stringify(makeCfg(APP2_PORT, false), null, 2));

  console.log('[1/6] 启动 mock…');
  start('mock', 'mock-songloft.js', { MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '30', MOCK_SPEED: '6' });
  start('qq', 'mock-qq.js', { MOCK_QQ_PORT: String(MOCK_QQ_PORT) });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`)).ok, { label: '播放引擎 mock', timeout: 12000 });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_QQ_PORT}/__stats`)).ok, { label: 'QQ mock', timeout: 12000 });
  check('播放引擎 + QQ mock 已启动', true, `:${MOCK_PORT} / :${MOCK_QQ_PORT}`);

  console.log('\n[2/6] 起点歌台（已配 QQ）…');
  start('app', '../server.js', { JB_CONFIG: cfgPath, JB_PORT: String(APP_PORT), JB_QQ_API: `http://127.0.0.1:${MOCK_QQ_PORT}` });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)).ok, { label: '点歌台就绪', timeout: 20000 });
  const st0 = await get('/api/state');
  check('引擎就绪、QQ 已配置', st0.engineOk === true && st0.qq && st0.qq.configured === true,
    `quality=${st0.qq && st0.qq.quality}`);

  // ---------- ① 榜单列表 ----------
  console.log('\n[3/6] ① 榜单列表 / 曲目形状');
  const lists = await get('/api/toplist');
  check('/api/toplist 不需要口令就能拿榜单列表',
    lists.ok === true && Array.isArray(lists.lists) && lists.lists.length === 30, `${lists.lists.length} 个榜`);
  check('榜单带 topId / title / 分组（前端按分组做 optgroup）',
    lists.lists.some((x) => x.topId === 26 && x.title === '热歌榜' && x.group === '巅峰榜'),
    JSON.stringify(lists.lists.slice(0, 3)));
  check('第一次拉列表是 cached=false', lists.cached === false, `cached=${lists.cached}`);

  const top = await get('/api/toplist?topId=26&n=5');
  check('取榜单曲目：给 5 首（n 生效）', top.ok === true && top.songs.length === 5, `${top.songs.length} 首`);
  check('带榜单标题 / 榜单日期 / 总数（前端显示"更新于"）',
    top.title === '热歌榜' && top.updateTime === '2026-10-21' && top.totalNum === 300,
    `${top.title} / ${top.updateTime} / total=${top.totalNum}`);
  const s0 = top.songs[0];
  check('曲目形状和搜索结果同构（mid/mediaMid/name/artist/duration）',
    !!s0.id && !!s0.mediaMid && !!s0.name && !!s0.artist && s0.duration > 0,
    JSON.stringify({ id: s0.id, mediaMid: s0.mediaMid, name: s0.name, artist: s0.artist, dur: s0.duration }));
  check('名次从 1 递增（前端显示 ①②③）',
    top.songs.map((x) => x.rank).join(',') === '1,2,3,4,5', top.songs.map((x) => x.rank).join(','));
  check('曲目里带 cached 标记（NAS 里有的标"秒播"）', 'cached' in s0, `cached=${s0.cached}`);

  // ---------- ② 缓存 ----------
  console.log('\n[4/6] ② 缓存 / 强刷 / 参数夹紧');
  const before = await qqStats();
  await get('/api/toplist?topId=26&n=5');
  await get('/api/toplist?topId=26&n=3');
  const after = await qqStats();
  check('★ 30 分钟内重复请求不再打 QQ（缓存生效）',
    after.toplistDetail === before.toplistDetail,
    `detail 请求 ${before.toplistDetail} → ${after.toplistDetail}`);

  const hit = await get('/api/toplist?topId=26&n=2');
  check('缓存命中会标 cached=true，并给出 ttlMin',
    hit.cached === true && hit.ttlMin === 30 && hit.songs.length === 2,
    `cached=${hit.cached}, ttl=${hit.ttlMin}, ${hit.songs.length} 首`);

  const forced = await get('/api/toplist?topId=26&n=5&force=1');
  const afterForce = await qqStats();
  check('force=1 才真的重新拉一次', afterForce.toplistDetail === before.toplistDetail + 1 && forced.cached === false,
    `detail=${afterForce.toplistDetail}, cached=${forced.cached}`);

  const clampHigh = await get('/api/toplist?topId=62&n=999');
  const statsHigh = await qqStats();
  check('n 超上限被夹到 100（不会把整张榜拖回来）',
    statsHigh.lastTopNum === 100 && clampHigh.songs.length === 100, `num=${statsHigh.lastTopNum}, ${clampHigh.songs.length} 首`);
  const clampZero = await get(`/api/toplist?topId=5&n=0`);
  check('n=0/脏值退回默认条数（toplistCount=5）', clampZero.songs.length === 5, `${clampZero.songs.length} 首`);

  const badId = await getSoft('/api/toplist?topId=abc');
  check('非法 topId → 502 且错误可读', badId.status === 502 && /榜单/.test(badId.data.error || ''),
    `HTTP ${badId.status} / ${badId.data.error}`);

  // ---------- ③ QQ 报错时的兜底 ----------
  console.log('\n[5/6] ③ QQ 榜单接口报错 → 用缓存兜底');
  await qqMode({ toplistCode: 2000 });
  const stale = await get('/api/toplist?topId=26&n=5&force=1');
  check('★ QQ 返回错误码时仍能看榜（stale 缓存 + 原因）',
    stale.ok === true && stale.stale === true && !!stale.error && stale.songs.length === 5,
    `stale=${stale.stale} / ${stale.error}`);
  const noCache = await getSoft('/api/toplist?topId=999&n=5&force=1'); // 没拉过的榜
  check('没缓存的榜在 QQ 出错时如实报错（不假装成功）',
    noCache.status === 502 && /榜单拉取失败/.test(noCache.data.error || ''),
    `HTTP ${noCache.status} / ${noCache.data.error}`);
  await qqMode({ clear: true });
  check('（恢复）QQ 正常后可继续拉取', (await get('/api/toplist?topId=5&n=3&force=1')).songs.length === 3);

  // ---------- ④ 点歌：复用现有链路 ----------
  console.log('\n[6/6] ④ 从榜单点歌 → 取链 → 落 NAS → 起播');
  const song = top.songs[0];
  const beforeVkey = (await qqStats()).vkey;
  const added = await post('/api/enqueue', { song, requester: '榜单测试员' });
  check('榜单曲目能直接入队（后端不接受 UI 专用字段也能吃下）',
    added.ok === true && added.item && added.item.name === song.name,
    `queue=${added.queueLength}, cached=${added.cached}`);
  const playing = await waitFor(async () => {
    const st = await get('/api/state');
    return st.current && st.current.status === 'playing' ? st : null;
  }, { label: '榜单曲目起播', timeout: 25000 });
  check('★ 真的播起来了（取链 + 下载 + 推流全复用现有链路）',
    playing.current && playing.current.name === song.name,
    `${playing.current.name} / ${playing.current.source}`);
  check('★ 走的是 QQ 取链（mock 的 vkey 计数涨了）', (await qqStats()).vkey > beforeVkey,
    `vkey ${beforeVkey} → ${(await qqStats()).vkey}`);
  const libFile = path.join(RUN_DIR, 'data', 'library.json');
  const libTxt = fs.existsSync(libFile) ? fs.readFileSync(libFile, 'utf8') : '';
  check('下载完落进了 NAS 曲库索引（下次秒播）', libTxt.includes(song.name), libTxt ? `library.json ${libTxt.length}B` : '(没有索引文件)');

  // ---------- ⑤ 未配 QQ 的实例 ----------
  console.log('\n[+ ] ⑤ 未配 QQ 的实例：503 引导');
  start('app2', '../server.js', { JB_CONFIG: cfg2Path, JB_PORT: String(APP2_PORT), JB_QQ_API: `http://127.0.0.1:${MOCK_QQ_PORT}` });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${APP2_PORT}/api/health`)).ok, { label: '第二实例就绪', timeout: 20000 });
  const noQQ = await getSoft('/api/toplist', APP2_PORT);
  check('★ 没配 QQ 时返回 503 + 明确引导（不是 500 也不是空列表）',
    noQQ.status === 503 && /QQ 音乐账号/.test(noQQ.data.error || ''),
    `HTTP ${noQQ.status} / ${noQQ.data.error}`);

  // ---------- ⑥ 落盘 ----------
  const topFile = path.join(RUN_DIR, 'data', 'toplist.json');
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(topFile, 'utf8'));
  } catch {}
  check('榜单缓存落盘（toplist.json，含列表与详情）',
    !!saved && Array.isArray(saved.lists) && saved.details && Object.keys(saved.details).length >= 1,
    saved ? `lists=${saved.lists.length}, details=${Object.keys(saved.details).join(',')}` : '(没有文件)');

  const diag = await get('/api/diag');
  check('/api/diag 暴露排行榜概况（缓存了哪些榜 / 最近错误）',
    !!diag.toplist && Number.isFinite(diag.toplist.lists) && Array.isArray(diag.toplist.cachedTops),
    JSON.stringify(diag.toplist));

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

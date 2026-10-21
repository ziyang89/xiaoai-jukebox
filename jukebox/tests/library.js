'use strict';
/**
 * 「播放过的歌自动缓存到 NAS + 再次搜索/点播优先用 NAS 文件」端到端测试
 * ------------------------------------------------------------
 * 用 mock 音源（可注入 503 限流）+ mock 播放引擎跑真链路，验证：
 *   ① 第一次播放 → 文件落到 NAS 曲库目录，索引写进 library.json
 *   ② 再次搜索 → 同一首被标注 cached 并置顶
 *   ③ 音源限流冷却期间 → 已缓存的歌照样搜得到、点得动、绕过冷却直接播
 *   ④ 队列前面卡着"要联网的歌"时，先播队列里已经在 NAS 的那首
 *   ⑤ /api/library 列表 / 本地搜索 / 重扫 / 删除
 *   ⑥ 人工丢进目录的文件能被扫出来，且音源全挂时仍可搜到并播放（纯本地）
 *
 * 用法：node tests/library.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const APP_PORT = 58186;
const MOCK_PORT = 58084; // 播放引擎 mock
const MOCK_SRC_PORT = 58083; // 音源 mock（可注入故障）
const RUN_DIR = path.join(__dirname, '.run-library');
const MUSIC_DIR = path.join(RUN_DIR, 'music');
const DATA_DIR = path.join(RUN_DIR, 'data');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, interval = 400, label = '条件' } = {}) {
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
const state = () => j(`${APP}/api/state`);
const lib = (q) => j(`${APP}/api/library${q ? '?q=' + encodeURIComponent(q) : ''}`);

let mockProc = null;
let srcProc = null;
let appProc = null;

async function cleanup() {
  for (const p of [appProc, mockProc, srcProc]) {
    if (p && !p.killed) {
      try {
        p.kill();
      } catch {}
    }
  }
  await sleep(400);
}

async function main() {
  console.log('\n===== NAS 曲库缓存 / 本地优先 端到端测试 =====\n');

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
    overtimeGraceSec: 5,
    prefetchCount: 0, // 关掉预热，测试里手动控制"什么时候真的去下载"
    maxTries: 3,
    rateCooldownMs: 30000, // 冷却要够长，"绕过冷却"才测得出来
    logLevel: 'info',
  };
  fs.writeFileSync(path.join(RUN_DIR, 'config.json'), JSON.stringify(cfg, null, 2));

  // ---------- 起 mock ----------
  mockProc = spawn(NODE, [path.join(__dirname, 'mock-songloft.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '20', MOCK_SPEED: '8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srcProc = spawn(NODE, [path.join(__dirname, 'mock-source.js')], {
    env: { ...process.env, MOCK_SRC_PORT: String(MOCK_SRC_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`)).ok, { label: 'mock 引擎就绪', timeout: 10000 });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_SRC_PORT}/?types=search&name=x&count=1`)).ok, {
    label: 'mock 音源就绪',
    timeout: 10000,
  });
  check('mock 引擎 + mock 音源启动', true, `:${MOCK_PORT} / :${MOCK_SRC_PORT}`);

  appProc = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, JB_CONFIG: path.join(RUN_DIR, 'config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appLog = [];
  appProc.stdout.on('data', (d) => appLog.push(d.toString()));
  appProc.stderr.on('data', (d) => appLog.push(d.toString()));
  await waitFor(async () => (await j(`${APP}/api/health`)).ok, { label: '点歌台就绪', timeout: 20000 });
  check('点歌台服务启动', true, `:${APP_PORT}`);

  // ---------- ① 初始状态 ----------
  const h0 = await j(`${APP}/api/health`);
  check('health 暴露曲库概况与缓存开关', h0.library && h0.library.count === 0 && h0.preferCache === true,
    `count=${h0.library && h0.library.count}, preferCache=${h0.preferCache}`);
  const l0 = await lib();
  check('初始曲库为空', l0.total === 0 && l0.stats.bytes === 0, `total=${l0.total}`);

  const s1 = await j(`${APP}/api/search?q=` + encodeURIComponent('晴天'));
  check('在线搜索可用且无缓存标记', s1.results.length > 0 && !s1.results.some((x) => x.cached),
    `${s1.results.length} 条 / localCount=${s1.localCount}`);

  // ---------- ② 第一次播放 → 自动落库 ----------
  const songA = s1.results.find((x) => x.name === '晴天' && x.source === 'netease') || s1.results[0];
  const e1 = await post(`${APP}/api/enqueue`, { song: songA, requester: '测试甲' });
  check('首次点歌：未命中缓存', e1.cached === false, `cached=${e1.cached}`);

  await waitFor(async () => {
    const st = await state();
    return st.current && st.current.status === 'playing' ? st : null;
  }, { label: '首曲起播', timeout: 20000 });
  const p1 = await state();
  check('首次播放走的是下载（非缓存）', p1.current.fromCache === false, `fromCache=${p1.current.fromCache}`);

  const libFile = path.join(DATA_DIR, 'library.json');
  const files = fs.readdirSync(MUSIC_DIR).filter((f) => f.endsWith('.mp3'));
  check('音频文件已沉淀到 NAS 曲库目录', files.length === 1, files.join(', '));
  check('library.json 索引已落盘', fs.existsSync(libFile));

  await waitFor(async () => {
    const st = await state();
    return st.current === null ? st : null;
  }, { label: '首曲播完', timeout: 30000 });

  const l1 = await lib();
  const itemA = l1.items.find((x) => x.name === '晴天');
  check('曲库列表含该曲（含时长/体积/来源）',
    !!itemA && itemA.size > 0 && itemA.duration > 0 && itemA.ext === 'mp3' && itemA.origin === 'download',
    itemA ? `${itemA.file} / ${(itemA.size / 1024).toFixed(0)}KB / ${itemA.duration}s` : '未找到');
  check('曲库统计正确', l1.stats.count === 1 && l1.stats.bytes === itemA.size,
    `${l1.stats.count} 首 / ${(l1.stats.bytes / 1024).toFixed(0)}KB`);

  // 直链可用（音箱就是拉这个）
  const audioRes = await fetch(itemA.streamUrl);
  const audioBuf = Buffer.from(await audioRes.arrayBuffer());
  check('/audio/<key>.mp3 可拉流且字节数一致',
    audioRes.ok && audioBuf.length === itemA.size && audioBuf.slice(0, 3).toString('latin1') === 'ID3',
    `HTTP ${audioRes.status}, ${audioBuf.length}B`);

  // 索引内容
  const diag = await j(`${APP}/api/diag/library`);
  check('诊断：索引里的文件在磁盘上真实存在', diag.items.length === 1 && diag.items[0].onDisk === true,
    diag.items.map((x) => x.file).join(','));

  // ---------- ③ 再搜一次 → 标记 + 置顶 ----------
  const s2 = await j(`${APP}/api/search?q=` + encodeURIComponent('晴天'));
  const hit2 = s2.results.find((x) => x.name === '晴天' && x.source === 'netease');
  check('再次搜索：命中标记 cached', !!hit2 && hit2.cached === true, hit2 ? `duration=${hit2.duration}` : '未找到');
  check('已缓存的排在未缓存的之前',
    s2.results.findIndex((x) => x.cached) < s2.results.findIndex((x) => !x.cached),
    `localCount=${s2.localCount}`);

  const sLocal = await j(`${APP}/api/search?q=` + encodeURIComponent('晴天') + '&local=1');
  check('只搜本地（不联音源）', sLocal.localOnly === true && sLocal.results.every((x) => x.source === 'local'),
    `${sLocal.count} 条`);

  // ---------- ④ 注入限流 → 缓存曲目照样能搜能播 ----------
  await post(`http://127.0.0.1:${MOCK_SRC_PORT}/__fault`, { url503Ms: 30000 });
  const songB = s1.results.find((x) => x.name === '七里香') || s1.results[1];
  await post(`${APP}/api/enqueue`, { song: songB, requester: '测试乙' });
  const stCool = await waitFor(async () => {
    const st = await state();
    return st.cooldownLeftSec > 0 ? st : null;
  }, { label: '进入音源冷却', timeout: 20000 });
  check('未缓存的歌撞上限流 → 留在队列里等重试（不消失）',
    stCool.queue.length >= 1 && stCool.queue.some((q) => q.name === songB.name) && !!stCool.notice,
    `队列 ${stCool.queue.length} 首，冷却 ${stCool.cooldownLeftSec}s`);

  const s3 = await j(`${APP}/api/search?q=` + encodeURIComponent('晴天'));
  check('冷却期搜索：仍然返回 NAS 里已缓存的那首',
    s3.results.some((x) => x.name === '晴天' && x.cached === true),
    `onlineCount=${s3.onlineCount}, localCount=${s3.localCount}${s3.warning ? ' / ' + s3.warning : ''}`);

  // 点这首已缓存的 → 应当无视冷却直接播
  const e2 = await post(`${APP}/api/enqueue`, { song: hit2, requester: '测试丙' });
  check('点已缓存的歌：接口直接回 cached（不排队等冷却）', e2.cached === true && e2.cooldownLeftSec === 0,
    `cached=${e2.cached}, cooldown=${e2.cooldownLeftSec}`);

  const stPlaying = await waitFor(async () => {
    const st = await state();
    return st.current && st.current.name === '晴天' ? st : null;
  }, { label: '缓存曲目起播', timeout: 20000 });
  check('冷却期已缓存曲目照常播放（绕过音源冷却）', stPlaying.current.fromCache === true,
    `fromCache=${stPlaying.current.fromCache}, 队列里还压着 ${stPlaying.queue.length} 首`);
  check('队列里那首没被丢（顺序不乱）', stPlaying.queue.some((q) => q.name === songB.name),
    stPlaying.queue.map((q) => `${q.name}${q.cached ? '(已缓存)' : ''}`).join(' | '));

  await waitFor(async () => {
    const st = await state();
    return st.current === null ? st : null;
  }, { label: '缓存曲目播完', timeout: 30000 });

  // ---------- ⑤ 人工丢进目录的文件 → 重扫 → 纯本地点播 ----------
  const cachedFile = path.join(MUSIC_DIR, itemA.file);
  const manualName = '五月天 - 倔强.mp3';
  fs.copyFileSync(cachedFile, path.join(MUSIC_DIR, manualName));
  const rs = await post(`${APP}/api/library/rescan`);
  check('重扫曲库目录', rs.count === 2, `count=${rs.count}`);

  const l2 = await lib('倔强');
  const itemM = l2.items.find((x) => x.name === '倔强');
  check('人工放入的文件被识别（歌手/歌名从文件名解析）',
    !!itemM && itemM.artist === '五月天' && itemM.origin === 'scanned' && itemM.duration > 0,
    itemM ? `${itemM.artist} - ${itemM.name} / ${itemM.origin} / ${itemM.duration}s` : '未找到');

  const s4 = await j(`${APP}/api/search?q=` + encodeURIComponent('倔强'));
  check('音源还在冷却时，搜索仍能列出 NAS 里的本地曲目',
    s4.results.some((x) => x.name === '倔强' && x.local === true),
    `onlineCount=${s4.onlineCount}, count=${s4.count}${s4.warning ? ' / ' + s4.warning : ''}`);

  const e3 = await post(`${APP}/api/enqueue`, {
    song: { source: 'local', localKey: itemM.key, id: itemM.id, name: itemM.name, artist: itemM.artist },
    requester: '测试丁',
  });
  const stLocal = await waitFor(async () => {
    const st = await state();
    return st.current && st.current.name === '倔强' ? st : null;
  }, { label: '纯本地曲目起播', timeout: 20000 });
  check('纯本地曲目直接播放（音源挂着也能放）',
    stLocal.current.fromCache === true && e3.cached === true, `fromCache=${stLocal.current.fromCache}`);

  // 冷却解除，队列里那首最后也要能播完（不能因为缓存插队就丢歌）
  await post(`http://127.0.0.1:${MOCK_SRC_PORT}/__fault`, { clear: true });
  const stTail = await waitFor(async () => {
    const st = await state();
    return st.queue.length === 0 && st.current === null ? st : null;
  }, { label: '队列清空（含冷却后自动重试的那首）', timeout: 60000 });
  const histNames = (await state()).history.map((x) => x.name);
  check('限流那首最终也播完了（缓存插队没有导致丢歌）',
    histNames.includes(songB.name) && stTail.queue.length === 0,
    histNames.slice(0, 5).join(' → '));

  // ---------- ⑥ 删除 ----------
  await post(`${APP}/api/clear`);
  const l3 = await lib();
  const keys = Object.fromEntries(l3.items.map((x) => [x.name, x.key]));
  const del = await post(`${APP}/api/library/delete`, { key: keys['晴天'] });
  check('删除曲库里的文件', del.ok === true && del.freed > 0, `释放 ${(del.freed / 1024).toFixed(0)}KB`);
  check('文件确实从磁盘删掉了', !fs.existsSync(cachedFile));

  const l4 = await lib();
  check('曲库统计同步更新', l4.total === l3.total - 1 && l4.stats.count === l4.total,
    `${l3.total} → ${l4.total}，共 ${(l4.stats.bytes / 1024).toFixed(0)}KB`);

  let delErr = '';
  try {
    await post(`${APP}/api/library/delete`, { key: keys['晴天'] });
  } catch (e) {
    delErr = e.message;
  }
  check('重复删除 → 明确报错', /没有这首歌/.test(delErr), delErr);

  // 删掉之后再点那首"纯本地"的歌 → 应报找不到，而不是偷偷回音源
  await post(`${APP}/api/enqueue`, { song: { source: 'local', localKey: keys['晴天'], name: '晴天', artist: songA.artist }, requester: '测试戊' });
  const bad = await waitFor(async () => {
    const st = await state();
    const h = st.history.find((x) => x.reason && x.reason.includes('晴天'));
    return h || null;
  }, { label: '本地缺失报错', timeout: 20000 });
  check('本地文件被删后点播 → 如实报错（不静默回音源）', /找不到/.test(bad.reason), bad.reason);

  // ---------- ⑦ 重启后索引还在（NAS 上服务会被重启 / 升级） ----------
  const beforeRestart = await lib();
  appProc.kill();
  await sleep(1000);
  appProc = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, JB_CONFIG: path.join(RUN_DIR, 'config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appProc.stdout.on('data', (d) => appLog.push(d.toString()));
  appProc.stderr.on('data', (d) => appLog.push(d.toString()));
  await waitFor(async () => (await j(`${APP}/api/health`)).ok, { label: '重启后就绪', timeout: 20000 });
  const afterRestart = await lib();
  const m2 = afterRestart.items.find((x) => x.name === '倔强');
  check('重启后曲库索引完整保留（歌手/来源都没丢）',
    afterRestart.total === beforeRestart.total && !!m2 && m2.artist === '五月天' && m2.origin === 'scanned',
    `${beforeRestart.total} → ${afterRestart.total} 首`);

  // ---------- 汇总 ----------
  const okN = results.filter((r) => r.ok).length;
  console.log(`\n===== 结果：${okN}/${results.length} 通过 =====`);
  if (okN !== results.length) {
    console.log('\n失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ❌ ${r.name} — ${r.detail}`));
    console.log('\n服务端日志尾部：\n' + appLog.join('').split('\n').slice(-25).join('\n'));
  }
  await cleanup();
  process.exit(okN === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n测试异常终止：', e);
  await cleanup();
  process.exit(1);
});

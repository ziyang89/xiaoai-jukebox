'use strict';
/**
 * 「管理员才能停止播放」端到端测试
 * ------------------------------------------------------------
 *  ① 没设口令时不能停：403 + 明确告诉前端"去设置"
 *  ② 口令设置：长度校验、只落哈希（文件里不许出现明文）、状态可查
 *  ③ 解锁校验：错口令 403、对口令 200
 *  ④ 停止：掐断当前曲目 + 清空所有人的点歌 + 音箱确实收到停止指令
 *  ⑤ 停止之后调度器不许自己把队列续上（等够好几个 tick）
 *  ⑥ 插件不提供 stop/pause 时，自动降级为「推 1 秒静音」兜底
 *  ⑦ 改口令必须先验旧口令
 *  ⑧ 停止后的静默期会让位于新点歌（别人再点歌照常播）
 *
 * 用法：node tests/admin-stop.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const APP_PORT = 58188;
const MOCK_PORT = 58087; // 播放引擎 mock（带 stop/pause + __nostop 开关）
const MOCK_SRC_PORT = 58086; // 音源 mock
const RUN_DIR = path.join(__dirname, '.run-admin');
const MUSIC_DIR = path.join(RUN_DIR, 'music');
const DATA_DIR = path.join(RUN_DIR, 'data');

const PIN = 'abcd1234';

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
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

async function raw(url, opt) {
  const r = await fetch(url, opt);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json().catch(() => ({})) : await r.text();
  return { status: r.status, data };
}
const j = async (url, opt) => {
  const { status, data } = await raw(url, opt);
  if (status >= 400) throw new Error((data && data.error) || `HTTP ${status}`);
  return data;
};
const postJson = (url, body) =>
  raw(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const post = async (url, body) => {
  const { status, data } = await postJson(url, body);
  if (status >= 400) throw new Error((data && data.error) || `HTTP ${status}`);
  return data;
};
const state = () => j(`${APP}/api/state`);
const adminStatus = () => j(`${APP}/api/admin/status`);
const mockLog = () => j(`${MOCK}/__log`);

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
  console.log('\n===== 管理员「停止播放」端到端测试 =====\n');

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
      base: MOCK,
      prefix: '/api/v1/jsplugin/miot',
      username: 'admin',
      password: 'mock-pass',
    },
    searchSources: ['netease'],
    sources: ['netease'],
    gdApi: `http://127.0.0.1:${MOCK_SRC_PORT}/`,
    retry: 1,
    volume: 0,
    pollIntervalMs: 400,
    minPlaySec: 0,
    overtimeGraceSec: 60,
    prefetchCount: 0,
    maxTries: 2,
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
  await waitFor(async () => (await fetch(`${MOCK}/__log`)).ok, { label: 'mock 引擎就绪', timeout: 10000 });
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

  // ---------- ① 还没设口令 ----------
  const a0 = await adminStatus();
  check('初始：管理员状态为「未设置」', a0.configured === false && a0.source === 'none',
    `configured=${a0.configured}, source=${a0.source}`);

  const s0 = await state();
  check('/api/state 下发 adminConfigured（页面据此决定引导设置还是输口令）',
    s0.adminConfigured === false && !('adminPin' in s0), `adminConfigured=${s0.adminConfigured}`);

  const stop0 = await postJson(`${APP}/api/admin/stop`, { pin: 'whatever' });
  check('未设口令时管理员接口不能停（403 + needSetup）',
    stop0.status === 403 && stop0.data.needSetup === true && !stop0.data.ok,
    `HTTP ${stop0.status} / ${stop0.data.error}`);

  // 但"停止全场"已经对所有人开放：公开接口不带任何口令也能停
  const pubStop0 = await postJson(`${APP}/api/stop`, {});
  check('★ 公开停止接口不需要口令（/api/stop → 200）',
    pubStop0.status === 200 && pubStop0.data.ok === true,
    `HTTP ${pubStop0.status} / ${JSON.stringify(pubStop0.data).slice(0, 90)}`);

  // ---------- ② 设置口令 ----------
  const shortPin = await postJson(`${APP}/api/admin/setup`, { pin: '123' });
  check('口令太短被拒（至少 4 位）', shortPin.status === 400, `HTTP ${shortPin.status}`);

  const set1 = await postJson(`${APP}/api/admin/setup`, { pin: PIN });
  check('设置管理员口令成功', set1.status === 200 && set1.data.ok === true);

  const a1 = await adminStatus();
  check('设置后状态变为已配置（来源=本地文件）', a1.configured === true && a1.source === 'file',
    `configured=${a1.configured}, source=${a1.source}`);

  const adminFile = path.join(DATA_DIR, 'admin.json');
  const adminTxt = fs.existsSync(adminFile) ? fs.readFileSync(adminFile, 'utf8') : '';
  check('口令以哈希落盘，文件里查不到明文',
    adminTxt.length > 0 && !adminTxt.includes(PIN) && /"hash"\s*:/.test(adminTxt) && /"salt"\s*:/.test(adminTxt),
    `admin.json ${adminTxt.length}B, 含明文=${adminTxt.includes(PIN)}`);

  const rec = JSON.parse(adminTxt);
  const stLeak = JSON.stringify(await state());
  check('/api/state 绝不外泄口令 / 哈希 / 盐',
    !stLeak.includes(PIN) && !stLeak.includes(rec.hash) && !stLeak.includes(rec.salt),
    'state 里没有任何 admin 凭据字段');

  // ---------- ③ 解锁校验 ----------
  const vBad = await postJson(`${APP}/api/admin/verify`, { pin: 'wrongpass' });
  check('错口令解锁失败（403）', vBad.status === 403, `HTTP ${vBad.status}`);
  const vEmpty = await postJson(`${APP}/api/admin/verify`, {});
  check('空口令解锁失败（403）', vEmpty.status === 403, `HTTP ${vEmpty.status}`);
  const vOk = await postJson(`${APP}/api/admin/verify`, { pin: PIN });
  check('正确口令解锁成功', vOk.status === 200 && vOk.data.ok === true);

  // ---------- ④ 停止：掐断 + 清队列 ----------
  const search = await j(`${APP}/api/search?q=` + encodeURIComponent('晴天'));
  const songs = (search.results || []).slice(0, 2);
  check('搜索拿到测试曲目', songs.length === 2, songs.map((s) => s.name).join(' / '));

  await post(`${APP}/api/enqueue`, { song: songs[0], requester: '测试甲' });
  await post(`${APP}/api/enqueue`, { song: songs[1], requester: '测试乙' });
  const stPlay = await waitFor(async () => {
    const st = await state();
    return st.current && st.current.status === 'playing' ? st : null;
  }, { label: '曲目起播', timeout: 25000 });
  check('两首入队、第一首已起播', stPlay.current && stPlay.queue.length === 1,
    `current=${stPlay.current.name}, 队列 ${stPlay.queue.length} 首`);

  await j(`${MOCK}/__reset`);
  const stopReq = await postJson(`${APP}/api/admin/stop`, { pin: PIN });
  check('管理员停止成功（200）', stopReq.status === 200 && stopReq.data.ok === true,
    `HTTP ${stopReq.status} / cleared=${stopReq.data.cleared} / how=${stopReq.data.how}`);
  check('停止回报：掐断了正在播的那首、清掉了待播的',
    stopReq.data.stopped === songs[0].name && stopReq.data.cleared === 1,
    `stopped=${stopReq.data.stopped}, cleared=${stopReq.data.cleared}`);

  const stStop = await state();
  check('停止后：没有当前曲目、队列空、playing=false',
    stStop.current === null && stStop.queue.length === 0 && stStop.playing === false,
    `current=${stStop.current}, queue=${stStop.queue.length}, playing=${stStop.playing}`);

  const lg = await mockLog();
  check('音箱确实收到了停止指令（插件有 stop 时直接用它）',
    lg.some((x) => x.kind === 'stop' || x.kind === 'pause'),
    lg.map((x) => x.kind).join(',') || '(空)');
  check('停止方式优先走插件端点，而非静音兜底', stopReq.data.how === '/mina/stop', `how=${stopReq.data.how}`);

  // ---------- ⑤ 停止后不许自动续播 ----------
  const before = (await state()).history.length;
  await sleep(2600); // > 6 个 tick 周期
  const stAfter = await state();
  check('停止后调度器不会自己把队列续上（等 2.6s 仍无曲目）',
    stAfter.current === null && stAfter.queue.length === 0 && stAfter.playing === false,
    `current=${stAfter.current}, history 条数 ${before}→${stAfter.history.length}`);

  // ---------- ⑤b 停止对所有人开放：不带口令也能停，且会认出是谁按的 ----------
  const cid = 'stop-test-client-1';
  const claim = await postJson(`${APP}/api/nick/claim`, { clientId: cid, nick: '停止测试员' });
  await post(`${APP}/api/live`, { clientId: cid, nick: '停止测试员', since: 0 });
  check('（前置）拿到昵称并进聊天室', claim.status === 200 && claim.data.nick === '停止测试员',
    `HTTP ${claim.status} / nick=${claim.data && claim.data.nick}`);

  await post(`${APP}/api/enqueue`, { song: songs[1], requester: '测试戊' });
  await post(`${APP}/api/enqueue`, { song: songs[0], requester: '测试己' });
  await waitFor(async () => {
    const st = await state();
    return st.current && st.current.status === 'playing' ? st : null;
  }, { label: '公开停止用例起播', timeout: 25000 });

  await j(`${MOCK}/__reset`);
  const pubStop = await postJson(`${APP}/api/stop`, { clientId: cid }); // 故意不带 pin / nick
  check('★ 普通用户不带口令就能停止（200）',
    pubStop.status === 200 && pubStop.data.ok === true,
    `HTTP ${pubStop.status} / ${JSON.stringify(pubStop.data).slice(0, 90)}`);
  check('★ 公开停止同样：掐断当前曲 + 清空待播队列',
    pubStop.data.stopped === songs[1].name && pubStop.data.cleared === 1,
    `stopped=${pubStop.data.stopped}, cleared=${pubStop.data.cleared}`);
  check('★ 服务端按 clientId 认出是谁按的（不信前端自报的 nick）',
    pubStop.data.by === '停止测试员', `by=${JSON.stringify(pubStop.data.by)}`);

  const stPub = await state();
  check('★ 公开停止后：无当前曲目、队列空、playing=false',
    stPub.current === null && stPub.queue.length === 0 && stPub.playing === false,
    `current=${stPub.current}, queue=${stPub.queue.length}, playing=${stPub.playing}`);
  check('★ /api/state 带上了最近一次停止（谁按的 / 清了几个）',
    !!stPub.stop && stPub.stop.by === '停止测试员' && stPub.stop.cleared === 1 && Number(stPub.stop.at) > 0,
    JSON.stringify(stPub.stop));

  const lgPub = await mockLog();
  check('★ 公开停止也真的掐了音箱', lgPub.some((x) => x.kind === 'stop' || x.kind === 'pause'),
    lgPub.map((x) => x.kind).join(',') || '(空)');

  const chatAfter = await j(`${APP}/api/live?clientId=${encodeURIComponent(cid)}&since=0&limit=50`);
  check('★ 停止会播报到聊天室（大家都能看到谁停的）',
    (chatAfter.msgs || []).some((m) => m.kind === 'sys' && /停止测试员/.test(m.text || '') && /停止/.test(m.text || '')),
    (chatAfter.msgs || []).slice(-3).map((m) => m.text).join(' | '));

  await sleep(2600);
  const stPubWait = await state();
  check('★ 公开停止后同样不会自动续播（等 2.6s 仍安静）',
    stPubWait.current === null && stPubWait.queue.length === 0,
    `current=${stPubWait.current}, queue=${stPubWait.queue.length}`);

  // 管理员那条接口也没被"顺手放开"：不带口令还是进不去
  const adminStillClosed = await postJson(`${APP}/api/admin/stop`, {});
  check('★ 管理员接口仍然要口令（没有被一起放开）', adminStillClosed.status === 403,
    `HTTP ${adminStillClosed.status}`);

  // ---------- ⑥ 插件没有 stop/pause → 静音兜底 ----------
  await post(`${MOCK}/__nostop`, { on: true });
  await post(`${APP}/api/enqueue`, { song: songs[0], requester: '测试丙' });
  await waitFor(async () => {
    const st = await state();
    return st.current && st.current.status === 'playing' ? st : null;
  }, { label: '兜底用例起播', timeout: 25000 });

  await j(`${MOCK}/__reset`);
  const stopNoStop = await postJson(`${APP}/api/admin/stop`, { pin: PIN });
  check('插件无 stop/pause 时仍能停（降级为静音兜底）',
    stopNoStop.status === 200 && /静音/.test(String(stopNoStop.data.how)), `how=${stopNoStop.data.how}`);

  const lg2 = await mockLog();
  const silenceHit = lg2.filter((x) => x.kind === 'play-url' && /__silence\.mp3/.test(x.url || ''));
  check('兜底确实是推了内置静音给音箱', silenceHit.length >= 1,
    silenceHit.length ? silenceHit[silenceHit.length - 1].url : '(没找到静音推流)');

  const sil = await fetch(`${APP}/audio/__silence.mp3`);
  const silBuf = Buffer.from(await sil.arrayBuffer());
  check('内置静音可直接拉取（合法 MP3 帧、约 1 秒）',
    sil.status === 200 && /audio\/mpeg/.test(sil.headers.get('content-type') || '') &&
      silBuf.length > 10000 && silBuf[0] === 0xff && silBuf[1] === 0xfb && silBuf.length % 417 === 0,
    `HTTP ${sil.status}, ${silBuf.length}B = ${silBuf.length / 417} 帧`);

  await post(`${MOCK}/__nostop`, { on: false });

  // ---------- ⑧ 静默期让位于新点歌 ----------
  await post(`${APP}/api/enqueue`, { song: songs[0], requester: '测试丁' });
  const stResume = await waitFor(async () => {
    const st = await state();
    return st.current ? st : null;
  }, { label: '停止后重新点歌起播', timeout: 15000 });
  check('停止后再点歌照常能播（静默期不拦新点歌）', !!stResume.current, `current=${stResume.current.name}`);

  // ---------- ⑦ 改口令必须先验旧口令 ----------
  const chBad = await postJson(`${APP}/api/admin/setup`, { pin: 'newpass99', oldPin: 'nope' });
  check('改口令时旧口令不对 → 拒绝', chBad.status === 403, `HTTP ${chBad.status}`);

  const chOk = await postJson(`${APP}/api/admin/setup`, { pin: 'newpass99', oldPin: PIN });
  check('旧口令正确 → 改口令成功', chOk.status === 200, `HTTP ${chOk.status}`);

  const vOld = await postJson(`${APP}/api/admin/verify`, { pin: PIN });
  const vNew = await postJson(`${APP}/api/admin/verify`, { pin: 'newpass99' });
  check('改完之后：旧口令失效、新口令生效', vOld.status === 403 && vNew.status === 200,
    `old=${vOld.status}, new=${vNew.status}`);

  // ---------- 汇总 ----------
  await cleanup();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====\n`);
  if (pass !== results.length) {
    console.log('失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ❌ ${r.name}  — ${r.detail}`));
    console.log('\n---- 服务端日志尾部 ----');
    console.log(appLog.join('').split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error('\n测试异常：', e.message);
  await cleanup();
  process.exit(1);
});

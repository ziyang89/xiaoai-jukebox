'use strict';
/**
 * 点歌台端到端冒烟测试
 * ------------------------------------------------------------
 * 用 mock 的 songloft 插件作为播放引擎，跑通完整链路：
 *   启动 → 引擎握手 → 搜索（真实音源）→ 点歌 → 取链下载 → 推流
 *   → 音箱侧拉取音频校验 → 播完自动切下一首
 *
 * 用法：node tests/smoke.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const MOCK_PORT = 58099; // 播放引擎 mock
const MOCK_SRC_PORT = 58098; // 音源 API mock
const APP_PORT = 58192;
const USE_REAL_SOURCE = process.argv.includes('--real');
const RUN_DIR = path.join(__dirname, '.run');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 500, label = '条件' } = {}) {
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
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
};
const post = (url, body) =>
  j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

let mockProc = null;
let srcProc = null;
let appProc = null;
const logs = { mock: [], src: [], app: [] };

function pipe(proc, bucket) {
  proc.stdout.on('data', (d) => bucket.push(d.toString()));
  proc.stderr.on('data', (d) => bucket.push(d.toString()));
}

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
  console.log('\n===== 点歌台端到端冒烟测试 =====');
  console.log(`音源模式：${USE_REAL_SOURCE ? '真实外网音源（GD Studio）' : '本地 mock 音源（加 --real 可切真实）'}\n`);

  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DIR, 'music'), { recursive: true });
  fs.mkdirSync(path.join(RUN_DIR, 'data'), { recursive: true });

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
    },
    searchSources: ['netease', 'kugou'],
    sources: ['netease', 'kugou'],
    gdApi: USE_REAL_SOURCE ? undefined : `http://127.0.0.1:${MOCK_SRC_PORT}/`,
    retry: 3,
    volume: 35,
    pollIntervalMs: 700,
    minPlaySec: 0, // mock 用倍速播放，压缩时间；真实环境有 12s 起播保护
    overtimeGraceSec: 5,
    prefetchCount: 1,
    logLevel: 'info',
  };
  const cfgPath = path.join(RUN_DIR, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // ---------- 启动 mock ----------
  console.log('[1/6] 启动 mock 播放引擎…');
  mockProc = spawn(NODE, [path.join(__dirname, 'mock-songloft.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '20', MOCK_SPEED: '8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipe(mockProc, logs.mock);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`)).ok, { label: 'mock 就绪', timeout: 10000 });
  check('mock 播放引擎启动', true, `:${MOCK_PORT}`);

  // ---------- 启动 mock 音源 ----------
  if (!USE_REAL_SOURCE) {
    console.log('\n[1b/6] 启动 mock 音源…');
    srcProc = spawn(NODE, [path.join(__dirname, 'mock-source.js')], {
      env: { ...process.env, MOCK_SRC_PORT: String(MOCK_SRC_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipe(srcProc, logs.src);
    await waitFor(
      async () => {
        const r = await fetch(`http://127.0.0.1:${MOCK_SRC_PORT}/?types=search&name=x&count=1`);
        return r.ok;
      },
      { label: 'mock 音源就绪', timeout: 10000 }
    );
    check('mock 音源 API 启动', true, `:${MOCK_SRC_PORT}`);
  }

  // ---------- 启动点歌台 ----------
  console.log('\n[2/6] 启动点歌台服务…');
  appProc = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, JB_CONFIG: cfgPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipe(appProc, logs.app);

  const health = await waitFor(
    async () => {
      const h = await j(`http://127.0.0.1:${APP_PORT}/api/health`);
      return h && h.ok ? h : null;
    },
    { label: '点歌台就绪', timeout: 20000 }
  );
  check('点歌台服务启动', true, `v${health.version} :${APP_PORT}`);

  // ---------- 引擎握手 ----------
  console.log('\n[3/6] 校验播放引擎握手…');
  const st0 = await waitFor(
    async () => {
      const s = await j(`http://127.0.0.1:${APP_PORT}/api/state`);
      return s.engineOk ? s : null;
    },
    { label: '引擎就绪', timeout: 15000 }
  );
  check('引擎登录 + 设备发现', !!st0.engineOk, `${st0.device ? st0.device.name + ' [' + st0.device.hardware + ']' : ''}`);
  check('自动选中 L17A 音箱', st0.device && /L17A/.test(st0.device.hardware || ''), st0.device ? st0.device.id : '');

  // ---------- 搜索（真实音源）----------
  console.log('\n[4/6] 真实音源搜索…');
  let songs = [];
  try {
    const s = await j(`http://127.0.0.1:${APP_PORT}/api/search?q=` + encodeURIComponent('晴天'));
    songs = s.results || [];
    check('音源搜索返回结果', songs.length > 0, `${songs.length} 条` + (songs[0] ? `，首条《${songs[0].name}》- ${songs[0].artist}` : ''));
  } catch (e) {
    check('音源搜索返回结果', false, e.message);
  }

  if (!songs.length) {
    console.log('\n⚠️ 搜索无结果，无法继续点歌流程（可能是外网/音源波动）');
    return;
  }

  // ---------- 点歌 ----------
  console.log('\n[5/6] 点歌 → 下载 → 推流…');
  const pickA = songs[0];
  const pickB = songs[1] || songs[0];
  await post(`http://127.0.0.1:${APP_PORT}/api/enqueue`, { song: pickA, requester: '测试甲' });
  await post(`http://127.0.0.1:${APP_PORT}/api/enqueue`, { song: pickB, requester: '测试乙' });
  check('两首歌入队', true, `${pickA.name} / ${pickB.name}`);

  const playing = await waitFor(
    async () => {
      const s = await j(`http://127.0.0.1:${APP_PORT}/api/state`);
      return s.current && s.current.status === 'playing' ? s : null;
    },
    { label: '首曲进入播放', timeout: 60000, interval: 800 }
  );
  check('首曲推流成功', true, `《${playing.current.name}》${playing.current.fromCache ? '(本地缓存)' : '(新下载)'}`);

  // mock 是否收到 play-url
  const mlog = await j(`http://127.0.0.1:${MOCK_PORT}/__log`);
  const playCalls = mlog.filter((x) => x.kind === 'play-url');
  check('播放引擎收到推流指令', playCalls.length >= 1, `${playCalls.length} 次`);
  const pushedUrl = playCalls[0]?.url || '';
  check('推流地址指向本服务音频端', /127\.0\.0\.1:58192\/audio\//.test(pushedUrl), pushedUrl);

  // 验证音箱侧能拉到音频（Range 请求）
  if (pushedUrl) {
    try {
      const r = await fetch(pushedUrl, { headers: { Range: 'bytes=0-2047' } });
      const buf = Buffer.from(await r.arrayBuffer());
      const isAudio =
        buf.slice(0, 3).toString('latin1') === 'ID3' ||
        (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) ||
        buf.slice(0, 4).toString('latin1') === 'fLaC' ||
        buf.slice(4, 8).toString('latin1') === 'ftyp';
      check('音箱可拉取音频（Range/206）', r.status === 206 && isAudio, `HTTP ${r.status}，${r.headers.get('content-type')}，签名=${isAudio}`);
    } catch (e) {
      check('音箱可拉取音频（Range/206）', false, e.message);
    }
  }

  // ---------- 自动续播 ----------
  console.log('\n[6/6] 等待播完自动切下一首…');
  try {
    const second = await waitFor(
      async () => {
        const m = await j(`http://127.0.0.1:${MOCK_PORT}/__log`);
        const calls = m.filter((x) => x.kind === 'play-url');
        return calls.length >= 2 ? calls : null;
      },
      { label: '自动切歌', timeout: 45000, interval: 800 }
    );
    check('播完自动切下一首', second.length >= 2, `累计推流 ${second.length} 次`);
    check('第二首与第一首不同', second[1].url !== second[0].url, '');
  } catch (e) {
    check('播完自动切下一首', false, e.message);
  }

  // ---------- 队列清空 ----------
  const stEnd = await j(`http://127.0.0.1:${APP_PORT}/api/state`);
  check('队列已消费完', stEnd.queue.length === 0, `剩余 ${stEnd.queue.length}`);
  check('统计计数正常', stEnd.stats.playCount >= 2, `播放 ${stEnd.stats.playCount} 次，失败 ${stEnd.stats.failCount} 次`);

  // ---------- 首次配置接口（/api/setup）----------
  console.log('\n[附] 首次配置接口 /api/setup…');
  check('needSetup 正确反映配置状态', stEnd.needSetup === false, `needSetup=${stEnd.needSetup}，hasPassword=${stEnd.hasPassword}`);
  check('不回传密码本体', stEnd.password === undefined && stEnd.enginePassword === undefined, '');

  let rejected = false;
  try {
    await post(`http://127.0.0.1:${APP_PORT}/api/setup`, {
      base: `http://127.0.0.1:${MOCK_PORT}`,
      username: 'admin',
      password: 'wrong-pass',
    });
  } catch (e) {
    rejected = /登录失败|invalid/i.test(e.message);
  }
  const runtimeCfg = path.join(RUN_DIR, 'data', 'runtime-config.json');
  check('错误密码被拒绝', rejected, '详情见点歌台日志');
  check('错误密码不落盘', !fs.existsSync(runtimeCfg), runtimeCfg);

  try {
    const r = await post(`http://127.0.0.1:${APP_PORT}/api/setup`, {
      base: `http://127.0.0.1:${MOCK_PORT}`,
      username: 'admin',
      password: 'mock-pass',
      deviceId: 'mock-l17a-1',
    });
    check('正确凭据保存并生效', r.ok === true && !!r.device, r.device ? `${r.device.name} [${r.device.hardware}]` : '');
    check('运行期配置已写入 data 卷', fs.existsSync(runtimeCfg), '');
    const stAfter = await j(`http://127.0.0.1:${APP_PORT}/api/state`);
    check('配置后引擎仍就绪', stAfter.engineOk === true && stAfter.device.id === 'mock-l17a-1', '');
  } catch (e) {
    check('正确凭据保存并生效', false, e.message);
    check('运行期配置已写入 data 卷', false, e.message);
    check('配置后引擎仍就绪', false, e.message);
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
      console.log('\n----- 点歌台日志（末 40 行）-----');
      console.log(logs.app.join('').split('\n').slice(-40).join('\n'));
      console.log('\n----- mock 日志 -----');
      console.log(logs.mock.join('').split('\n').slice(-15).join('\n'));
    }
    console.log('');
    process.exit(pass === total ? 0 : 1);
  });

'use strict';
/**
 * 用真实会员账号验证 QQ 音源（需要外网 + 有效 qm_keyst）
 * ------------------------------------------------------------
 * 和 qq-source.js 的区别：那个用 mock 验逻辑，这个用**真接口**验"今天到底能不能用"。
 * 走的是 server.js 里真正上线的那条代码（搜索 → 取链 → 下载 → 推流），
 * 不是另外写一份实现，所以能证明集成没写错。
 *
 * 用法：
 *   JB_QQ_KEY=<qm_keyst> JB_QQ_UIN=<QQ号> node tests/verify-qq-real.js
 *   或 node tests/verify-qq-real.js --key <qm_keyst> --uin <QQ号> [--q 关键词]
 *
 * 注意：会真的下载一首歌（约 10MB）到临时目录，测完删掉。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const MOCK_PORT = 58099;
const APP_PORT = 58195;
const RUN_DIR = path.join(__dirname, '.run-qq-real');

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : '';
}
const KEY = argOf('--key') || process.env.JB_QQ_KEY || '';
const UIN = argOf('--uin') || process.env.JB_QQ_UIN || '';
const KW = argOf('--q') || '晴天 周杰伦';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 40000, interval = 500, label = '条件' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* 继续等 */
    }
    await sleep(interval);
  }
  throw new Error(`${label} 超时`);
}
const post = async (p, body) => {
  const r = await fetch(`http://127.0.0.1:${APP_PORT}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
};
const get = async (p) => {
  const r = await fetch(`http://127.0.0.1:${APP_PORT}${p}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
};

(async () => {
  if (!KEY || !UIN) {
    console.error('需要 --key <qm_keyst> 与 --uin <QQ号>（或环境变量 JB_QQ_KEY / JB_QQ_UIN）');
    process.exit(2);
  }
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DIR, 'music'), { recursive: true });
  fs.mkdirSync(path.join(RUN_DIR, 'data'), { recursive: true });

  const cfg = {
    port: APP_PORT,
    publicBase: `http://127.0.0.1:${APP_PORT}`,
    musicDir: path.join(RUN_DIR, 'music'),
    dataDir: path.join(RUN_DIR, 'data'),
    engine: { type: 'songloft', base: `http://127.0.0.1:${MOCK_PORT}`, prefix: '/api/v1/jsplugin/miot', username: 'admin', password: 'x' },
    // GD 故意指到一个不存在的地址：这一步就是要证明"全靠 QQ 也能跑"
    gdApi: 'http://127.0.0.1:1/never',
    searchSources: ['qq', 'netease'],
    sources: ['qq', 'netease'],
    qq: { key: KEY, uin: UIN, quality: '320k' },
    adminPin: '2468',
    volume: 0,
    pollIntervalMs: 700,
    minPlaySec: 0,
    prefetchCount: 0,
    logLevel: 'info',
  };
  const cfgPath = path.join(RUN_DIR, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const mock = spawn(NODE, [path.join(__dirname, 'mock-songloft.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '600', MOCK_SPEED: '1' },
    stdio: 'ignore',
  });
  const app = spawn(NODE, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, JB_CONFIG: cfgPath, JB_PORT: String(APP_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appLog = [];
  app.stdout.on('data', (d) => appLog.push(d.toString()));
  app.stderr.on('data', (d) => appLog.push(d.toString()));

  const kill = () => {
    try {
      app.kill();
    } catch {}
    try {
      mock.kill();
    } catch {}
  };

  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`)).ok, { label: 'mock 引擎' });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)).ok, { label: '点歌台' });

    console.log('\n=== ① 真实接口自测（搜索 → 取链 → CDN） ===');
    const t = await post('/api/admin/qq/test', { q: KW, pin: '2468' });
    const tt = t.test || {};
    check('搜索命中', !!tt.song, tt.song);
    check('换到直链', !!tt.urlHost, `${tt.quality} @ ${tt.urlHost}`);
    check('CDN 可裸拉且是真音频', tt.ok === true, `HTTP ${tt.http} ${tt.format} ${tt.bytes}B ${tt.ms}ms`);

    console.log('\n=== ② 搜索（只看 QQ 这一路） ===');
    const s = await get(`/api/search?q=${encodeURIComponent(KW)}`);
    check('有结果', s.count > 0, `${s.count} 条`);
    check('来源都是 qq', (s.results || []).every((x) => x.source === 'qq' || x.cached), '首条 ' + (s.results[0] && s.results[0].source));
    (s.results || []).slice(0, 3).forEach((x) => console.log(`       ${x.name} — ${x.artist}  mid=${x.id} media=${x.mediaMid}`));

    console.log('\n=== ③ 点歌 → 下载 → 推流（GD 此时是死的） ===');
    const pick = s.results.find((x) => !x.cached) || s.results[0];
    await post('/api/enqueue', { song: pick, requester: '真机验收' });
    await waitFor(async () => {
      const st = await get('/api/state');
      return st.current && st.current.name === pick.name && st.current.status === 'playing';
    }, { label: '起播' });
    const st = await get('/api/state');
    check('播上了', true, `《${st.current.name}》${st.current.duration ? Math.round(st.current.duration) + 's' : ''}`);

    const files = fs.readdirSync(path.join(RUN_DIR, 'music')).filter((f) => /\.(mp3|flac)$/i.test(f));
    check('文件已落 NAS 曲库', files.length > 0, files.join(', '));
    const size = files.length ? fs.statSync(path.join(RUN_DIR, 'music', files[0])).size : 0;
    check('★ 是完整曲目不是试听片段', size > 2 * 1024 * 1024, `${(size / 1048576).toFixed(1)}MB`);
    check('★ 下载日志来源为 qq', appLog.join('').includes('← qq'), '日志「开始下载《…》← qq」');
    console.log(`       实测时长 ${st.current.duration ? Math.round(st.current.duration) + 's' : '未知'} / 文件 ${(size / 1048576).toFixed(1)}MB`);

    console.log('\n=== ④ 连点 3 首不崩（验证节流 + 并发） ===');
    for (const x of (s.results || []).slice(1, 4)) {
      await post('/api/enqueue', { song: x, requester: '真机验收' }).catch((e) => console.log('       enqueue 失败：' + e.message));
    }
    const q1 = await get('/api/state');
    check('队列里排上了', q1.queue.length > 0, `队列 ${q1.queue.length} 首`);
  } finally {
    kill();
    await sleep(300);
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n===== 结果：${pass}/${results.length} 通过${fail ? `，${fail} 失败` : '  🎉 全绿'} =====`);
  if (fail) {
    console.log('\n---- 服务端日志 ----');
    console.log(appLog.join('').split('\n').slice(-25).join('\n'));
  }
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常：', e.message);
  process.exit(1);
});

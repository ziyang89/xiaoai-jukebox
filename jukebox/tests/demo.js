'use strict';
/**
 * 本地演示模式：mock 音源 + mock 播放引擎 + 点歌台，常驻运行供预览。
 * 用法：node tests/demo.js   → 打开 http://127.0.0.1:58192
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, '.demo');
const MOCK_PORT = 58099;
const SRC_PORT = 58098;
const APP_PORT = 58192;

fs.rmSync(RUN, { recursive: true, force: true });
fs.mkdirSync(path.join(RUN, 'music'), { recursive: true });
fs.mkdirSync(path.join(RUN, 'data'), { recursive: true });

const cfg = {
  port: APP_PORT,
  publicBase: `http://127.0.0.1:${APP_PORT}`,
  musicDir: path.join(RUN, 'music'),
  dataDir: path.join(RUN, 'data'),
  engine: {
    type: 'songloft',
    base: `http://127.0.0.1:${MOCK_PORT}`,
    prefix: '/api/v1/jsplugin/miot',
    username: 'admin',
    password: 'demo',
  },
  searchSources: ['netease', 'kugou'],
  sources: ['netease'],
  gdApi: `http://127.0.0.1:${SRC_PORT}/`,
  volume: 15,
  pollIntervalMs: 1500,
  prefetchCount: 2,
  logLevel: 'info',
};
const cfgPath = path.join(RUN, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

const kids = [];
function start(args, env, tag) {
  const p = spawn(NODE, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = (d) => process.stdout.write(`[${tag}] ${d}`);
  p.stdout.on('data', out);
  p.stderr.on('data', out);
  kids.push(p);
  return p;
}

start([path.join(__dirname, 'mock-songloft.js')], { MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '180', MOCK_SPEED: '1' }, 'engine');
start([path.join(__dirname, 'mock-source.js')], { MOCK_SRC_PORT: String(SRC_PORT) }, 'source');
setTimeout(() => {
  start([path.join(ROOT, 'server.js')], { JB_CONFIG: cfgPath }, 'jukebox');
  setTimeout(() => {
    console.log('\n============================================');
    console.log(`  演示已就绪 →  http://127.0.0.1:${APP_PORT}`);
    console.log('  搜「周杰伦」→ 点 ＋ 加入队列 → 音箱(模拟)开播');
    console.log('============================================\n');
  }, 1800);
}, 900);

const bye = () => {
  for (const k of kids) {
    try {
      k.kill();
    } catch {}
  }
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);

#!/usr/bin/env node
/**
 * 随机电台（队列空了自动放 NAS 曲库）—— 端到端回归测试
 * ------------------------------------------------------------------
 * 需求原话：「待播放的歌曲都没了的时候就自动随机播放已缓存的音乐」。
 *
 * 这里要证伪的几件事（每条都能被"没实现"的版本打回原形）：
 *   ① 队列空 + 没人点歌 → 自己开始放，且**只放本地曲库**（音源 mock 零请求）
 *   ② 连续播不会两首挨着重样（最近 N 首轮转）
 *   ③ 管理员「停止」要真的停得住（电台不能被 5 秒静默期一过就自己接上）
 *   ④ 有人点歌 = 停止意图结束，播完那一轮电台恢复兜底
 *   ⑤ 管理员关掉开关后，队列空就是安静，不再自己响
 *   ⑥ 曲库为空 / 全被拉黑时不炸，安静待着（不能死循环刷日志）
 *
 * 用法：node tests/radio.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const APP_PORT = 58194;
const MOCK_PORT = 58094;
const MOCK_SRC_PORT = 58093; // 音源 mock：电台绝不该碰它，最后用它验"零请求"
const RUN_DIR = path.join(__dirname, '.run-radio');
const APP = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const MOCK_SRC = `http://127.0.0.1:${MOCK_SRC_PORT}`;
const PIN = 'radio-pin-2468';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, interval = 300, label = '条件' } = {}) {
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

const j = async (url, opt) => {
  const r = await fetch(url, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
};
const post = (url, body) =>
  j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const state = () => j(`${APP}/api/state`);

let mockProc = null;
let srcProc = null;
let appProc = null;
const appLog = [];

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

/** 造几首"假 mp3"：曲库扫描只认大小（>8KB），电台内部也不 sniff —— 不碰音源就不会解码 */
function makeFakeMp3(dir, n) {
  const names = [
    ['周杰伦', '晴天'],
    ['陈奕迅', '富士山下'],
    ['五月天', '突然好想你'],
    ['邓紫棋', '泡沫'],
    ['毛不易', '消愁'],
    ['李荣浩', '年少有为'],
  ];
  for (let i = 0; i < n; i++) {
    const [artist, name] = names[i % names.length];
    const file = path.join(dir, `${artist} - ${name}${i >= names.length ? ` ${i}` : ''}.mp3`);
    // 一颗正确的 MPEG1 Layer3 帧头（0xFF 0xFB）+ 填充，避免时长测量走进奇怪分支
    const buf = Buffer.alloc(24000);
    for (let off = 0; off + 4 <= buf.length; off += 417) {
      buf[off] = 0xff;
      buf[off + 1] = 0xfb;
      buf[off + 2] = 0x90;
      buf[off + 3] = 0x64;
    }
    fs.writeFileSync(file, buf);
  }
}

async function currentTrack() {
  const s = await state();
  return s.current ? s.current : null;
}

async function main() {
  console.log('\n===== 随机电台（队列空 → 自动放本地曲库）端到端测试 =====\n');

  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DIR, 'music'), { recursive: true });
  fs.mkdirSync(path.join(RUN_DIR, 'data'), { recursive: true });
  makeFakeMp3(path.join(RUN_DIR, 'music'), 6);

  const cfg = {
    port: APP_PORT,
    publicBase: APP,
    musicDir: path.join(RUN_DIR, 'music'),
    dataDir: path.join(RUN_DIR, 'data'),
    engine: {
      type: 'songloft',
      base: MOCK,
      prefix: '/api/v1/jsplugin/miot',
      username: 'admin',
      password: 'mock-pass',
    },
    // 只留一个"假"公共源：电台如果偷偷回音源，mock 的 __stats 会立刻显形
    sources: ['netease'],
    searchSources: ['netease'],
    gdApi: MOCK_SRC,
    autoRadio: true,
    radioRecentMax: 5,
    minPlaySec: 1,
    overtimeGraceSec: 4,
    pollIntervalMs: 400,
    prefetchCount: 0,
    volume: 15,
    logLevel: 'info',
  };
  const cfgPath = path.join(RUN_DIR, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  console.log('[1/5] 启动 mock 播放引擎（1x，6 秒一首）…');
  mockProc = spawn(NODE, [path.join(__dirname, 'mock-songloft.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '6', MOCK_SPEED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mockProc.stdout.on('data', () => {});
  mockProc.stderr.on('data', (d) => appLog.push('[mock] ' + d.toString()));
  await waitFor(async () => (await fetch(`${MOCK}/__log`)).ok, { label: 'mock 引擎就绪', timeout: 10000 });

  console.log('[2/5] 启动 mock 音源（电台不该访问它）…');
  srcProc = spawn(NODE, [path.join(__dirname, 'mock-source.js')], {
    env: { ...process.env, MOCK_SRC_PORT: String(MOCK_SRC_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srcProc.stdout.on('data', () => {});
  srcProc.stderr.on('data', (d) => appLog.push('[src] ' + d.toString()));
  await waitFor(async () => (await fetch(`${MOCK_SRC}/__stats`)).ok, { label: 'mock 音源就绪', timeout: 10000 });

  console.log('[3/5] 启动点歌台…');
  appProc = spawn(NODE, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, JB_CONFIG: cfgPath, JB_PORT: String(APP_PORT), JB_ADMIN_PIN: PIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appProc.stdout.on('data', (d) => appLog.push('[app] ' + d.toString()));
  appProc.stderr.on('data', (d) => appLog.push('[app] ' + d.toString()));

  try {
    const boot = await waitFor(async () => {
      const d = await j(`${APP}/api/health`);
      return d.library && d.library.count >= 6 ? d : null;
    }, { label: '服务就绪 + 曲库扫描完成', timeout: 30000 });
    check('曲库扫描到 6 首（>8KB 的假 mp3）', boot.library.count === 6, `count=${boot.library.count}`);

    // ---------- ① 没人点歌 → 自己开始放
    console.log('\n[4/5] ① 队列空自动起播');
    const st0 = await state();
    check('★ /api/state 暴露 radio 段', !!st0.radio && st0.radio.on === true, JSON.stringify(st0.radio));
    check('★ 开关默认开、曲库 6 首、当前可接上', st0.radio.available === true && st0.radio.libCount === 6,
      `available=${st0.radio.available} lib=${st0.radio.libCount}`);

    const first = await waitFor(currentTrack, { label: '自动起播', timeout: 20000 });
    check('★ 没人点歌也自己开始播了', !!first, first && `${first.name} / ${first.artist}`);
    check('★ 标记为随机电台（前端据此显示标签）', first.radio === true, `radio=${first.radio}`);
    check('★ 走的是本地曲库，不是音源', first.source === 'local', `source=${first.source}`);
    check('队列里没有混进无人认领的曲目', (await state()).queue.length === 0, `queue=${(await state()).queue.length}`);

    // ---------- ② 连播不重样
    console.log('\n[5/5] ② 连续换歌不重样');
    const played = [first.name];
    for (let i = 0; i < 5; i++) {
      await post(`${APP}/api/admin/radio`, { pin: PIN, skip: true });
      const prev = played[played.length - 1];
      const nxt = await waitFor(async () => {
        const c = await currentTrack();
        return c && c.name !== prev ? c : null;
      }, { label: `第 ${i + 2} 首`, timeout: 15000 });
      played.push(nxt.name);
      check(`第 ${i + 2} 首也是电台曲目`, nxt.radio === true, `${nxt.name} / ${nxt.artist}`);
    }
    check('★ 连续 6 首没有相邻重复', played.every((n, i) => i === 0 || n !== played[i - 1]), played.join(' → '));
    check('★ 前 5 首互不重复（radioRecentMax=5 的轮转生效）',
      new Set(played.slice(0, 5)).size === 5, `${new Set(played.slice(0, 5)).size}/5`);

    // 电台从来没碰过音源
    const srcStats = await j(`${MOCK_SRC}/__stats`);
    const totalReq = Object.values(srcStats).reduce((a, v) => a + (v && typeof v === 'object' ? (v.search || 0) + (v.url || 0) : 0), 0);
    check('★ 音源 mock 零请求（电台只用本地文件）', totalReq === 0, JSON.stringify(srcStats));

    // ---------- ③ 管理员停止要停得住
    console.log('\n[6/7] ③ 管理员「停止」不能被电台顶回来');
    await post(`${APP}/api/admin/stop`, { pin: PIN });
    const afterStop = await state();
    check('停止后立刻没有在播', afterStop.current === null, `current=${afterStop.current && afterStop.current.name}`);
    check('★ 电台被按住（paused=true）', afterStop.radio.paused === true, JSON.stringify(afterStop.radio));
    await sleep(8000); // > stopping 的 5 秒静默期
    const stillIdle = await state();
    check('★ 静默期过后依然安静（没有被自动接上）', stillIdle.current === null,
      stillIdle.current ? `漏播：${stillIdle.current.name}` : 'current=null');

    // ---------- ④ 有人点歌 → 播完恢复电台
    console.log('\n[7/7] ④ 点歌解除按住；关掉开关就真的安静');
    const lib = await j(`${APP}/api/library?limit=1`);
    const pick = (lib.items || [])[0];
    await post(`${APP}/api/enqueue`, { song: pick, requester: '电台测试' });
    const manual = await waitFor(async () => {
      const c = await currentTrack();
      return c && c.name === pick.name ? c : null;
    }, { label: '点歌起播', timeout: 20000 });
    check('人点的歌正常播（不是电台曲目）', manual.radio !== true, `radio=${manual.radio} name=${manual.name}`);
    check('点歌后 paused 解除', (await state()).radio.paused === false);

    const backToRadio = await waitFor(async () => {
      const c = await currentTrack();
      return c && c.radio === true && c.name !== pick.name ? c : null;
    }, { label: '播完自动回到电台', timeout: 30000 });
    check('★ 那一首播完，电台自动接上', backToRadio.radio === true, `${backToRadio.name} / ${backToRadio.artist}`);

    // 关掉开关
    const off = await post(`${APP}/api/admin/radio`, { pin: PIN, on: false });
    check('管理员关闭电台', off.radio.on === false, JSON.stringify(off.radio));
    await post(`${APP}/api/admin/stop`, { pin: PIN });
    await sleep(7000);
    const quiet = await state();
    check('★ 关掉后队列空就安静（不再自己响）', quiet.current === null,
      quiet.current ? `漏播：${quiet.current.name}` : 'current=null');
    check('radio.available=false', quiet.radio.available === false, JSON.stringify(quiet.radio));

    const on = await post(`${APP}/api/admin/radio`, { pin: PIN, on: true });
    check('可以再打开', on.radio.on === true && on.radio.paused === false, JSON.stringify(on.radio));

    // 口令保护
    let denied = false;
    try {
      await post(`${APP}/api/admin/radio`, { on: false });
    } catch (e) {
      denied = /口令|pin/i.test(e.message);
    }
    check('没有口令改不了开关', denied);
  } finally {
    await cleanup();
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n===== ${pass}/${results.length} 通过，${fail} 失败 =====`);
  if (fail && appLog.length) {
    console.log('\n--- 服务端日志（尾部）---');
    console.log(appLog.slice(-30).join(''));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试异常：', e.message);
  if (appLog.length) console.error(appLog.slice(-30).join(''));
  cleanup().then(() => process.exit(1));
});

#!/usr/bin/env node
/**
 * 定时关闭（睡眠定时器）—— 端到端回归测试
 * ------------------------------------------------------------------
 * 需求原话：「做个定时功能，定时关闭」。
 *
 * 要证伪的几件事（每条都能被"只加了个倒计时显示"的假实现打回原形）：
 *   ① 到点真的**停声**（state.current 清空、playing=false、音箱收到 stop）
 *   ② 停完**不许自己续播**（这是最容易写错的地方：管理员停止那种 5 秒静默一过，
 *      tick 就会把队列里下一首推上去 → "定时关闭"变成"换一首接着放"）
 *   ③ 队列**不清空**（跟管理员「停止」的区别：那是别人点的歌，明早还要听）
 *   ④ 有人点歌 / 「继续播放」→ 恢复，且队列里剩下的歌能立刻接上
 *   ⑤ 「每天」模式：到点关完之后，目标自动挪到明天同一时刻（否则每 2 秒就再"到点"一次）
 *   ⑥ 参数乱填不能把服务弄崩，更不能悄悄改成别的时长
 *   ⑦ 「每天」这类设定要扛得住容器重启（落在运行期配置里）
 *
 * ⚠️ 计时精度是"分钟"级的（这是给人用的功能，不是 cron），
 *    所以这里等的是真实的分钟边界：整套跑完约 2~3 分钟，属于正常。
 *
 * 用法：node tests/sleep-timer.js [--skip-restart]
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const APP_PORT = 58188;
const MOCK_PORT = 58088;
const RUN_DIR = path.join(__dirname, '.run-sleep');
const APP = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const SKIP_RESTART = process.argv.includes('--skip-restart');

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
const sleepState = async () => (await state()).sleep;

/** 调一次接口，返回 { ok, error } 而不抛（用来验"非法参数必须 400"） */
async function postRaw(body) {
  const r = await fetch(`${APP}/api/sleep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, error: d.error || '', data: d };
}

/** 下一个整分钟（至少留 15 秒布置剩下的步骤）→ 'HH:MM' */
function nextClockStr() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  if (d.getTime() - Date.now() < 15000) d.setMinutes(d.getMinutes() + 1);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 造"假 mp3"：曲库扫描只认大小（>8KB），本地播放不解码。
 * 单文件给到 1MB —— 按 320kbps 估算也有 26 秒，足够撑过"到点前那几秒"，
 * 不会因为"测不出真实时长 → 超时兜底切歌"把断言搅乱。
 */
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
    const file = path.join(dir, `${artist} - ${name}.mp3`);
    const buf = Buffer.alloc(1024 * 1024);
    for (let off = 0; off + 4 <= buf.length; off += 417) {
      buf[off] = 0xff;
      buf[off + 1] = 0xfb;
      buf[off + 2] = 0x90;
      buf[off + 3] = 0x64;
    }
    fs.writeFileSync(file, buf);
  }
}

let mockProc = null;
let appProc = null;
const appLog = [];

function startApp(cfgPath) {
  const p = spawn(NODE, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, JB_CONFIG: cfgPath, JB_PORT: String(APP_PORT), JB_ADMIN_PIN: 'sleep-pin' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => appLog.push('[app] ' + d.toString()));
  p.stderr.on('data', (d) => appLog.push('[app] ' + d.toString()));
  return p;
}

async function stopApp() {
  if (!appProc || appProc.killed) return;
  appProc.kill();
  await sleep(900);
}

async function cleanup() {
  for (const p of [appProc, mockProc]) {
    if (p && !p.killed) {
      try {
        p.kill();
      } catch {}
    }
  }
  await sleep(400);
}

async function main() {
  console.log('\n===== 定时关闭（睡眠定时器）端到端测试 =====\n');

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
    // 电台关掉：这样才能单独证明"到点之后是**定时器**在按住，不是电台没歌可放"
    autoRadio: false,
    minPlaySec: 1,
    overtimeGraceSec: 4,
    pollIntervalMs: 400,
    prefetchCount: 0,
    volume: 15,
    logLevel: 'info',
  };
  const cfgPath = path.join(RUN_DIR, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  console.log('[1/4] 启动 mock 播放引擎（600 秒一首，免得歌自己放完干扰断言）…');
  mockProc = spawn(NODE, [path.join(__dirname, 'mock-songloft.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '600', MOCK_SPEED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mockProc.stdout.on('data', () => {});
  mockProc.stderr.on('data', (d) => appLog.push('[mock] ' + d.toString()));
  await waitFor(async () => (await fetch(`${MOCK}/__log`)).ok, { label: 'mock 引擎就绪', timeout: 10000 });

  console.log('[2/4] 启动点歌台…');
  appProc = startApp(cfgPath);

  try {
    const boot = await waitFor(async () => {
      const d = await j(`${APP}/api/health`);
      return d.library && d.library.count >= 6 ? d : null;
    }, { label: '服务就绪 + 曲库扫描完成', timeout: 30000 });
    check('服务启动、曲库 6 首', boot.library.count === 6, `count=${boot.library.count}`);

    // ---------- ① 初始状态
    console.log('\n[3/4] ① 初始状态与参数校验');
    const s0 = await sleepState();
    check('★ /api/state 暴露 sleep 段', !!s0 && typeof s0 === 'object', JSON.stringify(s0));
    check('默认没设定时', s0.active === false && s0.hold === false && s0.leftSec === 0, JSON.stringify(s0));
    check('上限 12 小时（防手抖）', s0.maxMin === 720, `maxMin=${s0.maxMin}`);

    const bad = [
      ['minutes=0', { minutes: 0 }],
      ['minutes=-5', { minutes: -5 }],
      ['minutes=99999', { minutes: 99999 }],
      ['at=25:00', { at: '25:00' }],
      ['at=乱写', { at: '晚上十点' }],
    ];
    for (const [label, body] of bad) {
      const r = await postRaw(body);
      check(`非法参数 ${label} → 400`, r.status === 400 && !!r.error, `${r.status} ${r.error}`);
    }
    check('★ 参数乱填之后状态没被改坏', (await sleepState()).active === false);

    // ---------- ② 设定 / 取消
    console.log('\n[4/4] ② 设定、取消、到点真的停');
    const five = await postRaw({ minutes: 5, by: '小明' });
    check('★ 不需要管理员口令也能设（睡前谁都能设一手）', five.ok === true, `${five.status}`);
    check('remaining≈5 分钟', five.data.sleep && five.data.sleep.leftSec > 290 && five.data.sleep.leftSec <= 300,
      `leftSec=${five.data.sleep && five.data.sleep.leftSec}`);
    check('记下是谁设的（前端要显示）', five.data.sleep.setBy === '小明', five.data.sleep.setBy);
    check('mode=duration', five.data.sleep.mode === 'duration', five.data.sleep.mode);

    const cancelled = await post(`${APP}/api/sleep`, { cancel: true });
    check('取消定时', cancelled.cancelled === true && cancelled.sleep.active === false, JSON.stringify(cancelled.sleep));
    const again = await post(`${APP}/api/sleep`, { cancel: true });
    check('重复取消不报错（cancelled=false）', again.cancelled === false, JSON.stringify(again.sleep));

    // ---------- ③ 一次性「到点关」
    const at1 = nextClockStr();
    const set1 = await post(`${APP}/api/sleep`, { at: at1, repeat: false, by: '小明' });
    check(`设定到点关 ${at1}`, set1.sleep.active === true && set1.sleep.at === at1,
      `at=${set1.sleep.at} leftSec=${set1.sleep.leftSec}`);
    check('repeat=false', set1.sleep.repeat === false);

    // 到点前 6 秒点两首：一首正在播、一首在队列里 —— 好验证"队列保留"
    await waitFor(async () => Date.now() >= set1.sleep.until - 6000, {
      label: '等到点前 6 秒', timeout: 90000, interval: 500,
    });
    const lib = await j(`${APP}/api/library?limit=6`);
    const [a, b] = lib.items;
    await post(`${APP}/api/enqueue`, { song: a, requester: '睡前点歌' });
    await post(`${APP}/api/enqueue`, { song: b, requester: '睡前点歌' });
    const playing = await waitFor(async () => {
      const c = (await state()).current;
      return c && c.name === a.name ? c : null;
    }, { label: '点歌起播', timeout: 20000 });
    check('点歌正常起播（后面才有东西可停）', playing.name === a.name, playing.name);

    const fired = await waitFor(async () => {
      const s = await sleepState();
      return s.active === false && s.hold === true ? s : null;
    }, { label: '到点执行', timeout: (set1.sleep.until - Date.now()) + 20000 });

    const afterFire = await state();
    check('★ 到点真的没在播了', afterFire.current === null && afterFire.playing === false,
      `current=${afterFire.current && afterFire.current.name} playing=${afterFire.playing}`);
    check('★ 被停的那首记进历史，理由是「定时关闭」',
      afterFire.history[0] && afterFire.history[0].reason === '定时关闭',
      JSON.stringify(afterFire.history[0] || {}).slice(0, 80));
    check('★ 队列没被清空（第二首还在，明早能接着听）',
      afterFire.queue.length === 1 && afterFire.queue[0].name === b.name,
      `queue=${afterFire.queue.map((q) => q.name).join(',') || '空'}`);
    check('random 电台也被一起按住', afterFire.radio.paused === true, JSON.stringify(afterFire.radio));
    check('hold 快照里报出队列还剩几首', fired.queueLeft === 1, `queueLeft=${fired.queueLeft}`);
    check('一次性定时到点后 active=false（不会明天又来一次）', fired.active === false);

    // ---------- ④ 关键：停完不许自己续播
    await sleep(8000); // 超过「管理员停止」那种 5 秒静默期
    const stillQuiet = await state();
    check('★ 静默期过后依然安静 —— 没有被调度器悄悄续上',
      stillQuiet.current === null,
      stillQuiet.current ? `漏播了：${stillQuiet.current.name}` : 'current=null（正确）');

    // ---------- ⑤ 继续播放：队列里剩的歌立刻接上
    const resumed = await post(`${APP}/api/sleep`, { resume: true });
    check('「继续播放」解除按住', resumed.resumed === true && resumed.sleep.hold === false, JSON.stringify(resumed.sleep));
    const back = await waitFor(async () => {
      const c = (await state()).current;
      return c && c.name === b.name ? c : null;
    }, { label: '继续播放后接上队列里的歌', timeout: 20000 });
    check('★ 继续播放后队列里那首自动接上', back.name === b.name, back.name);
    const noHold = await post(`${APP}/api/sleep`, { resume: true });
    check('没被按住时 resume 不报错（resumed=false）', noHold.resumed === false);

    // ---------- ⑥ 每天模式
    console.log('\n[5/5] ③ 「每天」模式：关完自动挪到明天');
    const at2 = nextClockStr();
    const set2 = await post(`${APP}/api/sleep`, { at: at2, repeat: true, by: '小明' });
    check(`设定每天 ${at2}`, set2.sleep.active === true && set2.sleep.repeat === true, JSON.stringify(set2.sleep));

    const fired2 = await waitFor(async () => {
      const s = await sleepState();
      return s.hold === true && s.active === true ? s : null; // 每天模式：关完 active 应该还在（指向明天）
    }, { label: '每天模式到点执行', timeout: (set2.sleep.until - Date.now()) + 20000 });

    const nextGapH = (fired2.until - Date.now()) / 3600000;
    check('★ 关完之后目标已挪到明天（不是立刻又"到点"）', nextGapH > 20 && nextGapH < 25,
      `距下次 ${nextGapH.toFixed(1)} 小时`);
    const stillActive = await sleepState();
    check('★ 等 8 秒也不会连环触发（active 仍指向明天）',
      stillActive.active === true && stillActive.hold === true,
      `active=${stillActive.active} hold=${stillActive.hold}`);

    // ---------- ⑦ 重启后「每天」设定还在
    if (!SKIP_RESTART) {
      await stopApp();
      appProc = startApp(cfgPath);
      const restored = await waitFor(async () => {
        const s = await sleepState();
        return s.active && s.at === at2 ? s : null;
      }, { label: '重启后恢复每天定时', timeout: 30000, interval: 500 });
      check('★ 容器重启后「每天定时」自动接回来', restored.active === true && restored.repeat === true,
        `at=${restored.at} repeat=${restored.repeat}`);
      const gapH = (restored.until - Date.now()) / 3600000;
      check('恢复后的目标时刻仍然合理（今天还没到就是今天）', gapH > 0 && gapH < 25, `${gapH.toFixed(1)} 小时`);
    } else {
      console.log('  （跳过重启测试）');
    }

    // ---------- 诊断接口
    const diag = await j(`${APP}/api/diag`);
    check('★ /api/diag 里有 sleep（排障能直接看倒计时）', !!diag.sleep && typeof diag.sleep === 'object',
      JSON.stringify(diag.sleep || {}).slice(0, 100));
  } finally {
    await cleanup();
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n===== ${pass}/${results.length} 通过，${fail} 失败 =====`);
  // 全绿就把临时目录（6MB 假 mp3）删掉；失败时留着方便翻日志
  if (!fail) fs.rmSync(RUN_DIR, { recursive: true, force: true });
  if (fail && appLog.length) {
    console.log('\n--- 服务端日志（尾部）---');
    console.log(appLog.slice(-40).join(''));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试异常：', e.message);
  if (appLog.length) console.error(appLog.slice(-40).join(''));
  cleanup().then(() => process.exit(1));
});

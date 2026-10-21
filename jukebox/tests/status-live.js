#!/usr/bin/env node
/**
 * 「正在播放」进度相关的两个真机 bug —— 端到端回归测试
 * ------------------------------------------------------------------
 * 两次用户报障（2026-10-16 / 10-17）都出在同一个地方：**这台音箱的状态接口会撒谎**。
 *
 * 本测试让 mock 引擎复现真机的四种特征（默认全关，测试里显式打开）：
 *   ① `is_playing` 恒为 false，只有 `state` 字符串可信；
 *   ② 播放中周期性闪一次 `{state:"idle", position:0, duration:0}`；
 *   ③ 刚推流时回的是上一首的残留进度；
 *   ④ ⚠️ 那个残留值**还在继续往前走**（实测 190 → 202，上一首的流没断干净）。
 *
 * 两个回合：
 *   A 回（来回跳）：开了闪烁 → 断言发布进度不回退、闪烁帧不归零；
 *   B 回（时间不动）：开了"会动的残留值" → 断言假值从不发布、界面**不卡死**、发布值始终贴着真实进度。
 *
 * 通用硬指标：发布值**永远不能显著超前**真实进度（`pub > raw + lead` 就是卡死的症状）。
 *
 * 用法：node tests/status-live.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const APP_PORT = 58188;
const MOCK_PORT = 58086; // 播放引擎 mock
const MOCK_SRC_PORT = 58085; // 音源 mock
const RUN_DIR = path.join(__dirname, '.run-status');
const APP = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

/** 挂钟校准规则的容差（和 server.js 的 statusLeadSec 默认值一致） */
const LEAD = 8;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 400, label = '条件' } = {}) {
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
const statusMode = (body) => post(`${MOCK}/__statusMode`, body);

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

/** 密集采样 /api/state + /api/diag */
async function sample(seconds) {
  const samples = [];
  const diagShots = [];
  const t0 = Date.now();
  let trackKey = null;
  while (Date.now() - t0 < seconds * 1000) {
    let s;
    try {
      s = await state();
    } catch {
      await sleep(300);
      continue;
    }
    const key = s.current ? s.current.qid || s.current.name : null;
    if (trackKey === null) trackKey = key;
    samples.push({
      t: Math.round((Date.now() - t0) / 1000),
      track: key,
      pos: s.status ? s.status.position : null,
      dur: s.status ? s.status.duration : null,
      held: s.status ? !!s.status.held : false,
      live: s.status ? !!s.status.live : false,
      rawPos: s.status ? s.status.rawPos : null,
    });
    try {
      const d = await j(`${APP}/api/diag`);
      if (d.lastRaw && d.lastStatus) {
        diagShots.push({
          t: Math.round((Date.now() - t0) / 1000),
          rawPos: d.lastRaw.position,
          rawState: d.lastRaw.state,
          pubPos: d.lastStatus.position,
          held: !!d.lastStatus.held,
        });
      }
    } catch {}
    await sleep(350);
  }
  return { samples: samples.filter((x) => x.pos !== null && x.track), diagShots };
}

async function enqueueFor(keyword) {
  const q = encodeURIComponent(keyword);
  const found = await j(`${APP}/api/search?q=${q}&limit=3`);
  const song = (found.results || found.songs || [])[0];
  if (!song) throw new Error(`mock 音源搜不到「${keyword}」`);
  await post(`${APP}/api/enqueue`, { song, requester: '防跳测试' });
  await waitFor(async () => {
    const s = await state();
    return s.current && s.current.status === 'playing' ? s : null;
  }, { label: `《${song.name}》开始播放`, timeout: 30000 });
  return song;
}

async function waitIdle(timeoutMs) {
  return waitFor(async () => {
    const s = await state();
    return !s.current && s.queue.length === 0 ? s : null;
  }, { label: '队列清空', timeout: timeoutMs });
}

function fmt(list) {
  return list.map((x) => `${x.pos}${x.held ? '*' : ''}`).join(' → ');
}

/** 硬指标：发布值不得显著超前真实进度（卡死的直接症状） */
function leadViolations(list) {
  return list.filter((x) => x.rawPos !== null && x.rawPos > 0.5 && x.pos > x.rawPos + LEAD + 1);
}

function regressions(list) {
  const bad = [];
  for (let i = 1; i < list.length; i++) {
    if (list[i].track === list[i - 1].track && list[i].pos < list[i - 1].pos - 0.5) {
      bad.push(`${list[i].t}s: ${list[i - 1].pos}→${list[i].pos}`);
    }
  }
  return bad;
}

async function main() {
  console.log('\n===== 进度条「来回跳 + 时间不动」端到端测试（mock 模拟真机脏数据）=====\n');

  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DIR, 'music'), { recursive: true });
  fs.mkdirSync(path.join(RUN_DIR, 'data'), { recursive: true });

  // MOCK_SPEED=1：**必须**按 1x 走 —— 挂钟校准规则假设"进度 1 秒/秒"，
  // 倍速播放（8x）在真机上不存在，用它测反而会触发规则的误拦。
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
    searchSources: ['netease'],
    sources: ['netease'],
    gdApi: `http://127.0.0.1:${MOCK_SRC_PORT}/`,
    retry: 2,
    volume: 0, // 测试不打扰音箱
    pollIntervalMs: 500, // 轮询快一点，短时间能抓到多次闪烁
    minPlaySec: 0,
    overtimeGraceSec: 5,
    prefetchCount: 0,
    statusBlipHold: 3,
    statusLeadSec: LEAD,
    logLevel: 'info',
  };
  const cfgPath = path.join(RUN_DIR, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  console.log('[1/4] 启动 mock 播放引擎（1x 播放，20 秒一首）…');
  mockProc = spawn(NODE, [path.join(__dirname, 'mock-songloft.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '20', MOCK_SPEED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mockProc.stdout.on('data', () => {});
  mockProc.stderr.on('data', (d) => appLog.push('[mock] ' + d.toString()));
  await waitFor(async () => (await fetch(`${MOCK}/__log`)).ok, { label: 'mock 就绪', timeout: 10000 });

  console.log('[2/4] 启动 mock 音源…');
  srcProc = spawn(NODE, [path.join(__dirname, 'mock-source.js')], {
    env: { ...process.env, MOCK_SRC_PORT: String(MOCK_SRC_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srcProc.stdout.on('data', () => {});
  srcProc.stderr.on('data', () => {});
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_SRC_PORT}/?types=search&name=x&count=1`)).ok,
    { label: 'mock 音源就绪', timeout: 10000 });

  console.log('[3/4] 启动点歌台…');
  appProc = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, JB_CONFIG: cfgPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appProc.stdout.on('data', (d) => appLog.push(d.toString()));
  appProc.stderr.on('data', (d) => appLog.push(d.toString()));
  await waitFor(async () => (await j(`${APP}/api/health`)).ok, { label: '点歌台就绪', timeout: 20000 });
  await waitFor(async () => (await state()).engineOk, { label: '引擎就绪', timeout: 15000 });

  // ==================================================================
  // A 回：idle 闪烁 → 「来回跳」
  // ==================================================================
  console.log('\n[4/4] ── A 回：idle 闪烁（10-16 的「来回跳」）──');
  const modeA = await statusMode({ realistic: true, blipEvery: 4, residualSec: 0 });
  check('mock 已切到「idle 闪烁」模式', modeA.realistic === true && modeA.blipEvery === 4, JSON.stringify(modeA));

  const songA = await enqueueFor('测试');
  check('A 回点歌成功', !!songA, `${songA.name} / ${songA.artist}`);

  const A = await sample(10);
  console.log('    发布值：' + fmt(A.samples));
  const aBlips = A.samples.filter((x) => x.rawPos !== null && x.rawPos <= 0.5);
  const aHeld = A.samples.filter((x) => x.held);
  const aLive = A.samples.findIndex((x) => x.live === true);
  const aHeldDuringPlay = A.samples.slice(Math.max(0, aLive)).filter((x) => x.held);

  check('A 回：接口原始值确实归零过（证明闪烁真的发生了）', aBlips.length >= 2, `${aBlips.length} 帧 rawPos=0`);
  check('A 回：确实抓到了 held 帧', aHeld.length >= 2, `${aHeld.length} 帧`);
  check('★ A 回：起播后没有任何 held 帧把进度打成 0',
    aHeldDuringPlay.length > 0 && aHeldDuringPlay.every((x) => x.pos > 0),
    `${aHeldDuringPlay.length} 帧全部 > 0`);
  check('★ A 回：发布进度全程不回退', regressions(A.samples).length === 0,
    regressions(A.samples).slice(0, 3).join(' , ') || 'no regression');
  check('★ A 回：发布值从未显著超前真实进度', leadViolations(A.samples).length === 0,
    leadViolations(A.samples).map((x) => `${x.t}s pub=${x.pos} raw=${x.rawPos}`).join(',') || 'none');
  const aSmoking = A.diagShots.filter((x) => x.rawPos !== null && x.rawPos <= 0.5 && x.pubPos > 0);
  check('★ A 回铁证：接口报 position=0 的那一刻，发布值仍是非零真实进度',
    aSmoking.length > 0,
    aSmoking.length ? `${aSmoking.length} 帧，例：raw=0(${aSmoking[0].rawState}) → 发布 ${aSmoking[0].pubPos}` : '未抓到');

  // 等这首放完（顺带验证判定层照常工作）
  const histA = await waitFor(async () => {
    const s = await state();
    return s.history && s.history.length ? s : null;
  }, { label: 'A 回：这首播完并进历史', timeout: 60000 });
  check('★ A 回：判定层照常判「播完」（平滑只影响展示）', histA.history.length >= 1,
    `历史首条：${histA.history[0].name}（${histA.history[0].reason || '?'}）`);
  await waitIdle(40000);

  // ==================================================================
  // B 回：「会动的」残留值 → 「时间不动了」
  // ==================================================================
  console.log('\n── B 回：「会动的」残留值（10-17 的「时间不动了」）──');
  const modeB = await statusMode({ realistic: true, blipEvery: 0, residualSec: 180, residualMs: 1500 });
  check('mock 已切到「会动的残留值」模式（180 起，还在往前走）',
    modeB.realistic === true && modeB.residualSec === 180, JSON.stringify(modeB));

  const songB = await enqueueFor('测试');
  check('B 回点歌成功', !!songB, `${songB.name} / ${songB.artist}`);

  const B = await sample(12);
  console.log('    发布值：' + fmt(B.samples));
  const bFake = B.samples.filter((x) => x.rawPos !== null && x.rawPos >= 100);
  const bReal = B.samples.filter((x) => x.rawPos !== null && x.rawPos < 100);

  check('B 回：接口确实报过那个假进度（≥180s，证明条件被真实触发）', bFake.length >= 2,
    `${bFake.length} 帧，样例 ${[...new Set(bFake.map((x) => x.rawPos))].slice(0, 5).join('/')}`);
  check('★ B 回：假进度从来没被发布给前端（残留值一帧都不露面）',
    bFake.length > 0 && bFake.every((x) => x.pos === 0),
    `发布值 ${[...new Set(bFake.map((x) => x.pos))].join('/') || '-'}`);
  check('★ B 回：进度没被粘死 —— 发布值始终贴着真实进度（差距 ≤ 2s）',
    bReal.length > 3 && Math.abs(bReal[bReal.length - 1].pos - bReal[bReal.length - 1].rawPos) <= 2,
    `末帧 发布 ${bReal.length ? bReal[bReal.length - 1].pos : '-'} / 真实 ${bReal.length ? bReal[bReal.length - 1].rawPos : '-'}`);
  check('★ B 回：进度确实在往前走（时间不是停的）',
    bReal.length > 3 && bReal[bReal.length - 1].pos > bReal[2].pos + 4,
    `${bReal.length ? bReal[2].pos : '-'} → ${bReal.length ? bReal[bReal.length - 1].pos : '-'}`);
  check('★ B 回：发布进度全程不回退', regressions(B.samples).length === 0,
    regressions(B.samples).slice(0, 3).join(' , ') || 'no regression');
  check('★ B 回：发布值从未显著超前真实进度', leadViolations(B.samples).length === 0,
    leadViolations(B.samples).map((x) => `${x.t}s pub=${x.pos} raw=${x.rawPos}`).join(',') || 'none');
  const bSmoking = B.diagShots.filter((x) => x.rawPos !== null && x.rawPos >= 100 && x.pubPos <= 1);
  check('★ B 回铁证：接口报 180+ 的那一刻，发布值是 0（假值被挂钟规则拦下）',
    bSmoking.length > 0,
    bSmoking.length ? `${bSmoking.length} 帧，例：raw=${bSmoking[0].rawPos} → 发布 ${bSmoking[0].pubPos}` : '未抓到');

  // ---- 诊断层仍然看得到原始值 ----
  const diag = await j(`${APP}/api/diag`);
  check('诊断接口同时给出原始值与发布值（排障不被平滑挡住）',
    diag.lastRaw !== undefined && diag.lastStatus !== undefined,
    `lastRaw.pos=${diag.lastRaw && diag.lastRaw.position} vs lastStatus.pos=${diag.lastStatus && diag.lastStatus.position}`);

  // ---------- 汇总 ----------
  const okN = results.filter((r) => r.ok).length;
  console.log(`\n===== 结果：${okN}/${results.length} 通过 =====`);
  if (okN !== results.length) {
    console.log('\n失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ❌ ${r.name} — ${r.detail}`));
    console.log('\n服务端日志尾部：\n' + appLog.join('').split('\n').slice(-30).join('\n'));
  }
  await cleanup();
  process.exit(okN === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n测试异常终止：', e);
  console.log('\n服务端日志尾部：\n' + appLog.join('').split('\n').slice(-30).join('\n'));
  await cleanup();
  process.exit(1);
});

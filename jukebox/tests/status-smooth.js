#!/usr/bin/env node
/**
 * 进度条防跳（展示层平滑）回归测试
 * ------------------------------------------------------------------
 * 背景：用户反馈「正在播放会来回跳」——进度条在 29% / 2% 之间反复弹，
 * 秒数在 `2:25` 和 `--:--` 之间闪。
 *
 * 真机（小米 Sound Pro + songloft）录到的原始序列是：
 *   ① 刚推流时 position 是**上一首的残留值**（92.37），3 次都不动；
 *   ② 播放中大约每 7 秒闪一次 `{state:"idle", position:0, duration:0}`（单次）。
 *
 * 本测试把**逐帧原始读数**同时喂给 `decideEnd`（判定层）
 * 与 `smoothDisplayStatus`（展示层），断言：
 *   - 展示层：残留值不发布、闪烁不归零、不回退、换歌才重置；
 *   - 判定层：一切照旧（绝不因为平滑而漏判/误判「播完」）。
 *
 * 跑法：node tests/status-smooth.js
 */
'use strict';

const { parseStatus, decideEnd, makeDisplayStatus, smoothDisplayStatus } = require('../server.js');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${extra ? '  · ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? '  · ' + extra : ''}`);
  }
}

// ---- 真机原始状态构造器（字段名照抄插件返回） ----
const raw = (state, position, duration, volume = 10) => ({
  state,
  play_mode: 'order',
  playlist_id: 0,
  current_index: 0,
  position,
  duration,
  is_playing: false,   // ⚠️ 这台设备恒为 false，不可信
  speed: 1,
  volume,
});

/**
 * 模拟一次 tick()：原始读数 → parseStatus → decideEnd → smoothDisplayStatus
 * @returns {{pos:number, dur:number, held:boolean, live:boolean, verdict:object, rawPos:number}}
 */
function tick(engineState, sim) {
  const st = parseStatus(engineState);
  const elapsedMs = sim.now - sim.startedAt;
  const verdict = decideEnd(st, {
    obs: sim.obs,
    elapsedMs,
    measuredSec: sim.measuredSec,
    minPlayMs: 12 * 1000,
  });
  sim.obs = verdict.obs;
  const sm = smoothDisplayStatus(st, {
    key: sim.key,
    disp: sim.disp,
    obs: verdict.obs,
    blipHold: sim.blipHold === undefined ? 3 : sim.blipHold,
    leadSec: sim.leadSec,
    elapsedMs,
  });
  sim.disp = sm.next;
  sim.now += 2000;
  return {
    pos: sm.next.position,
    dur: sm.next.duration,
    held: sm.held,
    live: sm.next.live,
    verdict,
    rawPos: st.position,
  };
}

/**
 * @param {string} key         曲目标识
 * @param {number} measuredSec 实测时长
 * @param {number} elapsedSec  这首歌**已经播了多久**（挂钟校准规则要用；默认刚起播）
 */
function mkSim(key = 'q1', measuredSec = 319, elapsedSec = 0) {
  const t = Date.now();
  return {
    key,
    disp: makeDisplayStatus(),
    obs: null,
    measuredSec,
    startedAt: t - elapsedSec * 1000,
    now: t,
    blipHold: 3,
    leadSec: 8,
  };
}

// =====================================================================
console.log('\n--- A. 刚推流：上一首的残留进度不许发布 ---');
{
  const sim = mkSim();
  const a = tick(raw('paused', 92.37, 319.112), sim);
  const b = tick(raw('paused', 92.37, 319.112), sim);
  const c = tick(raw('paused', 92.37, 319.112), sim);
  check('残留值 92.37 不发布（显示 0）', a.pos === 0 && b.pos === 0 && c.pos === 0,
    `pos=${a.pos}/${b.pos}/${c.pos}（接口原始 ${a.rawPos}）`);
  check('原始值仍留在诊断里（可复盘）', a.rawPos === 92.37, `rawPos=${a.rawPos}`);
  check('未采信前进度条不算"活的"', a.live === false && b.live === false, `live=${a.live}/${b.live}`);
  check('这期间不算"已推进"（decideEnd 不采信）', a.verdict.obs.sawProgress === false,
    `sawProgress=${a.verdict.obs.sawProgress}`);
}

console.log('\n--- B. 真正起播：进度开始发布 ---');
{
  const sim = mkSim();
  tick(raw('paused', 92.37, 319.112), sim);   // 残留
  tick(raw('paused', 5.868, 319.112), sim);   // 掉头（回退 → 基准重置）
  const g1 = tick(raw('playing', 7.9, 319.112), sim);
  const g2 = tick(raw('playing', 10.1, 319.112), sim);
  check('看到推进后开始发布真实进度', g1.pos === 7.9 && g2.pos === 10.1,
    `pos=${g1.pos}/${g2.pos}`);
  check('标记为 live（前端可把 --:-- 换成 0:00）', g2.live === true, `live=${g2.live}`);
  check('sawProgress 已被认定', g2.verdict.obs.sawProgress === true, '');
}

// =====================================================================
console.log('\n--- C. 核心 bug：idle 闪烁不许把进度拽回 0 ---');
{
  const sim = mkSim();
  tick(raw('paused', 92.37, 319.112), sim);
  tick(raw('paused', 5.868, 319.112), sim);
  tick(raw('playing', 7.9, 319.112), sim);
  const base = tick(raw('playing', 10.1, 319.112), sim);
  const blip = tick(raw('idle', 0, 0), sim);          // ← 单次闪烁
  const back = tick(raw('playing', 12.6, 319.112), sim);
  const blip2 = tick(raw('idle', 0, 0), sim);
  const back2 = tick(raw('playing', 15.1, 319.112), sim);
  check('闪烁帧不归零（保持上一帧进度）', blip.pos === base.pos,
    `blip=${blip.pos} vs 上一帧=${base.pos}`);
  check('闪烁帧被标记为 held', blip.held === true, `held=${blip.held}`);
  check('闪烁帧不把时长抹掉', blip.dur === 319.112, `dur=${blip.dur}`);
  check('闪烁后下一帧正常接上', back.pos === 12.6 && back2.pos === 15.1,
    `pos=${back.pos}/${back2.pos}`);
  check('反复闪烁也不会累积漂移', back2.pos === 15.1, `pos=${back2.pos}`);
  check('闪烁不干扰判定层（没被误判播完）',
    !blip.verdict.ended && !back.verdict.ended && !blip2.verdict.ended,
    `idleCount=${blip.verdict.obs.idleCount}`);
}

console.log('\n--- D. 连续全零 = 真停了，要放行 ---');
{
  const sim = mkSim();
  tick(raw('paused', 5.868, 319.112), sim);
  tick(raw('playing', 8, 319.112), sim);
  tick(raw('playing', 10, 319.112), sim);
  const s1 = tick(raw('idle', 0, 0), sim);   // 1/3 → 顶住
  const s2 = tick(raw('idle', 0, 0), sim);   // 2/3 → 顶住
  const s3 = tick(raw('idle', 0, 0), sim);   // 3/3 → 认账
  check('第 1 次全零：顶住（沿用旧值）', s1.pos === 10 && s1.held === true, `pos=${s1.pos}`);
  check('第 2 次全零：仍顶住', s2.pos === 10 && s2.held === true, `pos=${s2.pos}`);
  check('第 3 次全零：放行（真停了）', s3.pos === 0 && s3.held === false, `pos=${s3.pos}`);
  check('放行后 live=false', s3.live === false, `live=${s3.live}`);
}

console.log('\n--- E. 同一首内进度只增不减（回退按"没动"处理）---');
{
  const sim = mkSim('e', 319, 100); // 已经播了 100 秒（挂钟校准规则要求进度别超过它）
  tick(raw('paused', 5.868, 319.112), sim);
  tick(raw('playing', 30, 319.112), sim);
  const a = tick(raw('playing', 60, 319.112), sim);
  const b = tick(raw('playing', 18, 319.112), sim);   // ← 莫名回退
  const c = tick(raw('playing', 62, 319.112), sim);
  check('正常前进照常发布', a.pos === 60, `pos=${a.pos}`);
  check('回退帧被顶住（不往回跳）', b.pos === 60, `pos=${b.pos}（接口 ${b.rawPos}）`);
  check('回退后继续前进正常', c.pos === 62, `pos=${c.pos}`);
}

console.log('\n--- F. 换曲子必须重置（残留/进度都不能带过去）---');
{
  const sim = mkSim('song-A', 319, 130);
  tick(raw('paused', 5.868, 319.112), sim);
  tick(raw('playing', 100, 319.112), sim);
  const before = tick(raw('playing', 120, 319.112), sim);
  sim.key = 'song-B';   // 换歌
  sim.obs = null;       // 真机上 startPlaying 会重置观测，这里照做
  const after = tick(raw('paused', 88.8, 256.4), sim);  // 新歌给的是上一首残留
  const g1 = tick(raw('playing', 2.6, 256.4), sim);
  const g2 = tick(raw('playing', 6.8, 256.4), sim);
  check('换歌前是 120', before.pos === 120, `pos=${before.pos}`);
  check('换歌后立刻回到 0（不继承）', after.pos === 0, `pos=${after.pos}`);
  check('换歌后的时长用新歌的', after.dur === 256.4, `dur=${after.dur}`);
  check('新歌开始推进后正常发布', g2.pos === 6.8, `pos=${g1.pos} → ${g2.pos}`);
}

console.log('\n--- G. blipHold 可配：设 1 = 不防抖（退回旧行为）---');
{
  const sim = mkSim();
  sim.blipHold = 1;
  tick(raw('paused', 5.868, 319.112), sim);
  tick(raw('playing', 8, 319.112), sim);
  const b = tick(raw('idle', 0, 0), sim);
  check('blipHold=1 时单次闪烁直接采信（旧行为）', b.pos === 0 && b.held === false, `pos=${b.pos}`);
}

console.log('\n--- H. 端到端：完整一轮播放，展示进度单调不减 ---');
{
  // 快播完的一首歌（已播 224 秒；每 2 秒轮询一次，进度严格按 1x 走 —— 真机就是这样）
  const sim = mkSim('full', 231.68, 224);
  const frames = [
    raw('paused', 220.0, 231.68),
    raw('playing', 222.0, 231.68),
    raw('playing', 224.0, 231.68),
    raw('idle', 0, 0),              // 闪
    raw('playing', 226.0, 231.68),
    raw('playing', 227.5, 231.68),
    raw('idle', 0, 0),              // 又闪
    raw('playing', 228.6, 231.68),
    raw('playing', 229.0, 231.68),
    raw('playing', 229.4, 231.68),
    raw('playing', 229.6, 231.68),
    raw('playing', 230.9, 231.68),  // 尾巴 → 应判播完
  ];
  const shown = [];
  let endedAt = -1;
  frames.forEach((f, i) => {
    const r = tick(f, sim);
    shown.push({ i, raw: f.position, shown: r.pos, held: r.held, verdict: r.verdict });
    if (r.verdict.ended && endedAt < 0) endedAt = i;
  });
  const regress = [];
  for (let i = 1; i < shown.length; i++) {
    if (shown[i].shown < shown[i - 1].shown) regress.push(`${i}: ${shown[i - 1].shown}→${shown[i].shown}`);
  }
  check('展示进度全程不回退', regress.length === 0, regress.join(' , ') || 'no regression');
  check('两处 idle 闪烁都没把进度打到 0',
    shown[3].shown > 200 && shown[6].shown > 208,
    `闪烁处 shown=${shown[3].shown} / ${shown[6].shown}`);
  check('发布值始终贴着真实进度（没有被挂钟规则误拦）',
    shown.filter((s) => s.raw > 0.5 && s.shown > 0).every((s) => Math.abs(s.shown - s.raw) < 0.6),
    `末帧 发布 ${shown[shown.length - 1].shown} / 真实 ${shown[shown.length - 1].raw}`);
  check('判定层仍在尾部正常判"播完"', endedAt === frames.length - 1,
    `endedAt=${endedAt} reason=${shown[frames.length - 1].verdict.reason || '-'}`);
  console.log('    展示序列：' + shown.map((s) => `${s.shown}${s.held ? '*' : ''}`).join(' → '));
}

console.log('\n--- I. 「会动的」残留值：绝不能把进度基准粘死在假值上 ---');
{
  // 2026-10-17 用户报「时间不动了」的真因：
  // 上一首的流在推流后还会「往前走」一两秒（190 → 202），于是 sawProgress 被喂成 true，
  // 202 被当成基准发布；等新流的真实进度（4 → 6 → 8…）上来时是「回退」，
  // 被「只增不减」规则一直挡住 → 界面卡死在 3:32，直到真进度追过 202 才恢复。
  // 治它的只能是**挂钟校准**：80 秒前才开始播，不可能已经播到 3:32。
  const sim = mkSim('mov', 275);
  const f1 = tick(raw('playing', 190, 275), sim); // 上一首的残留（还在动）
  const f2 = tick(raw('playing', 202, 275), sim);
  const f3 = tick(raw('playing', 4, 275), sim);   // 新流真实进度（1x）
  const f4 = tick(raw('playing', 6, 275), sim);
  const f5 = tick(raw('playing', 8, 275), sim);
  check('假值 190 / 202 从来没被发布过',
    f1.pos === 0 && f2.pos === 0,
    `发布值 ${f1.pos} / ${f2.pos}（接口 ${f1.rawPos} / ${f2.rawPos}）`);
  check('★ 切到真实进度后立刻跟上（不粘在假值上）',
    f3.pos === 4 && f4.pos === 6 && f5.pos === 8,
    `发布 ${f3.pos} → ${f4.pos} → ${f5.pos}`);
  check('★ 进度在继续走（不是冻结）',
    f5.pos > f4.pos && f4.pos > f3.pos, `${f3.pos} → ${f4.pos} → ${f5.pos}`);
}

console.log('\n--- J. 极端兜底：大幅回退最多卡 1 个轮询，必须自愈 ---');
{
  // 假设某种未知情况下假值/回退还是漏了进来（挂钟规则没拦住），
  // 「只增不减」也必须能自己爬出来，绝不能永久冻结 —— 这是 10-17 那次卡死的底线保险。
  const sim = mkSim('rebase', 275, 200); // 已播 200 秒 → 180 这种读数在挂钟上是"合理的"
  tick(raw('playing', 170, 275), sim);
  tick(raw('playing', 180, 275), sim);
  const a = tick(raw('playing', 10, 275), sim);  // 回退 → 先顶住
  const b = tick(raw('playing', 14, 275), sim);  // 新基准自己在往上走 → 认它
  const c = tick(raw('playing', 18, 275), sim);
  check('回退的第一帧先顶住（不往回蹦）', a.pos === 180 && a.held === true, `pos=${a.pos}`);
  check('★ 最多卡 1 个轮询就自愈到新基准', b.pos === 14 && c.pos === 18, `pos=${a.pos} → ${b.pos} → ${c.pos}`);
}

// =====================================================================
console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} / ${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);

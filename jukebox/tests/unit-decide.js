'use strict';
/**
 * 单元测试：切歌判定 + 真实时长探测
 * ------------------------------------------------------------
 * 这两个函数是「点了歌就立刻切歌」这类 bug 的唯一防线，必须逐场景锁死。
 * 用法：node tests/unit-decide.js
 */
const { decideEnd, probeDurationSec, parseStatus } = require('../server.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

/**
 * 按时间轴喂一串状态采样，返回"被判为播完"的时刻（秒）
 * @param {Array<{t:number, playing:boolean, pos:number, dur:number}>} samples
 */
function run(samples, { measuredSec = 0, minPlaySec = 12 } = {}) {
  let obs = null;
  const verdicts = [];
  for (const s of samples) {
    const v = decideEnd(
      { playing: s.playing, position: s.pos, duration: s.dur, volume: 0 },
      { obs, elapsedMs: s.t * 1000, measuredSec, minPlayMs: minPlaySec * 1000 }
    );
    obs = v.obs;
    if (v.ended) {
      verdicts.push({ t: s.t, reason: v.reason });
      obs = null; // 切歌后重新观测
    }
  }
  return verdicts;
}

/** 生成一串采样：从 t0 到 t1（步长 step），状态由 fn(t) 给出 */
function series(t0, t1, step, fn) {
  const out = [];
  for (let t = t0; t <= t1 + 1e-9; t += step) out.push({ t: Math.round(t * 10) / 10, ...fn(t) });
  return out;
}

console.log('\n===== 切歌判定 单元测试 =====');
console.log('（真机实测：songloft 插件对小米 Sound Pro 的 is_playing 恒为 false，position 会残留上一首的值）\n');

// ---------- 1. 【真机原始序列】刚推流时 position 是上一首的残留值 ----------
// 数据来自 2026-10-16 在 NAS 上对 L17A 的静音推流探测（1.5s 采样）
{
  const real = [
    { t: 1.1, pos: 92.37, dur: 319.112 },
    { t: 2.8, pos: 92.37, dur: 319.112 },
    { t: 4.5, pos: 92.37, dur: 319.112 }, // 连续 3 次不动，且 position > 0
    { t: 6.1, pos: 0, dur: 0 }, // 归零
    { t: 7.7, pos: 5.868, dur: 319.112 }, // 这时才真正开始播
    { t: 9.3, pos: 7.474, dur: 319.112 },
    { t: 11.1, pos: 9.284, dur: 319.112 },
    { t: 12.8, pos: 0, dur: 0 }, // 播放中偶发闪一下 idle
    { t: 14.5, pos: 12.732, dur: 319.112 },
    { t: 16.2, pos: 14.436, dur: 319.112 },
    { t: 18.1, pos: 16.344, dur: 319.112 },
    { t: 19.7, pos: 0, dur: 0 },
    { t: 21.3, pos: 19.466, dur: 319.112 },
    { t: 23.1, pos: 21.225, dur: 319.112 },
  ];
  const samples = real.map((x) => ({ t: x.t, playing: false, pos: x.pos, dur: x.dur }));
  const v = run(samples, { measuredSec: 319.3 });
  check('真机序列：残留进度 92.37 + 恒 false → 不误切', v.length === 0, v.length ? `误切于 ${v[0].t}s（${v[0].reason}）` : '');
}

// ---------- 2. 真机序列完整播到结尾 → 应在尾部切歌 ----------
{
  const samples = [
    { t: 1.1, playing: false, pos: 92.37, dur: 319.112 },
    { t: 2.8, playing: false, pos: 92.37, dur: 319.112 },
    { t: 4.5, playing: false, pos: 92.37, dur: 319.112 },
  ];
  // 从 6s 起正常推进（每 2s 采一次，每 4 次闪一下 idle）
  let n = 0;
  for (let t = 6; t <= 340; t += 2) {
    n += 1;
    const pos = Math.min(2 + (t - 6), 319.112);
    samples.push(n % 9 === 0 ? { t, playing: false, pos: 0, dur: 0 } : { t, playing: false, pos, dur: 319.112 });
  }
  const v = run(samples, { measuredSec: 319.3 });
  check('真机序列：正常播完才切歌', v.length >= 1 && v[0].t >= 316 && v[0].t <= 326, v.length ? `首次切歌 ${v[0].t}s：${v[0].reason}` : '未切歌');
}

// ---------- 3. 残留进度长时间不动（超过 minPlay 也不能切）----------
{
  const samples = series(2, 60, 2, () => ({ playing: false, pos: 92.37, dur: 319.112 }));
  const v = run(samples, { measuredSec: 319.3 });
  check('残留进度 60 秒不动（从未见过向前推进）→ 不切歌', v.length === 0, v.length ? `误切于 ${v[0].t}s` : '');
}

// ---------- 4. 状态接口对这台音箱完全不可信（恒 idle / 0）----------
{
  const samples = series(2, 600, 2, () => ({ playing: false, pos: 0, dur: 0 }));
  const v = run(samples, { measuredSec: 270 });
  check('状态恒报 idle/0 → 不误切', v.length === 0, v.length ? `误切于 ${v[0].t}s` : '');
}

// ---------- 5. 正常播放直到真的播完（接口进度到尾部）----------
{
  const samples = series(2, 280, 2, (t) => ({ playing: false, pos: Math.min(t, 270), dur: 270 }));
  const v = run(samples, { measuredSec: 270 });
  check('正常播完（进度到接口时长尾部）→ 切歌', v.length >= 1 && v[0].t >= 268 && v[0].t <= 272, v.length ? `首次切歌 ${v[0].t}s：${v[0].reason}` : '未切歌');
}

// ---------- 6. 播完后状态报 idle/0（流已停止）----------
{
  const samples = [
    ...series(2, 270, 2, (t) => ({ playing: false, pos: t, dur: 270 })),
    ...series(272, 290, 2, () => ({ playing: false, pos: 0, dur: 0 })),
  ];
  const v = run(samples, { measuredSec: 270 });
  check('播完后连续 idle → 切歌', v.length >= 1 && v[0].t <= 288, v.length ? `首次切歌 ${v[0].t}s：${v[0].reason}` : '未切歌');
}

// ---------- 7. 接口不给时长，靠我们量出来的真实时长判尾 ----------
{
  const samples = series(2, 300, 2, (t) => ({ playing: false, pos: t, dur: 0 }));
  const v = run(samples, { measuredSec: 280 });
  check('接口不给时长，但进度达实测时长 → 切歌', v.length >= 1 && v[0].t >= 278 && v[0].t <= 282, v.length ? `首次切歌 ${v[0].t}s：${v[0].reason}` : '未切歌');
}

// ---------- 8. 中途真的卡住（接口说在播、进度却冻结）----------
{
  const samples = [
    ...series(2, 100, 2, (t) => ({ playing: true, pos: t, dur: 270 })),
    ...series(102, 140, 2, () => ({ playing: true, pos: 100, dur: 270 })),
  ];
  const v = run(samples, { measuredSec: 270 });
  check('接口说在播但进度冻结 → 切歌（清掉哑音）', v.length >= 1 && v[0].t >= 100 && v[0].t <= 112, v.length ? `首次切歌 ${v[0].t}s：${v[0].reason}` : '未切歌');
}

// ---------- 8b. 接口说"暂停" → 宽容 40 秒再切（避免误伤手动暂停）----------
{
  const short = [
    ...series(2, 100, 2, (t) => ({ playing: true, pos: t, dur: 270 })),
    ...series(102, 130, 2, () => ({ playing: false, pos: 100, dur: 270 })),
  ];
  const v1 = run(short, { measuredSec: 270 });
  check('接口说暂停且进度冻结 28 秒 → 暂不切（可能只是手动暂停）', v1.length === 0, v1.length ? `误切于 ${v1[0].t}s` : '');

  const long = [
    ...series(2, 100, 2, (t) => ({ playing: true, pos: t, dur: 270 })),
    ...series(102, 180, 2, () => ({ playing: false, pos: 100, dur: 270 })),
  ];
  const v2 = run(long, { measuredSec: 270 });
  check('接口一直说暂停、进度冻结超 40 秒 → 切歌清场', v2.length >= 1 && v2[0].t >= 140, v2.length ? `首次切歌 ${v2[0].t}s：${v2[0].reason}` : '未切歌');
}

// ---------- 9. 单次状态抖动（闪一下 idle + 回退）→ 不切 ----------
{
  const samples = [
    ...series(2, 30, 2, (t) => ({ playing: false, pos: t, dur: 300 })),
    { t: 32, playing: false, pos: 0, dur: 0 },
    { t: 34, playing: false, pos: 32, dur: 300 },
    { t: 36, playing: false, pos: 0, dur: 0 },
    ...series(38, 60, 2, (t) => ({ playing: false, pos: 34 + (t - 38), dur: 300 })),
  ];
  const v = run(samples, { measuredSec: 300 });
  check('播放中偶发 idle 闪断 → 不切歌', v.length === 0, v.length ? `误切于 ${v[0].t}s` : '');
}

// ---------- 10. 接口时长明显不可信（3s vs 实测 300s）→ 不采信 ----------
{
  const samples = [
    ...series(2, 20, 2, (t) => ({ playing: false, pos: t * 0.15, dur: 3 })),
    ...series(22, 300, 2, (t) => ({ playing: false, pos: t, dur: 0 })),
  ];
  const v = run(samples, { measuredSec: 300 });
  check('接口时长 3s vs 实测 300s → 不因此提前切', v.filter((x) => x.t < 290).length === 0, v.length ? `最早误切 ${v[0].t}s` : '');
}

// ---------- 11. 进度远超实测时长（数据错乱）→ 不采信 ----------
{
  const samples = series(2, 200, 2, () => ({ playing: false, pos: 3600, dur: 3600 }));
  const v = run(samples, { measuredSec: 200 });
  check('进度远超实测时长（数据错乱）→ 不切歌', v.length === 0, v.length ? `误切于 ${v[0].t}s` : '');
}

// ---------- 12. 起播 4 秒内即报"进度到尾部"：minPlay 保护 ----------
{
  const samples = [
    { t: 2, playing: false, pos: 300, dur: 300 },
    { t: 4, playing: false, pos: 300, dur: 300 },
    ...series(6, 60, 2, (t) => ({ playing: false, pos: 2 + (t - 6), dur: 300 })),
  ];
  const v = run(samples, { measuredSec: 300, minPlaySec: 12 });
  check('起播 4 秒内即报"进度满" → minPlay 保护，不切歌', v.filter((x) => x.t < 12).length === 0, v.length ? `最早误切 ${v[0].t}s` : '');
}

// ---------- 13. 状态字段全空 → 不误切（交给超时兜底）----------
{
  const samples = series(2, 400, 2, () => ({ playing: null, pos: 0, dur: 0 }));
  const v = run(samples, { measuredSec: 200 });
  check('状态字段全空 → 不误切（交给超时兜底）', v.length === 0, v.length ? `误切于 ${v[0].t}s` : '');
}

// ---------- 14. 其它引擎（playing 能正常报 true）也要正确判定 ----------
{
  const samples = series(2, 100, 2, (t) => ({ playing: t < 60, pos: Math.min(t, 60), dur: 60 }));
  const v = run(samples, { measuredSec: 60 });
  check('playing 正常上报的引擎：播完 → 切歌', v.length >= 1 && v[0].t <= 64, v.length ? `首次切歌 ${v[0].t}s：${v[0].reason}` : '未切歌');
}

console.log('\n===== 状态解析 单元测试 =====\n');

// 真机原始 payload（2026-10-16 从 L17A 抓到）：布尔字段是错的，字符串 state 才对
{
  const p = parseStatus({
    state: 'playing',
    play_mode: 'order',
    playlist_id: 0,
    position: 212.258,
    duration: 319.112,
    is_playing: false,
    speed: 1,
    volume: 5,
  });
  check('真机 payload：state=playing + is_playing=false → 判为在播', p.playing === true, `playing=${p.playing} pos=${p.position} dur=${p.duration}`);
}
{
  const p = parseStatus({ state: 'idle', is_playing: false, position: 0, duration: 0, volume: 5 });
  check('真机 payload：state=idle → 判为不在播', p.playing === false, `playing=${p.playing}`);
}
{
  const p = parseStatus({ state: 'paused', is_playing: false, position: 92.37, duration: 319.112 });
  check('真机 payload：state=paused → 判为不在播', p.playing === false, `playing=${p.playing}`);
}
{
  const p = parseStatus({ is_playing: true, position: 10, total: 200 });
  check('只有布尔字段的引擎（如 xiaomusic）→ 仍能识别', p.playing === true && p.duration === 200, `playing=${p.playing} dur=${p.duration}`);
}

console.log('\n===== 真实时长探测 单元测试 =====\n');

/** 生成结构合法的静音 MP3（MPEG1 Layer3 128kbps 44.1kHz） */
function makeMp3(seconds, withId3 = true) {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x64;
  const n = Math.round(seconds / (1152 / 44100));
  const frames = new Array(n).fill(frame);
  return withId3 ? Buffer.concat([id3, ...frames]) : Buffer.concat(frames);
}

/** 生成 WAV（44.1kHz 立体声 16bit） */
function makeWav(seconds) {
  const byteRate = 44100 * 2 * 2;
  const dataSize = byteRate * seconds;
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataSize, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataSize, 40);
  return Buffer.concat([b, Buffer.alloc(1024)]);
}

/** 生成 FLAC 头（STREAMINFO 块 + 少量数据） */
function makeFlac(seconds) {
  const b = Buffer.alloc(64);
  b.write('fLaC', 0, 'latin1');
  b[4] = 0x00; // 块类型 0 = STREAMINFO，长度 34
  b.writeUIntBE(34, 5, 3);
  const sr = 44100;
  const total = Math.round(sr * seconds);
  b.writeUInt16BE(sr >> 4, 18);
  b[20] = ((sr & 0x0f) << 4) | 0x00; // 低 4 位是采样率，其余是声道/bps 高位
  b.writeUInt32BE(total & 0xffffffff, 21);
  b.writeUInt32BE(total & 0xffffffff, 21);
  return b;
}

{
  const mp3 = makeMp3(200, false);
  const d = probeDurationSec(mp3, mp3.length, '.mp3');
  check('MP3 无 ID3 → 真实时长', Math.abs(d - 200) < 2, `探到 ${d}s，期望 ≈200s`);
}
{
  const mp3 = makeMp3(200, true);
  const d = probeDurationSec(mp3, mp3.length, '.mp3');
  check('MP3 带 ID3v2 → 正确跳过标签', Math.abs(d - 200) < 2, `探到 ${d}s，期望 ≈200s`);
}
{
  const wav = makeWav(12);
  const d = probeDurationSec(wav, wav.length, '.wav');
  check('WAV → 真实时长', Math.abs(d - 12) < 0.3, `探到 ${d}s，期望 12s`);
}
{
  const flac = makeFlac(60);
  const d = probeDurationSec(flac, flac.length, '.flac');
  check('FLAC STREAMINFO → 真实时长', Math.abs(d - 60) < 0.3, `探到 ${d}s，期望 60s`);
}
{
  const junk = Buffer.alloc(4096, 0x7a);
  const d = probeDurationSec(junk, junk.length, '.mp3');
  check('非音频数据 → 返回 0（交给兜底估算）', d === 0, `探到 ${d}`);
}

const pass = results.filter((r) => r.ok).length;
console.log('\n══════════════ 测试汇总 ══════════════');
for (const r of results) console.log(` ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
console.log(`\n 结果：${pass}/${results.length} 通过\n`);
process.exit(pass === results.length ? 0 : 1);

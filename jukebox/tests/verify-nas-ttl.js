#!/usr/bin/env node
/**
 * 昵称 TTL 版真机只读验收（不占名、不改音量、不点歌、不动队列）
 *
 *   node tests/verify-nas-ttl.js [baseUrl]
 *   默认 baseUrl = http://192.168.1.100:58092
 *
 * 为什么单独写一个：
 *   tests/verify-nas.js 是「全功能验收」，会占两个昵称、会点歌、会调音量、会改队列。
 *   部署完昵称 TTL 版后只想确认「新代码真的上去了、TTL 逻辑活着」，用这个脚本就够，
 *   它对 NAS 上的 nicks.json / chat.json / 队列 / 音量 **零写入**。
 *
 * 检查项：
 *   A. 版本指纹：/api/state 出现 nickTtlSec / nickCount（没有 = 还是旧版，deploy 没生效）
 *   B. TTL 语义：nickTtlSec 为正整数
 *   C. 查重接口：空名 / 超长名被拒；随机未占用名 → taken=false 且 releasesInSec=0
 *   D. 已占用名（默认拿上次验收残留的「验收员A」）→ taken=true 且 releasesInSec>0
 *   E. 新接口存在且未授权会被挡：POST /api/admin/nicks 无 pin → 403，POST /api/admin/nick/release 无 pin → 403
 *   F. 老接口没被改坏：/api/health 200 且 preferCache、/api/library、/api/chat 正常
 */

const BASE = (process.argv[2] || process.env.JB_BASE || 'http://192.168.1.100:58092').replace(/\/+$/, '');
const KNOWN_TAKEN = process.env.JB_KNOWN_NICK || '验收员A';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${extra ? '  · ' + extra : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name}${extra ? '  · ' + extra : ''}`);
  }
}

async function req(pathname, opts = {}) {
  const url = pathname.startsWith('http') ? pathname : BASE + pathname;
  const init = { method: opts.method || 'GET', signal: AbortSignal.timeout(opts.timeout || 15000) };
  if (opts.body !== undefined) {
    init.method = 'POST';
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(url, init);
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, ok: r.ok, json, text };
}

const DAY = 86400;

async function main() {
  console.log(`\n目标：${BASE}\n（只读验收：不占昵称、不改音量、不动队列）\n`);

  console.log('--- A/B. 版本指纹 & TTL 语义 ---');
  const st = await req('/api/state');
  check('/api/state 可访问', st.status === 200, `HTTP ${st.status}`);
  const s = st.json || {};
  check('★ 出现 nickTtlSec（没有 = 还是旧版，deploy 未生效）', typeof s.nickTtlSec === 'number', `nickTtlSec=${s.nickTtlSec}`);
  check('★ 出现 nickCount', typeof s.nickCount === 'number', `nickCount=${s.nickCount}`);
  const ttl = Number(s.nickTtlSec);
  check('nickTtlSec 是正整数（默认 7 天 = 604800）', Number.isFinite(ttl) && ttl > 0, `${ttl}s ≈ ${(ttl / DAY).toFixed(1)} 天`);
  check('/api/state 仍有 voteEnabled / vote（投票切歌没被改坏）', typeof s.voteEnabled === 'boolean' && s.vote !== undefined,
    `voteEnabled=${s.voteEnabled} vote=${JSON.stringify(s.vote)}`);
  check('/api/state 仍有 adminConfigured', typeof s.adminConfigured === 'boolean', `adminConfigured=${s.adminConfigured} source=${s.adminSource}`);

  console.log('\n--- C. 查重接口 /api/nick/check ---');
  // 注意：GET /api/nick/check 对不合法昵称不是报错，而是 200 + valid:false
  //       （真正报 400 的是 POST /api/nick/claim）
  const blank = await req('/api/nick/check?nick=' + encodeURIComponent('   '));
  check('空白昵称 → valid=false', blank.status === 200 && blank.json && blank.json.valid === false,
    `HTTP ${blank.status} valid=${blank.json && blank.json.valid}`);
  const longName = 'x'.repeat(200);
  const longRes = await req('/api/nick/check?nick=' + encodeURIComponent(longName));
  check('超长昵称 → valid=false', longRes.status === 200 && longRes.json && longRes.json.valid === false,
    `HTTP ${longRes.status} valid=${longRes.json && longRes.json.valid} maxLen=${longRes.json && longRes.json.maxLen}`);
  check('查重接口回带 maxLen（≥4）', longRes.json && Number(longRes.json.maxLen) >= 4, `maxLen=${longRes.json && longRes.json.maxLen}`);
  const freeNick = 'zz_free_' + Date.now().toString(36);
  const free = await req('/api/nick/check?nick=' + encodeURIComponent(freeNick));
  check('未占用昵称 → taken=false', free.status === 200 && free.json && free.json.taken === false,
    `taken=${free.json && free.json.taken} releasesInSec=${free.json && free.json.releasesInSec}`);
  check('未占用昵称不显示倒计时（releasesInSec=0）', free.json && Number(free.json.releasesInSec) === 0,
    `releasesInSec=${free.json && free.json.releasesInSec}`);
  check('查重接口回带 ttlSec（前端据此写「N 天自动释放」文案）', free.json && Number(free.json.ttlSec) === ttl,
    `ttlSec=${free.json && free.json.ttlSec} vs state=${ttl}`);

  console.log('\n--- D. 已占用昵称的释放倒计时 ---');
  const taken = await req('/api/nick/check?nick=' + encodeURIComponent(KNOWN_TAKEN));
  if (taken.status === 200 && taken.json && taken.json.taken) {
    const rs = Number(taken.json.releasesInSec);
    check(`「${KNOWN_TAKEN}」已占用 → taken=true`, true, `releasesInSec=${rs}`);
    check(`「${KNOWN_TAKEN}」有自动释放倒计时（0 < N ≤ ttl）`, rs > 0 && rs <= ttl, `${rs}s ≈ ${(rs / DAY).toFixed(1)} 天后自动释放`);
  } else {
    console.log(`  ⏭ 跳过：「${KNOWN_TAKEN}」当前没人占用（可能已被清理），改设 JB_KNOWN_NICK=某占用名 再跑`);
  }

  console.log('\n--- E. 新管理员接口存在 + 未授权被挡 ---');
  const n1 = await req('/api/admin/nicks', { body: {} });
  check('POST /api/admin/nicks 无口令 → 403（接口存在且鉴权生效）', n1.status === 403 || n1.status === 400, `HTTP ${n1.status}`);
  const n2 = await req('/api/admin/nick/release', { body: { pin: 'definitely-wrong-pin', nick: KNOWN_TAKEN } });
  check('POST /api/admin/nick/release 错口令 → 被拒（不会误放昵称）',
    n2.status === 403 || n2.status === 401 || n2.status === 400, `HTTP ${n2.status}`);

  console.log('\n--- F. 老功能没被改坏 ---');
  const h = await req('/api/health');
  check('/api/health 200', h.status === 200 && h.json && h.json.ok === true, `HTTP ${h.status}`);
  check('/api/health preferCache=true（NAS 曲库优先仍开）', h.json && h.json.preferCache === true, `preferCache=${h.json && h.json.preferCache}`);
  const lib = await req('/api/library');
  check('/api/library 正常', lib.status === 200 && lib.json && Array.isArray(lib.json.items), `count=${lib.json && lib.json.count}`);
  const chat = await req('/api/chat');
  check('/api/chat 正常（消息数组字段是 msgs）', chat.status === 200 && chat.json && Array.isArray(chat.json.msgs),
    `msgs=${chat.json && chat.json.msgs && chat.json.msgs.length}`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    console.log('\n若「★」两项失败 → 说明 NAS 上跑的还是旧 server.js，重跑 deploy.cmd（注意 --overwrite replace）。');
  } else {
    console.log('昵称 TTL 版已生效，且老功能无回归。');
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n验收脚本自身出错：', e.message);
  process.exit(2);
});

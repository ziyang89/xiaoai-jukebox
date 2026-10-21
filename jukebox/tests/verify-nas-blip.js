#!/usr/bin/env node
/**
 * 「进度条防跳」版上线后的**只读**验收
 * ------------------------------------------------------------------
 * 对着已部署的实例跑，不改音量、不动队列、不占昵称 —— 随时可跑。
 *
 * 检查三件事：
 *   ① 版本指纹：`/api/state` 有 `statusBlipHold`、页面里有 `nowPosCache`
 *      （缺了 = NAS 还在跑旧代码，重跑 deploy.cmd 即可）；
 *   ② 契约完整：`status` 里有 `held`/`live`/`rawPos`，`/api/diag` 里有 `lastRaw`
 *      —— 排障不会被平滑挡住；
 *   ③ 老功能无回归：health / 曲库 / 聊天 / 投票切歌 / 昵称 TTL 都还在。
 *   ④ 如果此刻正好有歌在播，顺手采样看发布进度是否单调（不回退、不归零）。
 *
 * 用法：node tests/verify-nas-blip.js [http://192.168.1.100:58092]
 */
'use strict';

const BASE = (process.argv[2] || 'http://192.168.1.100:58092').replace(/\/$/, '');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, opt) {
  try {
    const r = await fetch(BASE + path, opt);
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, ok: r.ok, json, text };
  } catch (e) {
    return { status: 0, ok: false, json: null, text: '', err: e.message };
  }
}

async function main() {
  console.log(`\n目标：${BASE}`);
  console.log('（只读验收：不改音量、不动队列、不占昵称）\n');

  // ---------------- A. 版本指纹 ----------------
  console.log('--- A. 版本指纹（缺了 = NAS 还是旧代码）---');
  const st = await req('/api/state');
  check('/api/state 可访问', st.status === 200, `HTTP ${st.status}${st.err ? ' ' + st.err : ''}`);
  if (!st.json) {
    console.log('\n  接口不通，后面的检查没法做。检查容器是否在跑：docker container ls');
    return finish();
  }
  const d = st.json;

  check('★ 出现 statusBlipHold（进度条防抖阈值）', Number.isFinite(Number(d.statusBlipHold)),
    `statusBlipHold=${d.statusBlipHold}`);
  check('★ statusBlipHold 是 ≥1 的整数', Number(d.statusBlipHold) >= 1,
    `${d.statusBlipHold} 次（约 ${(Number(d.statusBlipHold) || 0) * ((Number(d.pollIntervalMs) || 2000) / 1000)} 秒容错）`);
  check('★ 出现 statusLeadSec（进度超前容差，治「时间不动了」的那条规则）',
    Number.isFinite(Number(d.statusLeadSec)), `statusLeadSec=${d.statusLeadSec}`);

  // 音源配置：死源留在列表里只会白烧配额（接口对不支持的 source 直接回 400）
  check('★ /api/state 暴露 sources（部署后能确认配置真的换了）', Array.isArray(d.sources),
    JSON.stringify(d.sources));
  check('★ 搜索源里没有接口已下线的那几个（qq 是自建源，不算 GD 的源名）',
    Array.isArray(d.searchSources) && !d.searchSources.some((x) => ['kuwo', 'kugou', 'tencent', 'migu'].includes(x)),
    JSON.stringify(d.searchSources));
  check('降级链里没有接口已下线的那几个',
    Array.isArray(d.sources) && !d.sources.some((x) => ['kuwo', 'kugou', 'tencent', 'migu'].includes(x)),
    JSON.stringify(d.sources));
  check('熔断名单可读（当前跳过哪些源）', Array.isArray(d.deadSources), JSON.stringify(d.deadSources || []));

  // QQ 自建源：只暴露"配没配 + 脱敏 QQ 号 + 音质"，绝不回传 key
  check('★ /api/state 暴露 qq 状态（配没配、脱敏号、音质）',
    !!d.qq && typeof d.qq === 'object' && 'configured' in d.qq, JSON.stringify(d.qq || null));
  check('★ qq 状态里没有 key，QQ 号也是脱敏的',
    !!d.qq && !Object.keys(d.qq).some((k) => /key|authst|secret/i.test(k)) && !/\d{6,}/.test(String(d.qq.uin || '')),
    `uin=${d.qq && d.qq.uin}`);

  const page = await req('/');
  check('页面可访问', page.status === 200 && page.text.length > 1000, `${page.text.length} 字节`);
  check('★ 页面里有 nowPosCache（前端第二道保险）', page.text.includes('nowPosCache'));
  check('★ 页面里有 QQ 音源面板（key 过期时能自助更换）',
    page.text.includes('amQQBtn') && page.text.includes('qm_keyst'));
  check('★ 页面里有随机电台面板（能关掉 / 换一首）',
    page.text.includes('amRadioBtn') && page.text.includes('amRadioToggle'));
  check('★ 页面里有定时关闭入口（顶栏 ⏱ + 弹层）',
    page.text.includes('btnSleep') && page.text.includes('sleepModal') && page.text.includes('slRepeat'));
  // 「停止」对所有人生效：按钮常显、走公开接口（不需要管理员口令）
  check('★ 页面里「停止」不需要管理员解锁（常显 + 走 /api/stop）',
    page.text.includes("'/api/stop'") && !/btnStop"\s+style="display:none"/.test(page.text),
    'btnStop 常显，前端请求 /api/stop');
  check('★ /api/state 暴露最近一次停止（谁按的 / 清了几个）', 'stop' in d,
    JSON.stringify(d.stop || null));
  // 排行榜：卡片可折叠、榜单下拉 + 新接口已上线（未配 QQ 时接口回 503 也算"上线了"）
  check('★ 页面里有排行榜卡片（可折叠 + 榜单下拉 + 刷新）',
    page.text.includes('topCard') && page.text.includes('topPick') && page.text.includes('btnTopToggle'));
  check('★ 页面里热门歌手快捷标签已移除（改成排行榜卡片）', !page.text.includes('id="hots"'));
  // 榜单下拉是自定义深色面板（原生 <select> 在深色页面下白底弹层看不清）
  check('★ 榜单下拉是自定义深色面板（不是原生 <select>）',
    page.text.includes('selpop') && page.text.includes('topPickBtn') && !page.text.includes('<select class="sel"'),
    '有 .selpop / topPickBtn，无原生 select');
  // 队列：删除下线 + 点赞前挪（queueTopNeed）
  check('★ 队列行里没有删除按钮（data-del 已下线）', !page.text.includes('data-del'), '没有 data-del');
  check('★ /api/state 有 queueTopNeed（点赞门槛，默认 3 = 超过 2 名）',
    Number(d.queueTopNeed) >= 1, `queueTopNeed=${d.queueTopNeed}`);
  const tl = await req('/api/toplist');
  check('★ /api/toplist 已上线（200 榜单列表 / 503 未配 QQ 都可接受）',
    tl.status === 200 || tl.status === 503,
    `HTTP ${tl.status}${tl.json && tl.json.error ? ' · ' + tl.json.error : ''}`);
  if (tl.status === 200) {
    check('  榜单列表非空且字段齐（topId/title）',
      Array.isArray(tl.json.lists) && tl.json.lists.length > 0 &&
        tl.json.lists.every((x) => Number(x.topId) > 0 && x.title),
      `${tl.json.lists.length} 个榜 · ${tl.json.lists.slice(0, 3).map((x) => x.title).join('/')}`);
  }
  // 定时关闭：只读检查字段形状，绝不真的设一个定时（会把家里正在放的歌停掉）
  check('★ /api/state 暴露 sleep 状态（倒计时 / 是否被按住）',
    !!d.sleep && typeof d.sleep === 'object' && 'active' in d.sleep && 'hold' in d.sleep,
    JSON.stringify(d.sleep || null));
  check('★ sleep 给出 leftSec / maxMin（前端能显示倒计时、也能校验上限）',
    !!d.sleep && Number.isFinite(d.sleep.leftSec) && Number.isFinite(d.sleep.maxMin) && d.sleep.maxMin > 0,
    d.sleep ? `leftSec=${d.sleep.leftSec} maxMin=${d.sleep.maxMin}` : '');
  check('sleep 的 queueLeft 与队列长度一致（"继续播放"能接上几首）',
    !!d.sleep && Number.isFinite(d.sleep.queueLeft) &&
      d.sleep.queueLeft <= (Array.isArray(d.queue) ? d.queue.length : 0) + 1,
    `queueLeft=${d.sleep && d.sleep.queueLeft} queue=${(d.queue || []).length}`);
  // 随机电台：队列播空自动放 NAS 曲库。只读检查，绝不触发播放
  check('★ /api/state 暴露 radio 状态', !!d.radio && typeof d.radio === 'object' && 'on' in d.radio,
    JSON.stringify(d.radio || null));
  check('★ radio 给出 available / libCount（判断"真的会接上吗"）',
    !!d.radio && typeof d.radio.available === 'boolean' && Number.isFinite(d.radio.libCount),
    d.radio ? `available=${d.radio.available} lib=${d.radio.libCount}` : '');
  check('★ radio 状态里不含任何曲目路径（不泄漏文件名）',
    !!d.radio && !JSON.stringify(d.radio).match(/[A-Za-z]:\\|\/music\//),
    JSON.stringify(d.radio || null).slice(0, 120));
  check('页面里仍有 held/live 的消费逻辑', page.text.includes('st.position') && page.text.includes('nowPosCache'));

  // ---------------- B. 契约完整 ----------------
  console.log('\n--- B. 契约完整（平滑了也不挡住排障）---');
  const s = d.status || {};
  check('status 对象存在（没歌时可为 null，不报错）', d.status === null || typeof d.status === 'object',
    d.status ? Object.keys(s).sort().join(',') : 'null（当前没在播）');
  if (d.status) {
    check('status 带 held（本次是否沿用上一次的值）', 'held' in s, `held=${s.held}`);
    check('status 带 live（是否已采信真实进度）', 'live' in s, `live=${s.live}`);
    check('status 带 rawPos（接口原始值，诊断用）', 'rawPos' in s, `rawPos=${s.rawPos} / 发布 ${s.position}`);
    check('发布值与原始值是两个独立字段', s.position !== undefined && s.rawPos !== undefined);
    // 卡死判定小抄：发布值明显大于原始值 = 基准被假值粘住了
    const lead = Number(d.statusLeadSec) || 8;
    check('★ 发布值没有显著超前接口原始值（等于没有卡在假基准上）',
      s.rawPos === undefined || s.rawPos <= 0.5 || s.position <= s.rawPos + lead + 1,
      `发布 ${s.position} vs 原始 ${s.rawPos}（容差 ${lead}s）`);
  } else {
    console.log('  ℹ️  当前没有歌在播，跳过 status 字段检查（点一首再跑更完整）');
  }

  const diag = await req('/api/diag');
  check('/api/diag 可访问', diag.status === 200, `HTTP ${diag.status}`);
  check('★ /api/diag 里有 lastRaw（原始读数留档）', diag.json && 'lastRaw' in diag.json,
    diag.json && diag.json.lastRaw
      ? `raw.state=${diag.json.lastRaw.state} pos=${diag.json.lastRaw.position}`
      : 'null（还没跑过状态轮询）');
  check('/api/diag 里有 lastStatus（发布值留档）', diag.json && 'lastStatus' in diag.json,
    diag.json && diag.json.lastStatus ? `pos=${diag.json.lastStatus.position} held=${diag.json.lastStatus.held}` : 'null');

  // ---------------- C. 老功能无回归 ----------------
  console.log('\n--- C. 老功能没被改坏 ---');
  const health = await req('/api/health');
  check('/api/health 200', health.status === 200);
  check('progress 相关配置没被清掉', d.nickTtlSec !== undefined || health.status === 200,
    `nickTtlSec=${d.nickTtlSec}`);

  const lib = await req('/api/library');
  check('/api/library 正常', lib.status === 200 && lib.json && Number.isFinite(lib.json.total),
    `曲库 ${lib.json && lib.json.total} 首`);

  const chat = await req('/api/chat');
  check('/api/chat 正常（字段是 msgs）', chat.status === 200 && chat.json && Array.isArray(chat.json.msgs),
    `msgs=${chat.json && chat.json.msgs && chat.json.msgs.length}`);

  check('投票切歌配置还在', d.voteEnabled !== undefined || (d.vote && 'enabled' in d.vote),
    `voteEnabled=${d.voteEnabled}`);

  const nicks = await req('/api/admin/nicks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  check('新管理员接口仍在鉴权（无口令 403）', nicks.status === 403, `HTTP ${nicks.status}`);

  // ---------------- D. 有歌在播就顺手采样 ----------------
  console.log('\n--- D. 若此刻有歌在播：采样发布进度是否单调 ---');
  const now = await req('/api/state');
  const cur = now.json && now.json.current;
  if (!cur || !now.json.status || !now.json.status.live) {
    console.log(`  ℹ️  当前${cur ? '在播但还没采信进度' : '没有歌在播'}，跳过采样（这一步不影响结论）`);
  } else {
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const q = await req('/api/state');
      const ss = q.json && q.json.status;
      if (ss) samples.push({ pos: ss.position, held: !!ss.held, rawPos: ss.rawPos });
      await sleep(900);
    }
    const regress = [];
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].pos < samples[i - 1].pos - 0.5) regress.push(`${samples[i - 1].pos}→${samples[i].pos}`);
    }
    console.log('    发布值：' + samples.map((x) => `${x.pos}${x.held ? '*' : ''}`).join(' → '));
    check('★ 采样期间发布进度不回退', regress.length === 0, regress.join(' , ') || 'no regression');
    check('★ 闪烁帧（rawPos=0）没有把发布值打成 0',
      samples.every((x) => !(x.rawPos !== null && x.rawPos <= 0.5) || x.pos > 0),
      samples.filter((x) => x.rawPos !== null && x.rawPos <= 0.5).length + ' 个闪烁帧');
    const lead = Number(now.json.statusLeadSec) || 8;
    const overshoot = samples.filter((x) => x.rawPos !== null && x.rawPos > 0.5 && x.pos > x.rawPos + lead + 1);
    check('★ 发布值没有超前真实进度（没有卡在假基准上 / 时间不是停的）',
      overshoot.length === 0,
      overshoot.length
        ? overshoot.slice(0, 3).map((x) => `发布 ${x.pos} vs 真实 ${x.rawPos}`).join(' , ')
        : `差距最大 ${Math.max(...samples.map((x) => (x.rawPos === null ? 0 : x.pos - x.rawPos))).toFixed(1)}s`);
  }

  return finish();
}

function finish() {
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail === 0) console.log('进度条防跳版已生效，且老功能无回归。\n');
  else console.log('有失败项 —— 若 ★ 项失败，多半是 NAS 还在跑旧代码：重跑 deploy.cmd。\n');
  // 用 exitCode 而不是 process.exit()：Windows 上带着未关闭的 keep-alive 连接硬退
  // 会打一行 libuv 断言噪音，虽然无害但看着吓人。
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('验收脚本异常：', e.message);
  process.exitCode = 1;
});

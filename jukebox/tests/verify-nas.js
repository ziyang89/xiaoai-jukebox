#!/usr/bin/env node
/**
 * 真机验收脚本（对已部署到 NAS 的点歌台跑一遍只读/低侵入检查）
 *
 *   node tests/verify-nas.js [baseUrl]
 *   默认 baseUrl = http://192.168.1.100:58092
 *
 * 会做这些事：
 *   1) 静音（音量置 0）—— 避免验收时吵到人
 *   2) 昵称查重 / 占名 / 重名被拒（409）
 *   3) 两个客户端心跳 → 在线人数、投票门槛
 *   4) 聊天室发消息 + 增量拉取
 *   5) 点一首歌（优先 NAS 曲库里已有的，秒播不碰音源）
 *   6) 投票切歌：不足半数不切、过半才切
 *   7) 收尾：清空队列 + 恢复音量 15
 *
 * ⚠️ 注意：昵称占名是**持久**的（写进 nicks.json，人离线也不释放）。
 *    本脚本用带「验收」字样的名字，若想回收就删掉 NAS 上
 *    /vol1/docker/xiaoai-jukebox/jukebox/data/nicks.json 里的对应项。
 */

const BASE = (process.argv[2] || process.env.JB_BASE || 'http://192.168.1.100:58092').replace(/\/+$/, '');

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function req(pathname, opts = {}) {
  const url = pathname.startsWith('http') ? pathname : BASE + pathname;
  const init = { method: opts.method || 'GET', signal: AbortSignal.timeout(opts.timeout || 20000) };
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

const state = () => req('/api/state').then((r) => r.json || {});
const live = (clientId, nick) => req('/api/live', { body: { clientId, nick } }).then((r) => r.json || {});

/** /api/skip 的投票快照是展开在顶层的；/api/state 里是嵌在 vote 下的 */
function voteOf(json, st) {
  if (json && json.need != null) return json;
  if (json && json.vote) return json.vote;
  if (st && st.vote) return st.vote;
  return {};
}

async function main() {
  console.log(`\n=== 真机验收 ${BASE} ===\n`);

  // 0) 服务在不在
  const h = await req('/api/health');
  check('服务在线', h.ok && h.json && h.json.ok === true, `HTTP ${h.status}`);
  if (!h.ok) {
    console.log('\n服务不可用，先确认容器跑起来了。');
    process.exit(1);
  }
  console.log(
    `     版本 ${h.json.version} | 引擎 ${h.json.engine} ok=${h.json.engineOk}` +
      ` | 曲库 ${h.json.library.count} 首 / ${(h.json.library.bytes / 1048576).toFixed(1)}MB`
  );

  // 1) 静音
  await req('/api/volume', { body: { volume: 0 } });
  const v0 = await state();
  check('已静音（音量 0），验收过程不会出声', Number(v0.volume) === 0, `volume=${v0.volume}`);

  // 2) 昵称查重 / 占名
  const A = 'verify-a-' + Math.random().toString(36).slice(2, 7);
  const B = 'verify-b-' + Math.random().toString(36).slice(2, 7);
  const NICK_A = '验收员A';
  const NICK_B = '验收员B';

  const ck = await req(`/api/nick/check?nick=${encodeURIComponent(NICK_A)}&clientId=${A}`);
  check('昵称查重接口可用（返回 taken/maxLen）', ck.json && typeof ck.json.taken === 'boolean',
    `taken=${ck.json && ck.json.taken} maxLen=${ck.json && ck.json.maxLen}`);

  if (ck.json && ck.json.taken) {
    console.log(`     ⚠️ 「${NICK_A}」已被占用（可能是上次验收留下的），本次跳过占名类断言`);
  }

  const claimA = await req('/api/nick/claim', { body: { clientId: A, nick: NICK_A } });
  check('占名成功（新名字可用）', claimA.ok && claimA.json && claimA.json.ok === true,
    claimA.ok ? `nick=${claimA.json.nick}` : `${claimA.status} ${JSON.stringify(claimA.json)}`);

  const claimBdup = await req('/api/nick/claim', { body: { clientId: B, nick: NICK_A } });
  check('重名被拒（HTTP 409）', claimBdup.status === 409, `HTTP ${claimBdup.status}`);

  const claimB = await req('/api/nick/claim', { body: { clientId: B, nick: NICK_B } });
  check('另一个客户端换个名字可以占名', claimB.ok, `HTTP ${claimB.status}`);

  const tooShort = await req('/api/nick/claim', { body: { clientId: 'verify-x', nick: ' ' } });
  check('空昵称被拒', tooShort.status === 400, `HTTP ${tooShort.status}`);

  // 3) 心跳 → 在线人数 / 投票门槛
  await live(A, NICK_A);
  const lv = await live(B, NICK_B);
  check('心跳返回在线人数与门槛', typeof lv.online === 'number' && typeof lv.need === 'number',
    `online=${lv.online} need=${lv.need}`);

  const s1 = await state();
  check('在线人数被正确统计（≥2）', Number(s1.online) >= 2, `online=${s1.online}`);
  check('投票门槛 = 过半（2 人 → 2 票）', Number(s1.voteNeed) === Math.floor(Number(s1.online) / 2) + 1,
    `need=${s1.voteNeed} online=${s1.online}`);

  const users = lv.users || [];
  check('在线名单带昵称且标记 myself', users.length >= 2 && users.some((u) => u.isMe),
    users.map((u) => u.nick + (u.isMe ? '(我)' : '')).join(', '));

  // 4) 聊天室
  const since0 = Number(s1.chatSeq) || 0;
  const MSG = '验收：聊天室链路正常 ' + new Date().toLocaleTimeString('zh-CN');
  const send = await req('/api/chat/send', { body: { clientId: A, text: MSG } });
  check('发消息成功', send.ok && send.json && send.json.ok === true,
    send.ok ? '' : `${send.status} ${JSON.stringify(send.json)}`);

  const chat = await req(`/api/chat?since=${since0}`);
  const msgs = (chat.json && (chat.json.messages || chat.json.msgs)) || [];
  check('增量拉取能拿到刚发的消息', msgs.some((m) => m.text === MSG),
    `拉到 ${msgs.length} 条，seq=${chat.json && (chat.json.seq || chat.json.chatSeq)}`);
  const mine = msgs.find((m) => m.text === MSG);
  if (mine) check('消息带上了昵称', mine.nick === NICK_A, `nick=${mine.nick}`);

  const anon = await req('/api/chat/send', { body: { clientId: 'verify-nobody', text: 'hi' } });
  check('没占昵称的人不能发言（403）', anon.status === 403, `HTTP ${anon.status}`);

  // 5) 点一首歌（优先用 NAS 曲库里的，秒播）
  const lib = await req('/api/library?limit=1');
  const item = lib.json && (lib.json.items || [])[0];
  let queued = null;
  if (item) {
    const enq = await req('/api/enqueue', {
      body: {
        song: { source: 'local', id: item.key, name: item.name, artist: item.artist, album: item.album || '' },
        requester: NICK_A,
      },
    });
    queued = enq.json && enq.json.ok ? enq.json.item : null;
    check('点歌成功（用 NAS 曲库里的歌，秒播）', !!queued,
      queued ? `《${queued.name}》cached=${enq.json.cached}` : `HTTP ${enq.status} ${JSON.stringify(enq.json)}`);
  } else {
    console.log('     ⚠️ NAS 曲库是空的，跳过点歌/投票相关断言');
  }

  if (queued) {
    // 等它起播（期间持续心跳，否则 A/B 掉线会让"过半"门槛失真）
    let cur = null;
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      await live(A, NICK_A);
      await live(B, NICK_B);
      const s = await state();
      if (s.current && s.current.name) {
        cur = s.current;
        break;
      }
    }
    check('歌曲已起播', !!cur, cur ? `《${cur.name}》` : '等待 14 秒仍未起播');

    if (cur) {
      const s2 = await state();
      const need = Number(s2.voteNeed) || 1;
      console.log(`     当前在线 ${s2.online} 人，切歌需要 ${need} 票`);

      // 第一票
      const v1 = await req('/api/skip', { body: { clientId: A, nick: NICK_A } });
      const st1 = voteOf(v1.json, await state());
      check('第 1 票被记录', Number(st1.votes) === 1, `votes=${st1.votes}/${st1.need} mode=${v1.json && v1.json.mode}`);
      if (need > 1) {
        check('票数不足时不会切歌', st1.passed === false && v1.json && v1.json.switched === false,
          `passed=${st1.passed} switched=${v1.json && v1.json.switched}`);
        const still = await state();
        check('歌还在播（没被切走）', !!still.current, still.current ? `《${still.current.name}》` : '(已被切走)');
      }
      check('投票人昵称回传给前端', Array.isArray(st1.voters) && st1.voters.some((x) => (x.nick || '') === NICK_A),
        JSON.stringify(st1.voters));

      // 撤销
      const undo = await req('/api/skip', { body: { clientId: A, nick: NICK_A } });
      const stU = voteOf(undo.json, await state());
      check('再点一次可撤销自己的票', Number(stU.votes) === 0, `votes=${stU.votes}`);

      // 凑够票数
      const nameBefore = (await state()).current && (await state()).current.name;
      await live(A, NICK_A);
      await live(B, NICK_B);
      await req('/api/skip', { body: { clientId: A, nick: NICK_A } });
      for (let i = 1; i < need; i++) {
        await req('/api/skip', { body: { clientId: B, nick: NICK_B } });
      }
      await sleep(900);
      const after = await state();
      const switched = !after.current || after.current.name !== nameBefore;
      check(`达到过半（${need} 票）→ 切歌成功`, switched,
        `现在在播《${(after.current && after.current.name) || '(空)'}》`);
      const st2 = after.vote || {};
      check('切歌后票数清零（不带到下一首）', Number(st2.votes) === 0, `votes=${st2.votes}`);
    }
  }

  // 6) 收尾
  await req('/api/clear', { body: {} });
  await req('/api/volume', { body: { volume: 15 } });
  await sleep(500);
  const fin = await state();
  check('收尾：队列已清空、音量恢复 15', (fin.queue || []).length === 0 && Number(fin.volume) === 15,
    `queue=${(fin.queue || []).length} volume=${fin.volume}`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log(
    `\n提示：本次验收占了两个昵称「${NICK_A}」「${NICK_B}」（持久占用）。\n` +
      `     想回收 → 编辑 NAS 上 /vol1/docker/xiaoai-jukebox/jukebox/data/nicks.json 删掉对应项后重启容器。`
  );
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n验收脚本自身出错：', e.message);
  process.exit(2);
});

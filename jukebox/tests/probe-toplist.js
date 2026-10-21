'use strict';
/**
 * 只读探测：QQ 音乐排行榜接口能不能拿到「可直接取链」的数据。
 * 不写任何文件、不改服务、不依赖已配置的凭据（排行榜元数据不需要 qm_keyst）。
 *
 * 用法：node tests/probe-toplist.js
 */
const { qqSign } = require('../server.js');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function call(label, url, body) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign(
        { 'User-Agent': UA },
        body ? { 'Content-Type': 'application/json' } : { Referer: 'https://y.qq.com/' }
      ),
      body: body ? body : undefined,
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    console.log(`\n[${label}] HTTP ${r.status} · ${text.length}B · ${Date.now() - t0}ms`);
    if (!json) {
      console.log('  非 JSON，前 200 字：', text.slice(0, 200));
      return null;
    }
    console.log('  顶层键：', Object.keys(json).slice(0, 8).join(', '));
    if (json.code !== undefined) console.log('  code =', json.code, json.msg || json.message || '');
    return json;
  } catch (e) {
    console.log(`\n[${label}] 请求失败：${e.message}`);
    return null;
  }
}

/** 从各种可能的响应形状里把歌曲数组挖出来 */
function digSongs(o) {
  const out = [];
  const seen = new Set();
  (function walk(v, depth) {
    if (!v || depth > 6 || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (Array.isArray(v.songInfoList)) out.push(...v.songInfoList);
    if (Array.isArray(v.songlist)) out.push(...v.songlist);
    if (typeof v.mid === 'string' && typeof v.name === 'string') {
      if (!seen.has(v.mid)) {
        seen.add(v.mid);
        out.push(v);
      }
    }
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  })(o, 0);
  return out;
}

function brief(s) {
  const mid = s.mid || s.songmid || s.songMid || '';
  const mediaMid = s.file && s.file.media_mid ? s.file.media_mid : s.media_mid || s.mediaMid || '';
  const singers = (s.singer || []).map((x) => x.name).join('/') || s.singername || '';
  return {
    name: s.name || s.songname || s.title,
    singers,
    mid,
    mediaMid,
    interval: s.interval || 0,
    album: (s.album && (s.album.name || s.album.title)) || s.albumname || '',
  };
}

(async () => {
  console.log('===== QQ 音乐排行榜 只读探测 =====');

  // ① 新版：musicu.fcg 的榜单列表
  const allBody = JSON.stringify({
    comm: { ct: 24, cv: 0 },
    req_1: { module: 'musicToplist.ToplistInfoServer', method: 'GetAll', param: {} },
  });
  const all = await call(
    'GetAll（榜单列表）',
    'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&sign=' + qqSign(allBody),
    allBody
  );
  if (all) {
    const lists = [];
    (function walk(v, d) {
      if (!v || d > 6 || typeof v !== 'object') return;
      if (Array.isArray(v)) return v.forEach((x) => walk(x, d + 1));
      if (v.topId !== undefined && (v.title || v.name)) lists.push({ topId: v.topId, name: v.title || v.name });
      Object.keys(v).forEach((k) => walk(v[k], d + 1));
    })(all, 0);
    console.log('  榜单数量：', lists.length);
    console.log('  前 12 个：', lists.slice(0, 12).map((x) => `${x.topId}=${x.name}`).join(' · '));
  }

  // ② 新版：热歌榜详情（topId 26）
  const detailBody = JSON.stringify({
    comm: { ct: 24, cv: 0 },
    req_1: {
      module: 'musicToplist.ToplistInfoServer',
      method: 'GetDetail',
      param: { topId: 26, offset: 0, num: 10, period: '' },
    },
  });
  const detail = await call(
    'GetDetail topId=26（热歌榜）',
    'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&sign=' + qqSign(detailBody),
    detailBody
  );
  if (detail) {
    const songs = digSongs(detail);
    console.log('  解析到曲目：', songs.length);
    songs.slice(0, 6).forEach((s, i) => console.log(`   ${i + 1}.`, JSON.stringify(brief(s))));
    const withMedia = songs.filter((s) => brief(s).mediaMid).length;
    const withMid = songs.filter((s) => brief(s).mid).length;
    console.log(`  含 mid：${withMid}/${songs.length} · 含 media_mid：${withMedia}/${songs.length}`);
  }

  // ③ 老免签接口（只做对照，看还在不在）
  const oldJson = await call(
    '老接口 fcg_v8_toplist_cp（topid=26）',
    'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=26&format=json&page=detail&type=top&song_begin=0&song_num=5&g_tk=5381&platform=yqq&needNewCode=1'
  );
  if (oldJson) {
    const songs = digSongs(oldJson);
    console.log('  解析到曲目：', songs.length);
    songs.slice(0, 3).forEach((s, i) => console.log(`   ${i + 1}.`, JSON.stringify(brief(s))));
  }

  // ④ 换个榜单（飙升榜 4 / 新歌榜 27）各取 3 首，看是否通用
  for (const topId of [4, 27, 62]) {
    const b = JSON.stringify({
      comm: { ct: 24, cv: 0 },
      req_1: {
        module: 'musicToplist.ToplistInfoServer',
        method: 'GetDetail',
        param: { topId, offset: 0, num: 3, period: '' },
      },
    });
    const j = await call(`GetDetail topId=${topId}`, 'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&sign=' + qqSign(b), b);
    if (j) {
      const songs = digSongs(j);
      console.log('  曲目：', songs.length, '｜', songs.slice(0, 3).map((s) => brief(s).name + ' - ' + brief(s).singers).join(' / '));
    }
  }

  console.log('\n===== 探测结束（全程只读）=====');
})();

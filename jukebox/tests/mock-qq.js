'use strict';
/**
 * 模拟 QQ 音乐 musics.fcg（给 QQ 自建音源的离线测试用）
 *
 * 它做三件事：
 *   ① 校验签名 —— 用 server.js 里同一份 qqSign 复算，对不上就记 badSign（证明我们签的是发出去的那份 body）
 *   ② 按 module 分发：搜索返回 3 首带 media_mid 的歌；取链按 filename 前缀返回对应的 purl
 *   ③ 提供 /audio/<file> 供下载（带 Range，和真实 CDN 一样）
 *
 * 故障注入（复现真实会遇到的情况）：
 *   POST /__mode {"searchCode":2000}          → 搜索接口回业务错误码（相当于 key 失效）
 *   POST /__mode {"vkeyCode":2000}            → 取链接口回错误码（签名/凭据问题）
 *   POST /__mode {"emptyPurl":true}           → 取链成功但 purl 为空（= 没版权/会员不够）
 *   POST /__mode {"denyQuality":["320k"]}     → 指定音质档位拿不到链，用来验降级
 *   POST /__mode {"clear":true}               → 全部恢复
 *   POST /__mode {"toplistCode":2000}        → 榜单接口回错误码（模拟接口变更/风控）
 *
 * GET /__stats → { search, vkey, toplistLists, toplistDetail, badSign, lastFiles, lastAuthst }
 *
 * 环境变量：MOCK_QQ_PORT（默认 58097）
 */
const http = require('http');

const PORT = Number(process.env.MOCK_QQ_PORT || 58097);

/** 结构合法的静音 MP3（ID3v2 头 + MPEG1 Layer3 帧），和 mock-source 同一套做法 */
function makeMp3(targetBytes = 300000) {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x64;
  const frames = [];
  let total = id3.length;
  while (total < targetBytes) {
    frames.push(frame);
    total += frame.length;
  }
  return Buffer.concat([id3, ...frames]);
}
const MP3 = makeMp3();

const mode = { searchCode: 0, vkeyCode: 0, emptyPurl: false, denyQuality: [], toplistCode: 0 };
const stats = {
  search: 0, vkey: 0, toplistLists: 0, toplistDetail: 0,
  badSign: 0, lastFiles: [], lastAuthst: '', lastUin: '', lastTopId: null, lastTopNum: null,
};

/** 榜单 mock：曲目故意和搜索用同一套 mid/media，取链逻辑不用另写一份 */
// 真实 QQ 音乐有 30 个榜、分 6 个组 —— mock 也照这个规模造，否则截图看不出分组/滚动效果
const TOP_LISTS = [
  ...[26, 62, 4, 27, 3].map((topId, i) => ({ topId, group: '巅峰榜', title: ['热歌榜', '飙升榜', '新歌榜', '流行指数榜', '说唱榜'][i] })),
  ...[5, 6, 7, 8, 9].map((topId, i) => ({ topId, group: '地区榜', title: ['内地榜', '港台榜', '欧美榜', '韩国榜', '日本榜'][i] })),
  ...[10, 11, 12, 13, 14].map((topId, i) => ({ topId, group: '主题榜', title: ['网络歌曲榜', '影视金曲榜', '动漫榜', '游戏榜', '经典老歌榜'][i] })),
  ...[15, 16, 17, 18, 19].map((topId, i) => ({ topId, group: '场景榜', title: ['通勤路上', '深夜电台', '运动燃脂', '睡前轻音乐', '咖啡时间'][i] })),
  ...[20, 21, 22, 23, 24].map((topId, i) => ({ topId, group: '风格榜', title: ['摇滚榜', '民谣榜', '电音榜', '古风榜', '爵士榜'][i] })),
  ...[28, 29, 30, 31, 32].map((topId, i) => ({ topId, group: '电台榜', title: ['私人FM热播', '会员尊享榜', '每日推荐', '新歌速递', '编辑精选'][i] })),
];
const TOP_GROUPS = [...new Set(TOP_LISTS.map((x) => x.group))];
function topSongs(num) {
  return Array.from({ length: Math.max(1, num) }).map((_, i) => ({
    name: `榜单曲${i + 1}`,
    singer: [{ name: i % 2 ? '榜单歌手B' : '榜单歌手A' }],
    mid: `qqt${i}`,
    file: { media_mid: `qqtm${i}`, size_320mp3: 1, size_flac: 1 },
    interval: 180 + i,
    album: { name: `榜单专辑${i + 1}` },
  }));
}

/** 复算签名：从 server.js 借同一份实现（模拟"服务端校验"，比自写一遍更有意义） */
let qqSign = null;
try {
  qqSign = require('../server.js').qqSign;
} catch {
  /* 拿不到就只检查 sign 是否存在 */
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => resolve(s));
  });
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

/** 按 filename 前缀反推音质档位：M500=128k M800=320k F000=flac */
function qualityOf(filename) {
  if (filename.startsWith('F000')) return 'flac';
  if (filename.startsWith('M800')) return '320k';
  if (filename.startsWith('M500')) return '128k';
  return '?';
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');

    // ---- 音频下载（模拟 CDN）
    if (u.pathname.startsWith('/audio/')) {
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), MP3.length - 1) : MP3.length - 1;
        res.writeHead(206, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${MP3.length}`,
          'Accept-Ranges': 'bytes',
        });
        return res.end(MP3.slice(start, end + 1));
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': MP3.length, 'Accept-Ranges': 'bytes' });
      return res.end(MP3);
    }

    // ---- 故障注入 / 统计
    if (u.pathname === '/__mode') {
      if (req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        if (b.clear) {
          mode.searchCode = 0;
          mode.vkeyCode = 0;
          mode.emptyPurl = false;
          mode.denyQuality = [];
          mode.toplistCode = 0;
        }
        if (b.searchCode != null) mode.searchCode = Number(b.searchCode);
        if (b.vkeyCode != null) mode.vkeyCode = Number(b.vkeyCode);
        if (b.emptyPurl != null) mode.emptyPurl = !!b.emptyPurl;
        if (Array.isArray(b.denyQuality)) mode.denyQuality = b.denyQuality.slice();
        if (b.toplistCode != null) mode.toplistCode = Number(b.toplistCode);
      }
      return send(res, 200, JSON.stringify(mode));
    }
    if (u.pathname === '/__stats') {
      if (req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        if (b.clear) {
          stats.search = 0;
          stats.vkey = 0;
          stats.toplistLists = 0;
          stats.toplistDetail = 0;
          stats.badSign = 0;
          stats.lastFiles = [];
          stats.lastAuthst = '';
          stats.lastUin = '';
          stats.lastTopId = null;
          stats.lastTopNum = null;
        }
      }
      return send(res, 200, JSON.stringify({ ...stats, mode }));
    }

    // ---- QQ 接口本体
    if (u.pathname !== '/cgi-bin/musics.fcg') return send(res, 404, '{"error":"not found"}');

    const raw = await readBody(req);
    const sign = u.searchParams.get('sign') || '';
    if (!sign || (qqSign && sign !== qqSign(raw))) {
      stats.badSign += 1;
      return send(res, 200, JSON.stringify({ code: 2000, message: 'sign mismatch' }));
    }

    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 200, JSON.stringify({ code: 2000, message: 'bad json' }));
    }

    // 搜索
    const r1 = body.req_1;
    if (r1 && /SearchCgiService/.test(r1.module || '')) {
      stats.search += 1;
      if (mode.searchCode) return send(res, 200, JSON.stringify({ code: mode.searchCode }));
      const kw = String(r1.param?.query || '').trim();
      const base = kw.split(/\s+/)[0] || '测试';
      const songs = [0, 1, 2].map((i) => ({
        name: i === 0 ? base : `${base} (版本${i})`,
        singer: [{ name: '测试歌手' }],
        mid: `qqmid${i}`,
        file: { media_mid: `qqmedia${i}` },
        interval: 200 + i,
        album: { name: '测试专辑', mid: 'albm' },
      }));
      return send(res, 200, JSON.stringify({ code: 0, req_1: { data: { body: { song: { list: songs } } } } }));
    }

    // 排行榜：列表 + 详情
    if (r1 && /ToplistInfoServer/.test(r1.module || '')) {
      if (mode.toplistCode) return send(res, 200, JSON.stringify({ code: mode.toplistCode }));
      const method = String(r1.method || '');
      if (/GetAll/.test(method)) {
        stats.toplistLists += 1;
        const group = TOP_GROUPS.map((g, gi) => ({
          groupId: gi,
          groupName: g,
          toplist: TOP_LISTS.filter((x) => x.group === g).map((x) => ({ topId: x.topId, title: x.title })),
        }));
        return send(res, 200, JSON.stringify({ code: 0, req_1: { data: { group } } }));
      }
      if (/GetDetail/.test(method)) {
        stats.toplistDetail += 1;
        stats.lastTopId = Number(r1.param?.topId) || 0;
        stats.lastTopNum = Number(r1.param?.num) || 0;
        const meta = TOP_LISTS.find((x) => x.topId === stats.lastTopId) || { title: '未知榜' };
        return send(res, 200, JSON.stringify({
          code: 0,
          req_1: {
            data: {
              // ⚠️ 真实接口就是这个形状：歌在 songInfoList，data.data 是榜单元信息
              songInfoList: topSongs(stats.lastTopNum),
              data: { topId: stats.lastTopId, title: meta.title, updateTime: '2026-10-21', totalNum: 300 },
            },
          },
        }));
      }
    }

    // 取链
    const r0 = body.req_0;
    if (r0 && /GetVkeyServer/.test(r0.module || '')) {
      stats.vkey += 1;
      const filename = String(r0.param?.filename?.[0] || '');
      stats.lastFiles.push(filename);
      stats.lastAuthst = String(body.comm?.authst || '').slice(0, 6) + '…';
      stats.lastUin = String(body.comm?.qq || '');
      if (mode.vkeyCode) return send(res, 200, JSON.stringify({ code: mode.vkeyCode }));
      const q = qualityOf(filename);
      const denied = mode.emptyPurl || mode.denyQuality.includes(q);
      const info = denied
        ? { purl: '', result: 104003, subcode: 0, filename }
        : { purl: `audio/${filename}`, result: 0, subcode: 0, filename };
      return send(
        res,
        200,
        JSON.stringify({
          code: 0,
          req_0: { data: { sip: [`http://127.0.0.1:${PORT}/`], midurlinfo: [info] } },
        })
      );
    }

    send(res, 200, JSON.stringify({ code: 2000, message: 'unknown module' }));
  })
  .listen(PORT, '127.0.0.1', () => {
    console.error(`[mock-qq] QQ 接口 mock 已启动 http://127.0.0.1:${PORT}（mp3 ${(MP3.length / 1024).toFixed(0)}KB）`);
  });

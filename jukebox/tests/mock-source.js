'use strict';
/**
 * 模拟 GD Studio 兼容音乐 API + 音频文件服务。
 * 让端到端测试不依赖外网音源（外网会限流/波动）。
 *
 * 环境变量：MOCK_SRC_PORT（默认 58098）
 */
const http = require('http');

const PORT = Number(process.env.MOCK_SRC_PORT || 58098);

/** 生成结构合法的静音 MP3（ID3v2 头 + MPEG1 Layer3 帧） */
function makeMp3(targetBytes = 420000) {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // "ID3"
  const frame = Buffer.alloc(417); // 128kbps @44.1kHz → 144*128000/44100 ≈ 417
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

/** 1×1 透明 PNG */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const TITLES = {
  netease: ['晴天', '七里香', '稻香', '告白气球', '青花瓷'],
  kugou: ['晴天 (Live)', '稻香 (伴奏)', '夜曲'],
  tencent: ['晴天 - 周杰伦', '简单爱'],
  migu: ['晴天 (醇享版)'],
};

const ARTISTS = ['周杰伦', '五月天', '陈奕迅'];

/**
 * 故障注入：用来复现"音源限流"。
 * POST /__fault  {"url503Ms":6000} → 未来这段时间内所有取直链请求返回 503
 * GET  /__fault                   → 查看当前状态
 *
 * 故障注入：复现"接口已不支持某个源"（GD Studio 2026-10 就是这么砍掉
 * kugou/tencent/migu/kuwo 的，返回 400 + "Value of `source` is not supported"）。
 * POST /__unsupported {"search":["kugou"],"url":["migu"]} → 这些源对应动作回 400
 * POST /__unsupported {"clear":true}                       → 全部恢复
 *
 * POST /__stats   {"clear":true} → 清空请求计数
 * GET  /__stats                 → 每个源的 search/url 请求次数（验证熔断有没有生效）
 */
let url503Until = 0;
const unsupportedSearch = new Set();
const unsupportedUrl = new Set();
/** source -> { search:n, url:n, total:n } */
const stats = {};

function countReq(source, kind) {
  const s = (stats[source] = stats[source] || { search: 0, url: 0 });
  s[kind] = (s[kind] || 0) + 1;
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => {
      try {
        resolve(JSON.parse(s || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const q = u.searchParams;

    // ---- 故障注入控制
    if (u.pathname === '/__fault') {
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (b.url503Ms) url503Until = Date.now() + Number(b.url503Ms);
        if (b.clear) url503Until = 0;
      }
      return send(res, 200, JSON.stringify({ url503: url503Until > Date.now(), leftMs: Math.max(0, url503Until - Date.now()) }));
    }

    // ---- "这个源不被支持"注入 + 请求计数
    if (u.pathname === '/__unsupported') {
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (b.clear) {
          unsupportedSearch.clear();
          unsupportedUrl.clear();
        }
        for (const s of b.search || []) unsupportedSearch.add(s);
        for (const s of b.url || []) unsupportedUrl.add(s);
      }
      return send(res, 200, JSON.stringify({ search: [...unsupportedSearch], url: [...unsupportedUrl] }));
    }
    if (u.pathname === '/__stats') {
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (b.clear) for (const k of Object.keys(stats)) delete stats[k];
      }
      return send(res, 200, JSON.stringify(stats));
    }

    // ---- 音频文件
    if (u.pathname.startsWith('/mp3/')) {
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? parseInt(m[2], 10) : MP3.length - 1;
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

    const types = q.get('types');
    const source = q.get('source') || 'netease';
    if (types === 'search' || types === 'url') countReq(source, types);

    // 模拟"接口已不支持这个源"：真实 GD Studio 就是这么回 400 的
    if (types === 'search' && unsupportedSearch.has(source)) {
      return send(res, 400, JSON.stringify({ detail: 'Value of `source` is not supported.' }));
    }
    if (types === 'url' && unsupportedUrl.has(source)) {
      return send(res, 400, JSON.stringify({ detail: 'Value of `source` is not supported.' }));
    }

    // ---- 搜索
    if (types === 'search') {
      const kw = q.get('name') || '';
      const count = Math.min(Number(q.get('count') || 10), 20);
      const pool = TITLES[source] || [`${kw} (${source})`];
      const list = [];
      for (let i = 0; i < Math.min(count, pool.length); i++) {
        list.push({
          id: `${source}-${i}`,
          name: pool[i],
          artist: [ARTISTS[i % ARTISTS.length]],
          album: '测试专辑',
          pic_id: `pic-${i}`,
          url_id: `${source}-${i}`,
          lyric_id: `${source}-${i}`,
          source,
          from: 'mock',
        });
      }
      return send(res, 200, JSON.stringify(list));
    }

    // ---- 取直链
    if (types === 'url') {
      if (url503Until > Date.now()) {
        return send(res, 503, 'Service Temporarily Unavailable', 'text/html; charset=utf-8');
      }
      const id = q.get('id') || 'x';
      return send(
        res,
        200,
        JSON.stringify({
          url: `http://127.0.0.1:${PORT}/mp3/${encodeURIComponent(id)}.mp3`,
          br: Number(q.get('br') || 320),
          size: MP3.length,
        })
      );
    }

    // ---- 封面
    if (types === 'pic') {
      return send(res, 200, PNG, 'image/png');
    }

    // ---- 歌词
    if (types === 'lyric') {
      return send(res, 200, JSON.stringify({ lyric: '[00:00.00] 测试歌词', tlyric: '' }));
    }

    send(res, 404, JSON.stringify({ error: 'unknown type' }));
  })
  .listen(PORT, '127.0.0.1', () => {
    console.error(`[mock-src] 音乐 API mock 已启动 http://127.0.0.1:${PORT}（mp3 ${(MP3.length / 1024).toFixed(0)}KB）`);
  });

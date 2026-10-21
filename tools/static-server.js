// 极简静态服务 + songloft 反向代理（零依赖）
//   node static-server.js <port> <rootDir> [proxyTarget]
//   静态：/*            → <rootDir>
//   代理：/sl/*         → <proxyTarget>/*   （同源，彻底绕开 CORS / CSP connect-src / 局域网隔离）
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = parseInt(process.argv[2] || '58193', 10);
const root = path.resolve(process.argv[3] || '.');
const proxyTarget = process.argv[4] || 'http://192.168.1.100:58091';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.md': 'text/markdown; charset=utf-8'
};

function withCors(h) {
  h['Access-Control-Allow-Origin'] = '*';
  h['Access-Control-Allow-Headers'] = '*';
  h['Access-Control-Allow-Methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
  h['Access-Control-Expose-Headers'] = '*';
  return h;
}

function proxy(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, withCors({}));
    return res.end();
  }
  let t;
  try { t = new URL(proxyTarget); }
  catch (e) { res.writeHead(500); return res.end('bad proxyTarget'); }

  const sub = req.url.replace(/^\/sl/, '') || '/';
  const headers = Object.assign({}, req.headers);
  headers.host = t.host;
  delete headers.origin;
  delete headers.referer;

  const p = http.request(
    { hostname: t.hostname, port: t.port || 80, path: sub, method: req.method, headers },
    (pr) => {
      res.writeHead(pr.statusCode || 502, withCors(Object.assign({}, pr.headers)));
      pr.pipe(res);
    }
  );
  p.on('error', (e) => {
    console.log('[proxy] ERR', req.method, sub, e.message);
    res.writeHead(502, withCors({ 'Content-Type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify({ error: 'proxy 连接 songloft 失败: ' + e.message }));
  });
  req.pipe(p);
}

const server = http.createServer((req, res) => {
  if (req.url === '/sl' || req.url.startsWith('/sl/') || req.url.startsWith('/sl?')) {
    return proxy(req, res);
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end('not found: ' + p); }
    if (st.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    });
  });
});

server.on('error', (e) => {
  console.error('server error:', e.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log('static  http://127.0.0.1:' + port + '  root=' + root);
  console.log('proxy   http://127.0.0.1:' + port + '/sl/*  →  ' + proxyTarget);
});

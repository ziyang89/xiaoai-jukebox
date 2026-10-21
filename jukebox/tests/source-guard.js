#!/usr/bin/env node
/**
 * 音源「死源」处理 —— 端到端测试
 * ------------------------------------------------------------------
 * 背景（2026-10-19 实测 GD Studio）：
 *   该接口的 source 取值只剩 netease / joox / bilibili；
 *   kuwo / kugou / tencent / migu / qq / tidal / spotify / qobuz /
 *   deezer / ytmusic / apple / ximalaya 一律返回
 *     400 {"detail":"Value of `source` is not supported."}
 *
 * 而旧配置把 kugou/tencent/migu 写进了 sources 和 searchSources。后果不是"多一层保险"，
 * 而是每次失败都要：单源重试 3 次 × 逐个降级 × 每次降级前还要先搜索定位 → 白烧十几倍配额
 * → 更容易撞上「5 分钟 50 次」的限制。用户报的「音源会限流」有一半是自己烧出来的。
 *
 * 本测试锁定三条行为：
 *   A. 搜到一次 400「不支持」→ 该源进入熔断，后续搜索**不再打它**；
 *   B. 取链遇到 400「不支持」→ **不重试**（retry=3 也只打 1 次）；
 *   C. 这类永久错误**不进重试队列空转**（history 里应写「试 1 次」，而不是 5 次）。
 *
 * 用法：node tests/source-guard.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const APP_PORT = 58186;
const MOCK_PORT = 58084; // 播放引擎 mock
const MOCK_SRC_PORT = 58083; // 音源 mock
const RUN_DIR = path.join(__dirname, '.run-source');
const APP = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const SRC = `http://127.0.0.1:${MOCK_SRC_PORT}`;

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
const stats = () => j(`${SRC}/__stats`);
const unsupported = (body) => post(`${SRC}/__unsupported`, body);
const clearStats = () => post(`${SRC}/__stats`, { clear: true });

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

function pipe(proc, bucket) {
  proc.stdout.on('data', (d) => bucket.push(d.toString()));
  proc.stderr.on('data', (d) => bucket.push(d.toString()));
}

async function main() {
  console.log('\n===== 音源死源熔断 / 永久错误不重试 =====\n');

  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DIR, 'music'), { recursive: true });
  fs.mkdirSync(path.join(RUN_DIR, 'data'), { recursive: true });

  // 故意沿用"旧配置"：把 kugou 写在搜索源和降级链里，看它会不会被正确熔断
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
    sources: ['netease', 'kugou'],
    searchSources: ['netease', 'kugou'],
    gdApi: `${SRC}/`,
    retry: 3,
    volume: 0,
    pollIntervalMs: 700,
    minPlaySec: 0,
    prefetchCount: 0, // 关掉预下载，把请求计数锁定在"起播取链"这一条路径上
    maxTries: 5,
    logLevel: 'info',
  };
  const cfgPath = path.join(RUN_DIR, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // ---------- 启动 mock ----------
  mockProc = spawn(NODE, [path.join(__dirname, 'mock-songloft.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '20', MOCK_SPEED: '8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipe(mockProc, appLog);
  await waitFor(async () => (await fetch(`${MOCK}/__log`)).ok, { label: 'mock 引擎就绪', timeout: 10000 });

  srcProc = spawn(NODE, [path.join(__dirname, 'mock-source.js')], {
    env: { ...process.env, MOCK_SRC_PORT: String(MOCK_SRC_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipe(srcProc, appLog);
  await waitFor(
    async () => (await fetch(`${SRC}/?types=search&name=x&count=1&source=netease`)).ok,
    { label: 'mock 音源就绪', timeout: 10000 }
  );

  appProc = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, JB_CONFIG: cfgPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipe(appProc, appLog);
  await waitFor(
    async () => {
      const h = await j(`${APP}/api/health`).catch(() => null);
      return h && h.ok ? h : null;
    },
    { label: '点歌台就绪', timeout: 20000 }
  );
  check('服务启动', true, `:${APP_PORT}`);

  // ================= 回合 A：搜索遇到「源不支持」→ 熔断 =================
  console.log('\n--- A. 搜索源返回 400「not supported」 ---');
  await unsupported({ clear: true, search: ['kugou'] });
  await clearStats();

  const r1 = await j(`${APP}/api/search?q=${encodeURIComponent('稻香')}&limit=5`);
  const s1 = await stats();
  check('搜索仍能拿到结果（netease 正常）', (r1.results || []).length > 0, `${(r1.results || []).length} 条`);
  check(
    '不支持源只被打了一次',
    s1.kugou && s1.kugou.search === 1,
    `kugou 请求 ${s1.kugou ? s1.kugou.search : 0} 次`
  );

  const st1 = await state();
  check('不支持源已进入熔断名单', (st1.deadSources || []).includes('kugou'), JSON.stringify(st1.deadSources || []));

  // 换关键词避开 90 秒搜索缓存，看它还会不会再去打 kugou
  const r2 = await j(`${APP}/api/search?q=${encodeURIComponent('七里香')}&limit=5`);
  const s2 = await stats();
  check('第二次搜索仍然正常出结果', (r2.results || []).length > 0, `${(r2.results || []).length} 条`);
  check(
    '熔断后不再请求该源',
    s2.kugou && s2.kugou.search === 1,
    `kugou 请求仍为 ${s2.kugou ? s2.kugou.search : 0} 次（未增加）`
  );
  check(
    '省下的配额是实打实的',
    s2.netease && s2.netease.search >= 2 && s2.kugou && s2.kugou.search === 1,
    `netease ${s2.netease ? s2.netease.search : 0} 次 / kugou ${s2.kugou ? s2.kugou.search : 0} 次`
  );

  // ================= 回合 B：取链遇到「源不支持」→ 不重试、不空转 =================
  console.log('\n--- B. 取链接返回 400「not supported」（retry=3） ---');
  await unsupported({ clear: true, url: ['netease'] });
  await clearStats();

  const found = await j(`${APP}/api/search?q=${encodeURIComponent('青花瓷')}&limit=3`);
  const song = (found.results || [])[0];
  check('找到一首歌用于点播', !!song, song ? `${song.name} — ${song.artist}（${song.source}）` : '');

  await post(`${APP}/api/enqueue`, { song, requester: '熔断测试' });

  const done = await waitFor(async () => {
    const s = await state();
    const failed = (s.history || []).find((h) => h.reason && /失败/.test(h.reason));
    return failed || null;
  }, { label: '起播失败落进历史', timeout: 25000 });

  const s3 = await stats();
  const urlCalls = s3.netease ? s3.netease.url : 0;
  check('永久错误不重试（retry=3 也只打 1 次）', urlCalls === 1, `netease 取链请求 ${urlCalls} 次`);
  check('没有空转重试（历史记「试 1 次」）', /试 1 次/.test(done.reason), done.reason);
  check(
    '失败原因如实告诉用户',
    /不被接口支持|不支持|不可用|熔断/.test(done.reason),
    done.reason
  );

  const st2 = await state();
  check('该源也被熔断', (st2.deadSources || []).includes('netease'), JSON.stringify(st2.deadSources || []));

  // 再点同一首：此时源已熔断，应该连一次请求都不打（也不用重新搜索）
  await clearStats();
  await post(`${APP}/api/enqueue`, { song, requester: '熔断测试' });
  await waitFor(async () => {
    const s = await state();
    return !s.current && s.queue.length === 0 ? s : null;
  }, { label: '第二次点歌也失败完', timeout: 25000 }).catch(() => null);
  const s4 = await stats();
  check(
    '已熔断的源连试都不试（0 次请求）',
    !s4.netease || !s4.netease.url || s4.netease.url === 0,
    `netease 取链请求 ${s4.netease ? s4.netease.url || 0 : 0} 次`
  );

  // ================= 汇总 =================
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== 结果：${pass}/${results.length} 通过 =====`);
  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    console.log('\n失败项：');
    bad.forEach((b) => console.log(`  ❌ ${b.name}${b.detail ? '  — ' + b.detail : ''}`));
    console.log('\n--- 服务日志尾部 ---');
    console.log(appLog.join('').split('\n').slice(-30).join('\n'));
  }
  process.exitCode = bad.length ? 1 : 0;
}

main()
  .catch((e) => {
    console.error('\n测试异常：', e.stack || e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });

'use strict';
// 精确复现 server.js 里的音源请求逻辑，定位真实错误
const CONFIG = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const GD_API = 'https://music-api.gdstudio.xyz/api.php';

async function gdRequest(params, timeoutMs = 15000) {
  const qs = new URLSearchParams(params).toString();
  const url = `${GD_API}?${qs}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': CONFIG.userAgent, Accept: 'application/json,*/*' },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (!text || !text.trim()) throw new Error('空响应');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('非 JSON 响应（可能被风控拦截）');
    }
    if (data && data.error) throw new Error(String(data.error));
    return data;
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log('--- 用 server.js 的同款逻辑请求 ---');
  try {
    const d = await gdRequest({ types: 'search', source: 'netease', name: '晴天', count: '3', pages: '1' });
    console.log('✅ 成功，条数:', Array.isArray(d) ? d.length : typeof d);
    console.log('   首条:', JSON.stringify((d || [])[0] || {}).slice(0, 180));
  } catch (e) {
    console.log('❌ 失败:', e.name, '|', e.message);
    if (e.cause) console.log('   cause:', e.cause.code || e.cause.message);
  }

  console.log('\n--- 对比：去掉 Accept 头 ---');
  try {
    const r = await fetch(`${GD_API}?types=search&source=netease&name=${encodeURIComponent('晴天')}&count=3&pages=1`, {
      headers: { 'User-Agent': CONFIG.userAgent },
      signal: AbortSignal.timeout(15000),
    });
    const t = await r.text();
    console.log('✅ HTTP', r.status, '长度', t.length);
  } catch (e) {
    console.log('❌ 失败:', e.name, '|', e.message, '|', e.cause?.code || '');
  }
})();

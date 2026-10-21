#!/usr/bin/env node
'use strict';
/**
 * 音源可用性实测（只读，不改任何配置）
 *
 *   node tests/probe-sources.js            # 默认探 netease kuwo joox kugou tencent migu
 *   node tests/probe-sources.js kuwo joox  # 只探指定源
 *
 * 每个源做两步，任一步失败即判定该源不可用：
 *   ① search  —— 能否搜到结果
 *   ② url     —— 能否拿到 http(s) 直链，并用 HEAD/Range 确认返回音频
 *
 * ⚠️ GD Studio 公共实例限制「5 分钟 50 次请求」。本脚本每源消耗 2 次，
 *    默认 6 源 = 12 次，安全。别在短时间内反复跑。
 */

const DEFAULT_SOURCES = ['netease', 'kuwo', 'joox', 'kugou', 'tencent', 'migu'];
const API = process.env.JB_GD_API || 'https://music-api.gdstudio.xyz/api.php';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(params, timeoutMs = 15000) {
  const url = `${API}?${new URLSearchParams(params)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,*/*' }, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}${text ? ' ' + text.slice(0, 80) : ''}`);
    if (!text.trim()) throw new Error('空响应');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('非 JSON（可能被风控拦截）');
    }
    if (data && data.error) throw new Error(String(data.error));
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** 直链是不是真的能拉到音频（音箱会裸直连，所以要验不带 Referer 也能拿） */
async function probeAudio(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-2047' },
      signal: ctl.signal,
      redirect: 'follow',
    });
    const ct = r.headers.get('content-type') || '';
    const len = r.headers.get('content-length') || '';
    // 只读前 2KB 就够判格式：用 reader 读一次后立刻 cancel，别先 arrayBuffer 再 cancel（流会锁住）
    const reader = r.body && r.body.getReader();
    let buf = Buffer.alloc(0);
    if (reader) {
      const first = await reader.read();
      buf = Buffer.from(first.value || []);
      try {
        await reader.cancel();
      } catch {
        /* 已结束就无所谓 */
      }
    }
    return {
      status: r.status,
      ok: r.ok || r.status === 206,
      type: ct,
      len,
      head: buf.subarray(0, 4).toString('hex'),
      isAudio: /audio|octet-stream|mpeg|mp4/i.test(ct) || buf.subarray(0, 3).toString('latin1') === 'ID3',
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function probeOne(source, keyword) {
  const out = { source, search: false, url: false, note: '', sample: '', audio: null };
  let song;
  try {
    const data = await get({ types: 'search', source, name: keyword, count: '3', pages: '1' });
    const list = Array.isArray(data) ? data : [];
    if (!list.length) {
      out.note = '搜索无结果';
      return out;
    }
    out.search = true;
    out.sample = `${list[0].name || '?'} — ${list[0].artist || '?'}`.slice(0, 40);
    song = list[0];
  } catch (e) {
    out.note = `搜索失败：${e.message}`;
    return out;
  }

  try {
    const data = await get({ types: 'url', source, id: song.id, br: '320' });
    const url = typeof data === 'string' ? data : data && data.url;
    if (!url || !/^https?:\/\//i.test(url)) throw new Error('未返回有效直链');
    out.url = true;
    out.audio = await probeAudio(url);
    if (!out.audio.ok) out.note = `直链 HTTP ${out.audio.status} ${out.audio.error || ''}`.trim();
    else if (!out.audio.isAudio) out.note = `直链返回非音频：${out.audio.type || '?'}`;
    else out.note = `${out.audio.type} ${out.audio.len ? Math.round(Number(out.audio.len) / 1024) + 'KB' : ''}`.trim();
  } catch (e) {
    out.note = `取链失败：${e.message}`;
  }
  return out;
}

async function main() {
  const sources = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const list = sources.length ? sources : DEFAULT_SOURCES;
  const keyword = process.env.JB_PROBE_KEYWORD || '周杰伦 晴天';

  console.log(`音源实测  API=${API}`);
  console.log(`探针关键词：「${keyword}」  共 ${list.length} 个源（约 ${list.length * 2} 次请求）\n`);

  const rows = [];
  for (const src of list) {
    const r = await probeOne(src, keyword);
    rows.push(r);
    const icon = r.search && r.url && r.audio && r.audio.ok && r.audio.isAudio ? '✅' : r.search ? '⚠️ ' : '❌';
    console.log(`${icon} ${src.padEnd(9)} 搜索${r.search ? '✓' : '✗'}  取链${r.url ? '✓' : '✗'}  ${r.note}`);
    if (r.sample) console.log(`           样本：${r.sample}`);
    await sleep(600); // 温和一点，别自己把自己限流了
  }

  const ok = rows.filter((r) => r.search && r.url && r.audio && r.audio.ok && r.audio.isAudio).map((r) => r.source);
  const soft = rows.filter((r) => r.search && r.url && !(r.audio && r.audio.ok && r.audio.isAudio)).map((r) => r.source);
  const dead = rows.filter((r) => !r.search).map((r) => r.source);

  console.log('\n================ 结论 ================');
  console.log('完全可用（搜到 + 直链可拉音频）：', ok.length ? ok.join(', ') : '(无)');
  console.log('能搜能取链但音频验证没过 ：', soft.length ? soft.join(', ') : '(无)');
  console.log('搜索就失败（视为不可用） ：', dead.length ? dead.join(', ') : '(无)');
  console.log('\n建议 sources 顺序：', ok.join(', ') || '(无可用源)');
  process.exitCode = ok.length ? 0 : 1;
}

main().catch((e) => {
  console.error('实测脚本异常：', e);
  process.exitCode = 1;
});

#!/usr/bin/env node
/**
 * QQ 会员直链的「能不能真用」深挖探测（需要会员 key）
 *
 * 用法：
 *   node tests/probe-qq-deep.js --key <qm_keyst> --uin <QQ号> [--q 关键词]
 *
 * 回答四件事：
 *   ① 128k / 320k / flac / flac24bit 哪些档位真能拿到链
 *   ② 拿到的链能不能完整下完（不是 11 秒试听那种坑）
 *   ③ 下载内容的首尾是否像真音频（FLAC 头 / MP3 帧同步）
 *   ④ 链接本身有时效吗（拿 vkey 参数 + 立刻复用 / 稍后复用）
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36';

function pick(str, idx) {
  return idx.map((i) => str[i]).join('');
}
function b64ish(codes) {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let out = '';
  for (let i = 0; i < codes.length; i += 3) {
    const a = codes[i];
    const b = codes[i + 1];
    const c = codes[i + 2];
    if (i < codes.length - 2) {
      out += table[a >> 2];
      out += table[((a & 3) << 4) | (b >> 4)];
      out += table[((b & 15) << 2) | (c >> 6)];
      out += table[c & 63];
    } else {
      out += table[a >> 2];
      out += table[(a & 3) << 4];
      out += table[0];
      out += table[0];
    }
  }
  return out.slice(0, out.length - 2);
}
function sign(params) {
  const md5 = crypto.createHash('md5').update(params, 'utf8').digest('hex').toUpperCase();
  const hex = {};
  '0123456789ABCDEF'.split('').forEach((ch, i) => {
    hex[ch] = i;
  });
  const mask = [212, 45, 80, 68, 195, 163, 163, 203, 157, 220, 254, 91, 204, 79, 104, 6];
  const codes = [];
  for (let i = 0, j = 0; i < md5.length; i += 2, j++) {
    codes.push((((hex[md5[i]] * 16) ^ hex[md5[i + 1]]) ^ mask[j]) & 0xff);
  }
  const raw = 'zzb' + pick(md5, [21, 4, 9, 26, 16, 20, 27, 30]) + b64ish(codes) + pick(md5, [18, 11, 3, 2, 1, 7, 6, 25]);
  return raw.toLowerCase().replace(/[/+]/g, '');
}

async function callMusicFcg(bodyObj) {
  const body = JSON.stringify(bodyObj);
  const url = `https://u.y.qq.com/cgi-bin/musics.fcg?format=json&sign=${sign(body)}`;
  const r = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' }, body });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 风控 */
  }
  return { status: r.status, json, text };
}

const QUALITY = {
  '128k': { prefix: 'M500', ext: '.mp3' },
  '320k': { prefix: 'M800', ext: '.mp3' },
  flac: { prefix: 'F000', ext: '.flac' },
  'flac24bit': { prefix: 'RS01', ext: '.flac' },
  // 母带 / 臻品音质，QQ 会员也可能覆盖
  hires: { prefix: 'F0M0', ext: '.flac' },
};

async function search(keyword, count = 5) {
  const { json } = await callMusicFcg({
    req_1: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { num_per_page: count, page_num: 1, query: keyword, search_type: 0 },
    },
    comm: { ct: '19', cv: '1859', v: '1859' },
  });
  const list = json?.req_1?.data?.body?.song?.list || [];
  return list.map((x) => ({
    name: x.name,
    artist: (x.singer || []).map((s) => s.name).join('/'),
    mid: x.mid,
    mediaMid: x.file?.media_mid,
    sec: x.interval,
  }));
}

async function trackUrl({ mid, mediaMid, quality, uin, key, guid, songtype = 0 }) {
  const q = QUALITY[quality];
  const { status, json, text } = await callMusicFcg({
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        filename: [q.prefix + mediaMid + q.ext],
        guid,
        songmid: [mid],
        songtype: [songtype],
        uin,
        loginflag: 1,
        platform: '20',
      },
    },
    comm: { qq: uin, authst: key, ct: '26', cv: '2010101', v: '2010101' },
  });
  if (!json) return { ok: false, status, reason: text.slice(0, 120) };
  const info = json?.req_0?.data?.midurlinfo?.[0] || {};
  const sip = json?.req_0?.data?.sip?.[0] || '';
  return {
    ok: json.code === 0 && !!info.purl,
    code: json.code,
    purl: info.purl || '',
    result: info.result,
    subcode: info.subcode,
    sip,
    full: info.purl ? (sip || 'http://aqqmusic.tc.qq.com/') + info.purl : '',
  };
}

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : '';
}

const KB = (n) => (n / 1024).toFixed(0) + 'K';
const MB = (n) => (n / 1024 / 1024).toFixed(1) + 'M';

(async () => {
  const key = argOf('--key');
  const uin = argOf('--uin') || '0';
  const guid = argOf('--guid') || '114514';
  const kw = argOf('--q') || '晴天 周杰伦';
  if (!key) {
    console.error('必须传 --key（qm_keyst）');
    process.exit(1);
  }

  console.log(`=== ① 音质档位遍历：${kw} ===`);
  const list = await search(kw, 3);
  if (!list[0]) {
    console.error('搜索无结果');
    process.exit(1);
  }
  const song = list[0];
  console.log(`   曲目：${song.name} — ${song.artist}  官方时长 ${song.sec}s  mediaMid=${song.mediaMid}\n`);

  const got = {};
  for (const q of Object.keys(QUALITY)) {
    const t = await trackUrl({ mid: song.mid, mediaMid: song.mediaMid, quality: q, uin, key, guid });
    const ext = t.full.split('?')[0].split('.').pop();
    console.log(
      `   ${t.ok ? '✓' : '✗'} ${q.padEnd(10)} ${t.ok ? `${ext.padEnd(5)} ${t.full.split('?')[0]}` : `result=${t.result} subcode=${t.subcode}`}`
    );
    if (t.ok) got[q] = t;
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!Object.keys(got).length) {
    console.log('\n  一档都没拿到，后面的下载测试没法做。');
    return;
  }

  console.log('\n=== ② 完整下载（验真音频 + 时长对不对） ===');
  const dir = path.join(os.tmpdir(), 'qq-probe');
  fs.mkdirSync(dir, { recursive: true });
  for (const q of Object.keys(got)) {
    const t = got[q];
    const ext = t.full.split('?')[0].split('.').pop();
    const file = path.join(dir, `${song.name}-${q}.${ext}`);
    const t0 = Date.now();
    let buf;
    try {
      const r = await fetch(t.full, { headers: { 'User-Agent': UA } });
      buf = Buffer.from(await r.arrayBuffer());
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      fs.writeFileSync(file, buf);
      // 头 4 字节 + 尾 4 字节
      const head = buf.subarray(0, 4).toString('hex');
      const tail = buf.subarray(-4).toString('hex');
      const isFlac = buf.subarray(0, 4).toString('latin1') === 'fLaC';
      const isMp3 = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
      // FLAC 头里 36~39 字节是大端采样数，配合采样率算时长
      let flacSec = 0;
      if (isFlac) {
        const rate = buf.readUIntBE(27, 3) >> 4; // 20 bit 采样率
        const total = buf.readBigUInt64BE(27) & 0xfffffffffn;
        const sr = rate || 44100;
        // 实际布局：第 27 字节起 8 字节 = 采样率20 + 声道3 + 位深5 + 总采样数36
        const v = buf.subarray(27, 35).toString('hex');
        const bytes = BigInt('0x' + v);
        const totalSamples = Number(bytes & ((1n << 36n) - 1n));
        const sampleRate = Number((bytes >> 44n) & 0xfffffn);
        flacSec = sampleRate ? totalSamples / sampleRate : 0;
        if (!flacSec) flacSec = total / sr;
      }
      console.log(
        `   ✓ ${q.padEnd(10)} ${MB(buf.length).padStart(6)}  head=${head}${isFlac ? ' (fLaC)' : ''}${isMp3 ? ' (MP3帧)' : ''}` +
          `${isFlac && flacSec ? `  FLAC头部时长≈${flacSec.toFixed(0)}s` : ''}  耗时${sec}s`
      );
      console.log(`      尾部=${tail}  ${file}`);
    } catch (e) {
      console.log(`   ✗ ${q.padEnd(10)} 下载失败：${e.message}`);
    }
  }

  console.log('\n=== ③ 链接复用 / 时效 ===');
  const pickQ = got['320k'] || got.flac;
  const url = pickQ.full;
  for (const wait of [0, 5, 15]) {
    if (wait) await new Promise((r) => setTimeout(r, wait * 1000));
    let status = 0;
    let len = 0;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-1023' } });
      status = r.status;
      len = (await r.arrayBuffer()).byteLength;
    } catch (e) {
      console.log(`   ✗ 复用（+${wait}s）：${e.message}`);
      continue;
    }
    console.log(`   ${status === 206 || status === 200 ? '✓' : '✗'} 复用（+${wait}s）：HTTP ${status} ${len} 字节`);
  }

  // 不同 guid 会不会导致旧链失效
  console.log('\n=== ④ 同一首歌再取一次链（看是否稳定） ===');
  for (let i = 1; i <= 2; i++) {
    const t = await trackUrl({ mid: song.mid, mediaMid: song.mediaMid, quality: '320k', uin, key, guid: guid + i });
    console.log(`   第${i}次 guid=${guid + i}：${t.ok ? '✓ 有链' : '✗ ' + t.result}`);
    await new Promise((r) => setTimeout(r, 400));
  }
})().catch((e) => {
  console.error('异常：', e.message);
  process.exit(1);
});

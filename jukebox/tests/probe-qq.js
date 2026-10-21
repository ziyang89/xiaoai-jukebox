#!/usr/bin/env node
/**
 * QQ 音乐音源自建可行性探测（零依赖，打真实接口）
 *
 * 为什么要有这个脚本：GD Studio 公共实例 5 分钟只给 50 次请求，撞线就 503。
 * Jusic（一起听歌吧）的做法是自己直连 QQ 官方接口，用签名 + 会员 cookie 换直链，
 * 没有公共配额。本脚本验证这条路的各个环节今天还通不通。
 *
 * 用法：
 *   node tests/probe-qq.js
 *     只测搜索 + 签名（不需要任何账号）。搜索接口是免费的。
 *
 *   node tests/probe-qq.js --key <QqMusicKey> --uin <QQ号> [--guid 114514]
 *     额外测会员取链。QqMusicKey 取自浏览器登录 y.qq.com 后的 cookie 里的 qm_keyst。
 *
 * 实测结论（2026-10-19）：
 *   搜索  ✅ code:0，返回 mid / media_mid / 时长 / 歌手 / 封面
 *   取链  ⚠️ 不带会员 key 时 purl 为空、result:104003（= 需要登录/付费），签名本身有效
 *   说明  这条路唯一的前提就是会员 cookie，算法没坏
 */

const crypto = require('crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36';

// ---------------------------------------------------------------- 签名（移植自 Jusic 的 QMWSign.java）
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
      // 末块不足 3 字节：原实现仍补齐 4 个字符，最后统一砍掉尾部 2 个
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

// ---------------------------------------------------------------- 请求
async function callMusicFcg(bodyObj) {
  const body = JSON.stringify(bodyObj);
  const url = `https://u.y.qq.com/cgi-bin/musics.fcg?format=json&sign=${sign(body)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 说明被风控拦了 */
  }
  return { status: r.status, json, text };
}

// 音质 → 文件名前后缀（QQ 的命名规则）
const QUALITY = {
  '128k': { prefix: 'M500', ext: '.mp3' },
  '320k': { prefix: 'M800', ext: '.mp3' },
  flac: { prefix: 'F000', ext: '.flac' },
  'flac24bit': { prefix: 'RS01', ext: '.flac' },
};

async function search(keyword, count = 5) {
  const { status, json, text } = await callMusicFcg({
    req_1: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { num_per_page: count, page_num: 1, query: keyword, search_type: 0 },
    },
    comm: { ct: '19', cv: '1859', v: '1859' },
  });
  if (!json) return { ok: false, status, reason: text.slice(0, 120) };
  const list = json?.req_1?.data?.body?.song?.list || [];
  return {
    ok: json.code === 0 && list.length > 0,
    code: json.code,
    list: list.map((x) => ({
      name: x.name,
      artist: (x.singer || []).map((s) => s.name).join('/'),
      mid: x.mid,
      mediaMid: x.file?.media_mid,
      sec: x.interval,
      albumMid: x.album?.mid,
    })),
  };
}

async function trackUrl({ mid, mediaMid, quality = 'flac', uin = '0', key = '', guid = '114514' }) {
  const q = QUALITY[quality] || QUALITY['320k'];
  const { status, json, text } = await callMusicFcg({
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        filename: [q.prefix + mediaMid + q.ext],
        guid,
        songmid: [mid],
        songtype: [0],
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
    full: info.purl ? sip + info.purl : '',
  };
}

// ---------------------------------------------------------------- 主流程
function argOf(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : '';
}

(async () => {
  const key = argOf('--key');
  const uin = argOf('--uin') || '0';
  const guid = argOf('--guid') || '114514';
  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
    ok ? pass++ : fail++;
  };

  console.log('=== ① 搜索（不需要账号） ===');
  const kw = argOf('--q') || '晴天 周杰伦';
  const s = await search(kw, 5);
  check(`搜索「${kw}」`, s.ok, s.ok ? `${s.list.length} 首` : `code=${s.code} ${s.reason || ''}`);
  if (s.ok) {
    s.list.slice(0, 3).forEach((x) => {
      console.log(`       ${x.name} — ${x.artist}  mid=${x.mid} mediaMid=${x.mediaMid} ${x.sec}s`);
    });
  }
  check('搜索返回了 mediaMid（取链必需）', !!(s.list[0] && s.list[0].mediaMid));

  console.log('\n=== ② 签名 + 取链 ===');
  if (!s.ok || !s.list[0]) {
    console.log('  搜索不可用，跳过');
  } else {
    const one = s.list[0];
    const t = await trackUrl({ mid: one.mid, mediaMid: one.mediaMid, quality: 'flac', uin, key, guid });
    if (key) {
      check('带会员 key 能换到直链', t.ok, t.ok ? t.full.slice(0, 90) : `result=${t.result} subcode=${t.subcode}`);
      if (t.ok) {
        try {
          const a = await fetch(t.full, { headers: { 'User-Agent': UA, Range: 'bytes=0-1023' } });
          const buf = Buffer.from(await a.arrayBuffer());
          const magic = buf.subarray(0, 4).toString('hex');
          check(
            'CDN 可裸拉（音箱就是这么拉的）',
            a.status === 206 || a.status === 200,
            `HTTP ${a.status} ${a.headers.get('content-type')} magic=${magic} 长度=${a.headers.get('content-length') || '?'}`
          );
        } catch (e) {
          check('CDN 可裸拉', false, e.message);
        }
      }
    } else {
      check(
        '签名被接口接受（code:0 即算法有效）',
        t.code === 0,
        `req_0.code=${t.code}`
      );
      check(
        '未带会员 key 时拿不到直链（符合预期）',
        !t.ok,
        `result=${t.result} subcode=${t.subcode}（104003 = 需要登录/付费）`
      );
      console.log('\n  想测会员直链：把浏览器里 qm_keyst 的值传给 --key，QQ 号传给 --uin');
    }
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('探测异常：', e.message);
  process.exitCode = 1;
});

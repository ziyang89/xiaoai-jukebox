'use strict';
/**
 * 布局预览（不是测试，是给人看的）
 * ------------------------------------------------------------
 * 起一套完整的假环境（mock 播放引擎 + mock 音源 + 真实 server.js），
 * 造出"有人在听歌、有人在聊天、有人投了一票"的场景，
 * 然后用 Edge headless 截几张图，用来检查左右布局是否正常。
 *
 * 用法：node tests/preview-layout.js
 * 产物：tests/.preview/shot-*.png
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, '.preview');
const APP_DIR = path.join(OUT, 'app');
const APP_PORT = 58200;
const MOCK_PORT = 58201;
const MOCK_SRC_PORT = 58202;
const MOCK_QQ_PORT = 58203; // 排行榜要配 QQ，用 mock 顶上

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = `http://127.0.0.1:${APP_PORT}`;
const j = async (url, opt) => {
  const r = await fetch(url, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
};
const post = (url, body) =>
  j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

async function waitFor(fn, { timeout = 20000, interval = 300, label = '条件' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(interval);
  }
  throw new Error(`${label} 超时`);
}

const procs = [];

/**
 * 用 Edge headless 截一张图。
 * 注意：Windows 上 Edge 的窗口有最小宽度（~492），传更小的值依然按 492 布局、
 * 但 PNG 会按你传的宽度裁 —— 看起来就像"右侧被切"，其实是假象。
 */
async function shot(name, size, q = '?preview=1') {
  if (!EDGE) return console.log('  ⚠️ 没找到 Edge，跳过截图');
  const png = path.join(OUT, `shot-${name}.png`);
  const profile = path.join(OUT, 'edge-profile-' + name);
  try {
    execFileSync(EDGE, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--window-size=${size}`,
      '--virtual-time-budget=9000',
      `--screenshot=${png}`,
      `${APP}/${q}`,
    ], { stdio: 'ignore', timeout: 60000 });
    console.log(`  📸 ${png}${fs.existsSync(png) ? ' (' + (fs.statSync(png).size / 1024).toFixed(0) + 'KB)' : ' 失败'}`);
  } catch (e) {
    console.log(`  ⚠️ 截图失败(${name})：${e.message}`);
  }
}

/**
 * 把页面里量到的几何数据以【文字】取回来，不用靠肉眼看截图数像素。
 * 前端 measure 块会把结果写进 <title>，这里用 --dump-dom 抓出来。
 */
function measureText(size) {
  if (!EDGE) return '';
  const profile = path.join(OUT, 'edge-profile-dump');
  try {
    const out = execFileSync(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, `--window-size=${size}`,
      '--virtual-time-budget=9000', '--dump-dom', `${APP}/?preview=1&measure=1`,
    ], { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
    const m = out.match(/<title>([\s\S]*?)<\/title>/);
    const t = (m ? m[1] : '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return t.startsWith('MEASURE ') ? t.slice(8) : '';
  } catch (e) {
    return '（量测失败：' + e.message + '）';
  }
}

async function main() {
  console.log('\n===== 布局预览 =====\n');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(APP_DIR, 'public'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'music'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

  // ---- 1. 复制一份 app，并在页面里注入"自动占名"（只为截图） ----
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(APP_DIR, 'server.js'));
  let html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const anchor = "function nick(){ return myNick || ''; }";
  if (!html.includes(anchor)) throw new Error('找不到注入锚点');
  html = html.replace(anchor, `${anchor}
// [PREVIEW ONLY] ?top=1 → 默认展开「排行榜」（给截图看列表长什么样）
if (location.search.includes('top')) localStorage.setItem('jb_top_open', '1');
// [PREVIEW ONLY] ?toppop=1 → 顺手把「榜单下拉」点开（验深色面板的可读性）
// 注意：要等榜单列表真的渲染出 .opt 再点，否则点开的是空面板
if (location.search.includes('toppop')) {
  const t = setInterval(() => {
    const b = document.getElementById('topPickBtn');
    const pop = document.getElementById('topPickPop');
    if (b && pop && pop.querySelector('.opt')) { clearInterval(t); b.click(); }
  }, 120);
  setTimeout(() => clearInterval(t), 8000);
}
// [PREVIEW ONLY] 截图用：固定成脚本里已经占好坑的那个 clientId
if (location.search.includes('preview')) {
  CID = 'preview-a';
  myNick = '小明';
  localStorage.setItem(CID_KEY, CID);
  localStorage.setItem(NICK_KEY, myNick);
}
// [PREVIEW ONLY] ?search=晴天 → 自动搜一次，让左栏有搜索结果（主图不至于空着）
const qm = location.search.match(/search=([^&]+)/);
if (qm) {
  const kw = decodeURIComponent(qm[1]);
  const t = setInterval(() => {
    const inp = document.getElementById('q');
    const btn = document.getElementById('btnSearch');
    if (inp && btn) { clearInterval(t); inp.value = kw; btn.click(); }
  }, 150);
  setTimeout(() => clearInterval(t), 6000);
}
// [PREVIEW ONLY] 量一下谁把页面撑宽了（把结果打在页面上，截图就能读到）
if (location.search.includes('measure')) {
  setTimeout(() => {
    const w = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().width) : -1; };
    // 顶部是否齐平：三列「第一张可见卡片」的 top 应该完全相同
    const top = (colSel, cardSel) => {
      const col = document.querySelector(colSel);
      if (!col) return -1;
      const vis = [...col.children].find((e) => e.getBoundingClientRect().height > 0);
      const card = vis ? (cardSel ? vis.querySelector(cardSel) || vis : vis) : null;
      return card ? Math.round(card.getBoundingClientRect().top) : -1;
    };
    const tl = top('.col-l'), tm = top('.col-m'), tr = top('.col-r');
    // 逐个子元素 dump：谁把首卡顶下去了，一眼看出
    const dbg = (colSel) => {
      const col = document.querySelector(colSel);
      if (!col) return colSel + ':?';
      const r = col.getBoundingClientRect();
      const kids = [...col.children].map((e) => {
        const rr = e.getBoundingClientRect();
        return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
          ' h=' + Math.round(rr.height) + ' t=' + Math.round(rr.top) +
          ' mT=' + getComputedStyle(e).marginTop;
      });
      return colSel + ' t=' + Math.round(r.top) + ' mT=' + getComputedStyle(col).marginTop +
        ' ' + (kids.join(' ; ') || '(空)');
    };
    const over = [...document.querySelectorAll('body *')]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 6)
      .map((e) => e.tagName.toLowerCase() + '.' + (e.className || '').toString().split(' ')[0] + '=' + Math.round(e.getBoundingClientRect().right));
    const info = [
      'innerWidth=' + window.innerWidth,
      'docScrollW=' + document.documentElement.scrollWidth,
      'bodyScrollW=' + document.body.scrollWidth,
      'cols=' + w('.cols'),
      'col-l=' + w('.col-l') + '  col-m=' + w('.col-m') + '  col-r=' + w('.col-r'),
      'top: col-l=' + tl + '  col-m=' + tm + '  col-r=' + tr +
        (tl === tm && tm === tr ? '   ✓ 齐平' : '   ✗ 不齐平(差 ' + (tl - tm) + '/' + (tr - tm) + ')'),
      '  ' + dbg('.col-l'),
      '  ' + dbg('.col-m'),
      '  ' + dbg('.col-r'),
      'card=' + w('.card'),
      'hd=' + w('.hd'),
      'chatcard=' + w('.chatcard'),
      'dock=' + w('.dock .in'),
      'OUT: ' + (over.join(', ') || 'none'),
    ].join('\\n');
    // 同步写进 <title>，这样用 --dump-dom 就能把这段文字捞出来（省得靠看图数像素）
    document.title = 'MEASURE ' + info.replace(/\\n/g, ' | ');
    // 想看"画在图上"的版本就加 &debug=1；默认不画，免得黑框挡住页面
    if (!location.search.includes('debug')) return;
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;background:#000;color:#0f0;font:11px/1.5 monospace;padding:5px;white-space:pre-wrap;max-width:100vw';
    d.textContent = info;
    document.body.appendChild(d);
  }, 3500);
}`);
  fs.writeFileSync(path.join(APP_DIR, 'public/index.html'), html, 'utf8');

  fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify({
    port: APP_PORT,
    publicBase: APP,
    musicDir: path.join(OUT, 'music'),
    dataDir: path.join(OUT, 'data'),
    engine: {
      type: 'songloft',
      base: `http://127.0.0.1:${MOCK_PORT}`,
      prefix: '/api/v1/jsplugin/miot',
      username: 'admin',
      password: 'mock-pass',
    },
    searchSources: ['netease', 'kugou'],
    sources: ['netease', 'kugou'],
    gdApi: `http://127.0.0.1:${MOCK_SRC_PORT}/`,
    retry: 1,
    volume: 15,
    pollIntervalMs: 2000,
    minPlaySec: 0,
    overtimeGraceSec: 900,
    prefetchCount: 0,
    logLevel: 'warn',
  }, null, 2));

  // ---- 2. 起四件套（多一个 QQ mock，排行榜要用） ----
  procs.push(spawn(NODE, [path.join(__dirname, 'mock-songloft.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_DURATION: '600', MOCK_SPEED: '1' },
    stdio: 'ignore',
  }));
  procs.push(spawn(NODE, [path.join(__dirname, 'mock-source.js')], {
    env: { ...process.env, MOCK_SRC_PORT: String(MOCK_SRC_PORT) },
    stdio: 'ignore',
  }));
  procs.push(spawn(NODE, [path.join(__dirname, 'mock-qq.js')], {
    env: { ...process.env, MOCK_QQ_PORT: String(MOCK_QQ_PORT) },
    stdio: 'ignore',
  }));
  procs.push(spawn(NODE, [path.join(__dirname, 'mock-qq.js')], {
    env: { ...process.env, MOCK_QQ_PORT: String(MOCK_QQ_PORT) },
    stdio: 'ignore',
  }));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`)).ok, { label: 'mock 引擎' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_SRC_PORT}/?types=search&name=x&count=1`)).ok, { label: 'mock 音源' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_QQ_PORT}/__stats`)).ok, { label: 'mock QQ' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_QQ_PORT}/__stats`)).ok, { label: 'mock QQ' });
  procs.push(spawn(NODE, [path.join(APP_DIR, 'server.js')], {
    env: {
      ...process.env,
      JB_CONFIG: path.join(OUT, 'config.json'),
      // QQ 凭据走 env（只在预览里指 mock）：排行榜卡片才有数据可看
      JB_QQ_KEY: 'Q_H_L_PREVIEWKEY_0123456789abcdefghijklmnopqrstuvwxyz',
      JB_QQ_UIN: '100200300',
      JB_QQ_QUALITY: '320k',
      JB_QQ_API: `http://127.0.0.1:${MOCK_QQ_PORT}`,
    },
    stdio: 'ignore',
  }));
  await waitFor(async () => (await j(`${APP}/api/health`)).ok, { label: '点歌台' });
  console.log('  服务已就绪 :' + APP_PORT);

  // ---- 3. 造数据：三个人、两首歌、几条聊天、一票 ----
  const people = [
    { id: 'preview-a', nick: '小明' },
    { id: 'preview-b', nick: '小红' },
    { id: 'preview-c', nick: '阿强' },
  ];
  for (const p of people) await post(`${APP}/api/nick/claim`, { clientId: p.id, nick: p.nick });
  for (const p of people) await post(`${APP}/api/live`, { clientId: p.id, nick: p.nick });

  // 空态截图：还没有任何歌在播、队列也是空的 —— 专门验证「正在播放 / 待播放」的占位常驻
  await shot('idle', '1440,900');

  const s1 = await j(`${APP}/api/search?q=` + encodeURIComponent('晴天'));
  await post(`${APP}/api/enqueue`, { song: s1.results[0], requester: '小明' });
  await waitFor(async () => {
    const st = await j(`${APP}/api/state`);
    return st.current && st.current.status === 'playing' ? st : null;
  }, { label: '起播' });
  const s2 = await j(`${APP}/api/search?q=` + encodeURIComponent('稻香'));
  await post(`${APP}/api/enqueue`, { song: s2.results[0], requester: '小红' });
  await post(`${APP}/api/enqueue`, { song: s2.results[1] || s2.results[0], requester: '阿强' });

  await sleep(300);
  await post(`${APP}/api/chat/send`, { clientId: 'preview-b', text: '这首好听，谁的歌单？' });
  await sleep(700);
  await post(`${APP}/api/chat/send`, { clientId: 'preview-c', text: '我投一票切了它哈哈哈' });
  await sleep(700);
  await post(`${APP}/api/chat/send`, { clientId: 'preview-a', text: '别急，等我听完这段副歌' });
  await sleep(700);
  // 一票（3 人在线 → 需 2 票，故意不足，好看到"还差 1 票"的样子）
  for (const p of people) await post(`${APP}/api/live`, { clientId: p.id, nick: p.nick });
  await post(`${APP}/api/skip`, { clientId: 'preview-c' });

  // 队列「👍 x/N」：让小明给队列第 2 首点个赞，截图里能看到高亮态（1/3）
  const qBefore = (await j(`${APP}/api/state`)).queue;
  if (qBefore[1]) await post(`${APP}/api/top`, { qid: qBefore[1].qid, clientId: 'preview-a' });

  const st = await j(`${APP}/api/state`);
  console.log(`  场景就绪：在线 ${st.online} 人 · 队列 ${st.queue.length} 首 · 投票 ${st.vote.votes}/${st.vote.need} · 点赞 ${st.queue.map((q) => q.tops.votes).join('/')}`);

  // ---- 4. 截图 ----
  // 三列 4:4:3（点歌 / 正在播放+待播 / 聊天室）
  await shot('desktop', '1440,900');
  // 主图：左栏带搜索结果（给 README 用，空栏看着像没做完）
  await shot('search', '1440,1000', '?preview=1&search=' + encodeURIComponent('晴天'));
  // 中等宽度：三列都还在，验证挤压后聊天室仍不低于 220px
  await shot('mid', '1024,900');
  await shot('narrow', '492,900');
  // 排行榜展开（左栏第二张卡片，可折叠）—— 桌面 + 窄屏各一张
  await shot('top', '1440,1200', '?preview=1&top=1');
  // 榜单下拉展开（自定义深色面板：分组标题 + 选中项紫色高亮）
  await shot('top-pop', '1440,1200', '?preview=1&top=1&toppop=1');
  // 调试：确认下拉面板真的展开了（截图可能看不出是"空的"还是"没开"）
  if (EDGE) {
    try {
      const dump = execFileSync(EDGE, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${path.join(OUT, 'edge-profile-pop')}`, '--window-size=1440,1200',
        '--virtual-time-budget=9000', '--dump-dom', `${APP}/?preview=1&top=1&toppop=1`,
      ], { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
      const cls = (dump.match(/<div class="(selpop[^"]*)"/) || [])[1] || '(没有 selpop)';
      const opts = (dump.match(/class="opt/g) || []).length;
      console.log(`  🔎 下拉面板：class="${cls}" · 选项 ${opts} 个`);
    } catch (e) {
      console.log('  ⚠️ 下拉调试失败：' + e.message);
    }
  }
  await shot('top-narrow', '492,1200', '?preview=1&top=1');

  // ---- 5. 几何量测（文字版，不用数像素）----
  const m1 = measureText('1440,900');
  const m2 = measureText('1024,900');
  if (m1) console.log('\n📐 1440×900\n   ' + m1.split(' | ').join('\n   '));
  if (m2) console.log('\n📐 1024×900\n   ' + m2.split(' | ').join('\n   '));
  if (m1 && m1.includes('✗ 不齐平')) console.log('\n   ⚠️ 三列顶部没对齐！');

  for (const p of procs) { try { p.kill(); } catch {} }
  await sleep(300);
  console.log('\n完成。\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('预览失败：', e);
  for (const p of procs) { try { p.kill(); } catch {} }
  process.exit(1);
});

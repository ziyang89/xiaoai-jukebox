'use strict';
/**
 * 模拟 songloft「智能音箱」插件的接口，用于端到端验证点歌台逻辑。
 * 只实现点歌台会用到的那几个端点，其余一律 404。
 *
 * 环境变量：
 *   MOCK_PORT       监听端口（默认 58099）
 *   MOCK_DURATION   模拟曲目时长（秒，默认 20）
 *   MOCK_SPEED      播放倍速（默认 8，即 1 真实秒 = 8 播放秒）
 */
const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 58099);
const DURATION = Number(process.env.MOCK_DURATION || 20);
const SPEED = Number(process.env.MOCK_SPEED || 8);

const ACCOUNT = '100000000';
const DEVICES = [
  { deviceID: 'mock-l17a-1', name: 'Xiaomi Sound Pro', hardware: 'L17A', alias: 'Xiaomi Sound Pro', presence: 'online', managed: true, volume: 0 },
  { deviceID: 'mock-mini', name: '小爱音箱mini', hardware: 'LX01', alias: '小爱音箱mini', presence: 'online', managed: false, volume: 0 },
];

const st = {
  playing: false,
  startedAt: 0,
  volume: 0,
  lastUrl: null,
  noStop: false, // true = 模拟插件不提供 stop/pause
  // 真机"脏数据"模拟（默认全关，用 POST /__statusMode 打开）
  realistic: false,
  blipEvery: 0,   // 每 N 次状态查询闪一次 idle
  residualSec: 0, // 推流后的残留窗口内，回上一首的进度（**而且还在往前走**）
  residualMs: 1500, // 残留窗口多长（毫秒）
  statusCalls: 0,
  log: [],
};

function note(kind, extra) {
  const rec = { kind, at: Date.now(), ...extra };
  st.log.push(rec);
  console.error(`[mock] ${kind} ${extra ? JSON.stringify(extra) : ''}`);
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** 插件风格：{success:true, data} */
const ok = (res, data) => send(res, 200, { success: true, data });

function readBody(req) {
  return new Promise((r) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(c).toString('utf8');
      try {
        r(raw ? JSON.parse(raw) : {});
      } catch {
        r({});
      }
    });
  });
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    const m = req.method;

    // ---- 登录
    if (p === '/api/v1/auth/login' && m === 'POST') {
      const b = await readBody(req);
      note('login', { username: b.username });
      // 固定口令，用来验证「密码错误要拒绝」这条路径
      if (b.password === 'wrong-pass') {
        return send(res, 401, { error: 'invalid credentials' });
      }
      return send(res, 200, {
        access_token: 'mock-token-' + Date.now(),
        refresh_token: 'mock-refresh',
        expires_in: 3600,
      });
    }

    // ---- 插件端点：统一要求 Bearer
    if (p.startsWith('/api/v1/jsplugin/miot/')) {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) {
        return send(res, 401, { error: 'unauthorized' });
      }
      const sub = p.slice('/api/v1/jsplugin/miot'.length);

      if (sub === '/mina/devices' && m === 'GET') {
        return ok(res, [{ account_id: ACCOUNT, account_name: ACCOUNT, devices: DEVICES, last_selected_device_id: 'mock-l17a-1' }]);
      }
      if (sub === '/auth/status' && m === 'GET') {
        return ok(res, [{ id: ACCOUNT, logged_in: true, is_valid: true, user_id: ACCOUNT, login_method: 'qrcode', account_name: ACCOUNT }]);
      }
      if (sub === '/config' && m === 'GET') {
        return ok(res, { server_host: `http://127.0.0.1:${PORT}`, timezone: 'Asia/Shanghai' });
      }
      if (sub === '/player/status' && m === 'GET') {
        st.statusCalls += 1;
        let pos = 0;
        if (st.playing) {
          pos = ((Date.now() - st.startedAt) / 1000) * SPEED;
          if (pos >= DURATION) pos = DURATION;
        }
        const out = {
          is_playing: st.playing,
          position: Math.round(pos),
          duration: DURATION,
          volume: st.volume,
          play_mode: 'order',
        };
        // 默认响应保持原样（不打扰既有测试）。
        // 打开 /__statusMode 后才附上真机（小米 Sound Pro）的两个"脏"特征：
        //   ① is_playing 恒为 false，只有 state 字符串可信；
        //   ② 播放中周期性闪一次 {state:"idle",position:0,duration:0}
        //      + 刚推流时回的是上一首的残留进度。
        // 用户反馈的「正在播放会来回跳」就是被这两条喂出来的。
        if (st.realistic) {
          if (st.blipEvery && st.statusCalls % st.blipEvery === 0) {
            return ok(res, { state: 'idle', is_playing: false, position: 0, duration: 0, volume: st.volume });
          }
          if (st.residualSec && st.playing && Date.now() - st.startedAt < st.residualMs) {
            // ⚠️ 关键：残留值是**会动的**（上一首的流还没断干净，位置还在往前走）。
            // 真机实测 190 → 202 —— 正因为它在动，"看到进度在推进"这种判据骗得过，
            // 于是假值被当成基准，真值上来时被"只增不减"挡住 → 界面时间卡死。
            pos = st.residualSec + ((Date.now() - st.startedAt) / 1000) * SPEED;
          }
          out.state = st.playing ? 'playing' : 'paused';
          out.is_playing = false; // 真机实测：恒 false，不可信
          out.position = Math.round(pos);
        }
        return ok(res, out);
      }
      if (sub === '/mina/play-url' && m === 'POST') {
        const b = await readBody(req);
        st.playing = true;
        st.startedAt = Date.now();
        st.lastUrl = b.url;
        note('play-url', { url: b.url, device_id: b.device_id });
        return ok(res, { accepted: true });
      }
      if (sub === '/mina/volume' && m === 'POST') {
        const b = await readBody(req);
        st.volume = b.volume;
        note('volume', { volume: b.volume });
        return ok(res, { volume: b.volume });
      }
      // 「停止」族端点：默认支持。开 /__nostop 让它们 404，
      // 用来验证点歌台在插件没有 stop 时是否会自动走「推静音」兜底。
      if ((sub === '/mina/stop' || sub === '/mina/pause') && m === 'POST') {
        const b = await readBody(req);
        if (st.noStop) return send(res, 404, { error: 'not found: ' + sub });
        st.playing = false;
        note(sub.slice('/mina/'.length), { device_id: b.device_id });
        return ok(res, {});
      }
      if (sub === '/mina/last_selection' && m === 'POST') {
        const b = await readBody(req);
        note('last_selection', b);
        return ok(res, {});
      }
      if (sub === '/player/next' && m === 'POST') {
        st.playing = false;
        note('next');
        return ok(res, {});
      }
      return send(res, 404, { error: 'not found: ' + sub });
    }

    // ---- 观测端点（测试脚本用）
    if (p === '/__log') {
      return send(res, 200, st.log);
    }
    if (p === '/__reset') {
      st.log = [];
      st.playing = false;
      st.lastUrl = null;
      st.statusCalls = 0;
      return send(res, 200, { ok: true });
    }
    // 模拟「这版插件不提供 stop/pause」（用来测点歌台的静音兜底）
    if (p === '/__nostop') {
      st.noStop = u.searchParams.get('on') !== '0';
      return send(res, 200, { noStop: st.noStop });
    }
    // 打开「真机脏数据」模式：idle 闪烁 + 残留进度 + is_playing 恒 false
    //   POST /__statusMode {"realistic":true,"blipEvery":4,"residualSec":40}
    if (p === '/__statusMode') {
      const b = await readBody(req);
      if (b.realistic !== undefined) st.realistic = !!b.realistic;
      if (b.blipEvery !== undefined) st.blipEvery = Number(b.blipEvery) || 0;
      if (b.residualSec !== undefined) st.residualSec = Number(b.residualSec) || 0;
      if (b.residualMs !== undefined) st.residualMs = Number(b.residualMs) || 1500;
      st.statusCalls = 0;
      return send(res, 200, {
        ok: true,
        realistic: st.realistic,
        blipEvery: st.blipEvery,
        residualSec: st.residualSec,
        residualMs: st.residualMs,
      });
    }

    send(res, 404, { error: 'not found' });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.error(`[mock] songloft mock 已启动 http://127.0.0.1:${PORT}（时长 ${DURATION}s ×${SPEED} 倍速）`);
  });

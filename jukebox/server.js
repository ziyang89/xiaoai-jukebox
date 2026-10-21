'use strict';
/**
 * 小爱点歌台 · 后端服务
 * ============================================================
 * 零 npm 依赖（Node 22 内置 http / fetch / fs）。
 *
 * 六个职责：
 *   ① 音源聚合搜索   GD Studio 聚合 API，多源并行 + 按优先级降级重试
 *   ② 音频落地缓存   命中本地即秒播；未命中则下载入 NAS 曲库（养本地库）
 *   ③ 点歌队列       内存队列 + JSON 持久化（重启不丢）
 *   ④ 播放推流       把音频 URL 通过 songloft 插件 / xiaomusic 推给小爱音箱
 *   ⑤ 自动续播       轮询播放状态 + 时长兜底，播完自动切下一首
 *   ⑥ 手机端 H5      /public/index.html
 *
 * 关键设计约束（来自音源实测报告）：
 *   · 在线直链只有约 25 分钟寿命 → 绝不复用直链，只复用已下载的音频文件
 *   · 取链成功率约 62.5% → 单源失败重试 3 次 + 多源降级
 *   · HTTP 200 ≠ 可用 → 下载后必须用 magic bytes 校验音频真伪
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = __dirname;
const CFG_FILE = process.env.JB_CONFIG || path.join(ROOT, 'config.json');
const VERSION = '1.0.0';

/** 音源聚合 API（GD Studio 兼容接口）。可换成自建实例（项目开源） */
const GD_API_DEFAULT = 'https://music-api.gdstudio.xyz/api.php';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * 内置静音音频的虚拟文件名（不落盘，请求时现场生成）。
 * 用途：插件万一没有 stop/pause 时，推这段 1 秒静音给音箱 ——
 * 音乐被顶掉、播完即静音结束，效果等同于"停"。
 */
const SILENCE_NAME = '__silence.mp3';
const SILENCE_SEC = 1;
let _silenceBuf = null;

/** 生成一段合法的 MP3 静音流：MPEG1 Layer3 / 128kbps / 44.1kHz，每帧 417B */
function silenceMp3() {
  if (_silenceBuf) return _silenceBuf;
  const frame = Buffer.alloc(417); // 全 0 数据 = 静音
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG1 · Layer3 · 无 CRC
  frame[2] = 0x90; // bitrate=128kbps · 44.1kHz · 无 padding
  frame[3] = 0x64; // joint stereo
  const n = Math.max(1, Math.round(SILENCE_SEC / 0.026122)); // 每帧 1152/44100 秒
  _silenceBuf = Buffer.concat(Array.from({ length: n }, () => frame));
  return _silenceBuf;
}

// ---------------------------------------------------------------- 配置

const DEFAULT_CONFIG = {
  port: 58092,
  /** 音箱能访问到的本服务地址。留空则自动探测本机内网 IP */
  publicBase: '',
  /** 音频落地目录（网络音频下载到这里，也扫描这里已有的本地音乐） */
  musicDir: path.join(ROOT, 'music'),
  /** 运行数据目录 */
  dataDir: path.join(ROOT, 'data'),

  engine: {
    /** songloft | xiaomusic */
    type: 'songloft',
    /** 播放引擎地址。songloft 一般 58091，xiaomusic 一般 58090 */
    base: 'http://127.0.0.1:58091',
    /** songloft 插件前缀（xiaomusic 忽略此项） */
    prefix: '/api/v1/jsplugin/miot',
    /** songloft 管理账号（xiaomusic 无需） */
    username: 'admin',
    password: '',
    /** 指定音箱；留空则自动挑：L17A 且 managed 且在线 */
    deviceId: '',
    accountId: '',
  },

  /**
   * 下载音源优先级（逐个降级）。
   *
   * 两个种类：
   *   ① `qq` —— **我们自己直连 QQ 官方接口**（不是 GD 的源名），走会员 cookie 换直链，
   *      不占任何公共配额。没配 key 时自动跳过。
   *   ② GD Studio 的源名 —— 2026-10-19 实测该接口的 source 取值：
   *      ✅ netease —— 搜得到、拿得到直链（唯一完整可用的源）
   *      ⚠️ joox / bilibili —— 能搜到，但 types=url 返回 {"url":"","br":-1}（空链）
   *      ❌ kuwo / kugou / tencent / migu / tidal / spotify / qobuz / deezer /
   *         ytmusic / apple / ximalaya —— 直接 400 "Value of `source` is not supported"
   *
   * 把死源留在列表里的代价不是"多一层保险"，而是每次失败都白烧 3~6 次请求配额
   * （单源重试 3 次 × 逐源降级），反而更容易撞上限流。
   * 改配置前先跑 `node tests/probe-sources.js` 实测，别照抄旧文档。
   */
  sources: ['qq', 'netease'],
  /**
   * 搜索源优先级（按顺序试，够了就停）。
   * `qq` 排第一的理由：它的搜索接口免费且不限次数，先问它等于把配额压力降到最低；
   * QQ 搜不到（或没配 key）才回落到 GD。
   */
  searchSources: ['qq', 'netease'],
  /** QQ 搜索结果达到多少条就不再问后面的源（0 = 每个源都问一遍） */
  searchEnough: 3,

  /**
   * QQ 音乐自建音源（用你的会员 cookie 直连官方接口）。
   *
   * 怎么拿 key：浏览器登录 y.qq.com → F12 → Application/存储 → Cookies →
   *   复制 `qm_keyst` 的值；`uin` 就是 QQ 号。
   *
   * ⚠️ 这是账号凭据：只写 <dataDir>/runtime-config.json（跟着数据卷走、不随镜像上传），
   *    或者用管理员口令走 POST /api/admin/qq 写入。绝不落到 config.json 模板里。
   */
  qq: {
    key: '',
    uin: '',
    /** 设备指纹，随便一串数字；换一个等于"换台设备"，用于规避同设备限速 */
    guid: '',
    /** 音质：320k（默认，音箱兼容最好）| 128k | flac（体积约 5 倍，音箱不一定吃得下） */
    quality: '320k',
  },
  /** 单源取链重试次数 */
  retry: 3,
  /** 目标码率 */
  br: 320,
  /** 每次搜索返回条数 */
  searchCount: 20,

  /**
   * 已缓存的歌一律用 NAS 本地文件，绝不回音源再拉一次。
   * 关掉它就等于"每次都重新下载"，正常不要关。
   */
  preferCache: true,
  /** 曲库索引落盘文件（默认 <dataDir>/library.json） */
  libraryIndexFile: '',
  /** 搜索结果里最多置顶多少首"已缓存"的命中曲目 */
  localTopN: 10,

  /**
   * 随机电台：待播队列空了，自动从 NAS 曲库随机挑一首接着放。
   *
   * 这是"永远不冷场"的兜底 —— 家里来客人时没人点歌，也不至于突然安静。
   * 它只放**已经下载到 NAS 的歌**（不碰音源、不烧配额），所以不限量。
   * 管理员「停止播放」会临时把它按住（否则停不掉），下次有人点歌自动解除。
   */
  autoRadio: true,
  /** 随机电台记住最近播过的多少首（轮完一圈才可能重复），曲库小于这个数就全库随机 */
  radioRecentMax: 10,
  /** 随机电台连续起播失败几次后，暂停多久再试（防止坏文件把调度器刷爆） */
  radioErrorPauseSec: 60,

  /**
   * 定时关闭（睡眠定时器）单次最长可设多少分钟。
   *
   * 到点后：立刻停声 + 把调度器按住（`state.sleepHold`），**队列不清空** ——
   * 半夜被关掉的那几首明天还在，点歌 / 「继续播放」就能接着放。
   * 上限定 12 小时纯粹是防手抖（把 30 输成 3000 再按确定）。
   */
  sleepMaxMin: 720,

  /** 推流前统一设置的音量（0-100） */
  volume: 15,
  /** 是否在推流前强制设置音量 */
  forceVolume: true,

  /** 播放状态轮询间隔 */
  pollIntervalMs: 2000,
  /**
   * 进度条防跳：状态接口偶发的"全零读数"连续出现多少次才认账。
   *
   * 真机实测（小米 Sound Pro）：播放中大约每 7 秒会闪一次
   * `{state:"idle", position:0, duration:0}`（单次，不影响实际播放）。
   * 照单全收的话，网页上的进度条就会「归零 → 弹回 → 再归零」来回跳。
   * 默认 3 次（轮询 2s → 约 6 秒）：少于这个次数一律沿用上一次的进度。
   * 设为 1 = 不防抖（退回旧行为，仅排障用）。
   */
  statusBlipHold: 3,
  /**
   * 进度"超前"容差（秒）：进度最多可以比"这首歌已经播了多久"超前多少。
   *
   * 为什么要用挂钟卡一下：上一首的流在推流后还会往前走一两秒（实测 190 → 202），
   * 这个假值**比真值大、而且还在动**，只靠"看到进度在动"是拦不住的，
   * 结果就是界面上的时间**卡死在假值上**（用户 10-17 报的"时间不动了"）。
   * 80 秒前才开始播的曲子，不可能已经播到 3:32 —— 用挂钟一比就露馅。
   * 留几秒余量是给音箱缓冲/预读用的。设为 0 = 完全按挂钟卡（可能偏严）。
   */
  statusLeadSec: 8,
  /** 防误判：新推流后这段时间内绝不因为状态接口而切歌（音箱起播有延迟） */
  minPlaySec: 12,
  /** 单曲超时兜底：超过"真实时长 + 该秒数"仍未报结束则强制切歌 */
  overtimeGraceSec: 25,
  /** 队列中预下载的曲目数（预热，减少等待） */
  prefetchCount: 2,
  /** 并发下载数 */
  downloadConcurrency: 2,
  /**
   * 单曲最多尝试次数（限流/网络抖动属于"可恢复错误"，绝不能把歌丢掉）。
   * 每次失败会把曲目放回队首，等冷却结束再试。
   */
  maxTries: 5,
  /** 撞上音源限流后的冷却时长（毫秒） */
  rateCooldownMs: 60000,

  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  gdApi: GD_API_DEFAULT,
  logLevel: 'info',

  /**
   * 管理员口令（可空）。
   * 空 = 还没设置 → 前端引导现场设置，口令以 sha256(salt+pin) 存 <dataDir>/admin.json，
   * 绝不留明文、也绝不下发给前端。
   * 设置后，"停止播放"这类影响全场的操作必须凭它才能执行。
   */
  adminPin: '',

  // ---------------- 聊天室 / 在线人数 / 投票切歌 ----------------

  /** 聊天室里最多保留多少条消息（内存 + 落盘） */
  chatMaxMessages: 200,
  /** 昵称最大长度 */
  nickMaxLen: 12,
  /**
   * 昵称占用多久没人用就自动释放（秒）。默认 7 天。
   *
   * 为什么需要它：clientId 存在浏览器 localStorage 里 —— 一旦清了浏览器数据、
   * 换手机或换浏览器，那个人就换了新 clientId，**旧昵称会永久锁死**（家庭场景
   * 比如「妈妈」换台设备就再也用不了这个名字）。
   * 有了 TTL，只要昵称原主人在这个期限内出现过（心跳/发言/点歌都算），占用就续期；
   * 超过期限没人用 → 视为弃用，别人可以认领。
   * 设为 0 = 永不过期（退回旧行为）。
   */
  nickTtlSec: 7 * 86400,
  /** 多少毫秒没心跳就当这个人离开了聊天室 */
  onlineWindowMs: 20000,
  /** 单条聊天消息最大长度 */
  chatMaxLen: 300,
  /** 同一个人两次发消息的最小间隔（毫秒），防刷屏 */
  chatMinGapMs: 600,
  /**
   * 切歌需要「超过聊天室在线人数的一半」的票数：
   *   need = floor(在线人数 / 2) + 1
   * 比如 1 人 → 1 票；2 人 → 2 票；3 人 → 2 票；4 人 → 3 票。
   * 设为 0 则退回"点了就切"的老行为。
   */
  skipVoteEnabled: true,
  /**
   * 队列「👍 往前挪一位」需要几个**不同的人**点赞（人手一票，可撤）。
   * 默认 3 = 「点赞超过 2 名才往前进一步」：1 个人点不动自己的歌，得凑够 3 个人。
   * 设为 1 就退回"点一下就挪"的老行为（不推荐，容易被一个人把队排乱）。
   */
  queueTopNeed: 3,

  // ---------------- 排行榜（QQ 音乐） ----------------

  /** 排行榜一次给多少首（前端默认 50；QQ 侧一次最多能到 100，总量 300 可翻页） */
  toplistCount: 50,
  /**
   * 排行榜缓存多久（分钟）。
   * QQ 榜单是**日更**（`updateTime` 一天一个值），30 分钟已经很勤了；
   * 这个缓存同时是"QQ 挂了/没网时的兜底"—— 命中缓存不碰网络。
   */
  toplistTtlMin: 30,
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined && v !== null && v !== '') {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  let user = {};
  if (fs.existsSync(CFG_FILE)) {
    try {
      user = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    } catch (e) {
      log('warn', `config.json 解析失败，使用默认配置：${e.message}`);
    }
  } else {
    log('warn', `未找到 ${CFG_FILE}，使用默认配置（播放引擎凭据可能缺失）`);
  }
  let cfg = deepMerge(DEFAULT_CONFIG, user);
  // 环境变量覆盖（容器部署用）
  if (process.env.JB_GD_API) cfg.gdApi = process.env.JB_GD_API;
  if (process.env.JB_PORT) cfg.port = Number(process.env.JB_PORT);
  if (process.env.JB_ENGINE_TYPE) cfg.engine.type = process.env.JB_ENGINE_TYPE;
  if (process.env.JB_ENGINE_BASE) cfg.engine.base = process.env.JB_ENGINE_BASE;
  if (process.env.JB_ENGINE_USER) cfg.engine.username = process.env.JB_ENGINE_USER;
  if (process.env.JB_ENGINE_PASS) cfg.engine.password = process.env.JB_ENGINE_PASS;
  if (process.env.JB_ENGINE_DEVICE) cfg.engine.deviceId = process.env.JB_ENGINE_DEVICE;
  if (process.env.JB_ENGINE_ACCOUNT) cfg.engine.accountId = process.env.JB_ENGINE_ACCOUNT;
  if (process.env.JB_ENGINE_PREFIX) cfg.engine.prefix = process.env.JB_ENGINE_PREFIX;
  if (process.env.JB_VOLUME) cfg.volume = Number(process.env.JB_VOLUME);
  if (process.env.JB_MIN_PLAY_SEC) cfg.minPlaySec = Number(process.env.JB_MIN_PLAY_SEC);
  if (process.env.JB_MAX_TRIES) cfg.maxTries = Number(process.env.JB_MAX_TRIES);
  if (process.env.JB_RATE_COOLDOWN_MS) cfg.rateCooldownMs = Number(process.env.JB_RATE_COOLDOWN_MS);
  if (process.env.JB_POLL_MS) cfg.pollIntervalMs = Number(process.env.JB_POLL_MS);
  if (process.env.JB_STATUS_BLIP_HOLD) cfg.statusBlipHold = Number(process.env.JB_STATUS_BLIP_HOLD);
  if (process.env.JB_STATUS_LEAD_SEC) cfg.statusLeadSec = Number(process.env.JB_STATUS_LEAD_SEC);
  if (process.env.JB_PUBLIC_BASE) cfg.publicBase = process.env.JB_PUBLIC_BASE;
  if (process.env.JB_MUSIC_DIR) cfg.musicDir = process.env.JB_MUSIC_DIR;
  if (process.env.JB_DATA_DIR) cfg.dataDir = process.env.JB_DATA_DIR;
  // 想强制"每次都重新下载"时设 JB_PREFER_CACHE=0（默认开启缓存优先）
  if (process.env.JB_PREFER_CACHE) cfg.preferCache = !/^(0|false|no|off)$/i.test(process.env.JB_PREFER_CACHE);
  if (process.env.JB_LIBRARY_INDEX) cfg.libraryIndexFile = process.env.JB_LIBRARY_INDEX;
  if (process.env.JB_CHAT_MAX) cfg.chatMaxMessages = Number(process.env.JB_CHAT_MAX);
  if (process.env.JB_NICK_MAX) cfg.nickMaxLen = Number(process.env.JB_NICK_MAX);
  if (process.env.JB_NICK_TTL_SEC != null && process.env.JB_NICK_TTL_SEC !== '')
    cfg.nickTtlSec = Number(process.env.JB_NICK_TTL_SEC);
  if (process.env.JB_ONLINE_WINDOW_MS) cfg.onlineWindowMs = Number(process.env.JB_ONLINE_WINDOW_MS);
  if (process.env.JB_SKIP_VOTE) cfg.skipVoteEnabled = !/^(0|false|no|off)$/i.test(process.env.JB_SKIP_VOTE);
  if (process.env.JB_TOPLIST_TTL_MIN) cfg.toplistTtlMin = Number(process.env.JB_TOPLIST_TTL_MIN);
  if (process.env.JB_QUEUE_TOP_NEED) cfg.queueTopNeed = Number(process.env.JB_QUEUE_TOP_NEED);
  // QQ 自建源（凭据也可以走 env，容器里更省事）
  if (process.env.JB_QQ_KEY) cfg.qq.key = process.env.JB_QQ_KEY;
  if (process.env.JB_QQ_UIN) cfg.qq.uin = String(process.env.JB_QQ_UIN);
  if (process.env.JB_QQ_GUID) cfg.qq.guid = process.env.JB_QQ_GUID;
  if (process.env.JB_QQ_QUALITY) cfg.qq.quality = process.env.JB_QQ_QUALITY;

  // 运行期覆盖：Web 端「连接播放引擎」写入，落在数据卷里 → 容器重建不丢
  const overlay = runtimeCfgFile(cfg);
  if (overlay !== CFG_FILE && fs.existsSync(overlay)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(overlay, 'utf8')));
      log('info', `已应用运行期配置：${overlay}`);
    } catch (e) {
      log('warn', `运行期配置解析失败，已忽略：${e.message}`);
    }
  }
  // 放在最后：环境变量优先级最高（想用 env 顶掉文件里的值就走这里）
  if (process.env.JB_ADMIN_PIN) cfg.adminPin = process.env.JB_ADMIN_PIN;
  return cfg;
}

/** 运行期配置文件位置（默认在 dataDir 下，便于跟着数据卷持久化） */
function runtimeCfgFile(cfg) {
  const dir = resolveDir((cfg && cfg.dataDir) || DEFAULT_CONFIG.dataDir);
  return process.env.JB_RUNTIME_CONFIG || path.join(dir, 'runtime-config.json');
}

/** 把一段配置合并写入运行期配置文件 */
async function saveRuntimeConfig(patch) {
  const file = runtimeCfgFile(CONFIG);
  let cur = {};
  try {
    if (fs.existsSync(file)) cur = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    /* 读不出来就当空的，直接覆盖 */
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(deepMerge(cur, patch), null, 2), 'utf8');
  log('info', `运行期配置已保存：${file}`);
  return file;
}

function resolveDir(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

// ---------------------------------------------------------------- 日志

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/** 最近日志环形缓冲（排障用：容器里看不到 stdout 时可从 /api/diag/log 取） */
const LOG_RING = [];

function log(level, ...args) {
  // 注意：loadConfig 内部就会打日志，此时 CONFIG 尚未赋值
  const cfgMin = LEVELS[CONFIG?.logLevel] ?? 2;
  if ((LEVELS[level] ?? 2) > cfgMin) return;
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const tag = { error: 'ERR ', warn: 'WARN', info: 'INFO', debug: 'DBG ' }[level] || 'INFO';
  const line = `[${ts}] ${tag} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  try {
    LOG_RING.push(line);
    if (LOG_RING.length > 500) LOG_RING.splice(0, LOG_RING.length - 500);
  } catch {
    /* 日志缓冲不该影响主流程 */
  }
  console.log(line);
}

// ---------------------------------------------------------------- 音源层

function gdApi() {
  return (CONFIG && CONFIG.gdApi) || GD_API_DEFAULT;
}

/**
 * 出口节流门 + 冷却期
 * ------------------------------------------------------------
 * 实测：GD Studio 挂在 Cloudflare 后面，密集请求会触发 JS Challenge（nginx 503）。
 * 对策：① 所有音源请求串行化并保持最小间隔  ② 撞上 503/429 后进入冷却期
 *       ③ 同关键词搜索结果短时缓存，避免重复打
 */
const RATE = {
  chain: Promise.resolve(),
  lastAt: 0,
  minGapMs: 700,
  cooldownUntil: 0,
  blocked: 0,
};

/** 冷却剩余秒数（0 = 不在冷却） */
function cooldownLeftSec() {
  const left = RATE.cooldownUntil - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * 这个下载错误是"可重试"的吗？
 * ------------------------------------------------------------
 * 音源限流 / 网络抖动 / 取链偶发失败都属于"过一会儿再来就好"，
 * 绝不能把用户点的歌直接从队列里抹掉（那正是"加了歌队列却空了"的原因）。
 * 只有明显是数据本身有问题（歌曲下架、无版权、参数错误）才判为永久失败。
 */
const PERMANENT_ERR = /无版权|下架|不存在|找不到|404|无法播放|歌曲已删除|not found/i;
function isRetryableErr(msg) {
  const m = String(msg || '');
  if (PERMANENT_ERR.test(m)) return false;
  return true;
}

async function throughRateGate(fn) {
  const run = async () => {
    if (Date.now() < RATE.cooldownUntil) {
      const left = Math.ceil((RATE.cooldownUntil - Date.now()) / 1000);
      throw new Error(`音源限流冷却中，请 ${left} 秒后重试`);
    }
    const gap = RATE.minGapMs - (Date.now() - RATE.lastAt);
    if (gap > 0) await sleep(gap);
    try {
      return await fn();
    } finally {
      RATE.lastAt = Date.now();
    }
  };
  const p = RATE.chain.then(run, run);
  RATE.chain = p.then(
    () => {},
    () => {}
  );
  return p;
}

const searchCache = new Map(); // "count|keyword" -> { at, list }
const SEARCH_TTL_MS = 90 * 1000;

/**
 * 熔断：接口明确回「这个 source 不支持」时，把该源记下来，一段时间内直接跳过。
 *
 * 为什么需要：音乐聚合接口随时可能下线某个源（GD Studio 2026-10 就砍掉了
 * kugou/tencent/migu/kuwo，只留 netease/joox/bilibili）。如果配置里还留着死源，
 * 每次失败都要重试 3 次 + 逐源降级，白烧十几倍配额，反而把限流撞得更狠。
 * 记住之后一个小时内不再碰它，等它自己恢复（到期自动重试一次）。
 */
const DEAD_SOURCE_TTL_MS = Math.max(1000, Number(process.env.JB_DEAD_SOURCE_TTL_MS) || 60 * 60 * 1000);
const deadSources = new Map(); // source -> 解封时间戳

function isSourceDead(src) {
  const until = deadSources.get(src);
  if (!until) return false;
  if (Date.now() >= until) {
    deadSources.delete(src);
    log('info', `音源「${src}」熔断到期，重新尝试`);
    return false;
  }
  return true;
}

function markSourceDead(src, reason) {
  if (!src || deadSources.has(src)) return;
  deadSources.set(src, Date.now() + DEAD_SOURCE_TTL_MS);
  log('warn', `音源「${src}」判定不可用，${Math.round(DEAD_SOURCE_TTL_MS / 60000)} 分钟内跳过：${reason}`);
}

/** 永久错误：重试没有任何意义，直接冒泡 */
function permanentError(msg) {
  const e = new Error(msg);
  e.permanent = true;
  return e;
}

async function gdRequest(params, timeoutMs = 15000) {
  if (isSourceDead(params.source)) throw permanentError(`音源「${params.source}」已熔断`);
  return throughRateGate(() => gdFetch(params, timeoutMs));
}

async function gdFetch(params, timeoutMs = 15000) {
  const qs = new URLSearchParams(params).toString();
  const url = `${gdApi()}?${qs}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': CONFIG.userAgent, Accept: 'application/json,*/*' },
      signal: ctl.signal,
    });
    if (r.status === 429 || r.status === 503) {
      RATE.cooldownUntil = Date.now() + (Number(CONFIG?.rateCooldownMs) || 60000);
      RATE.blocked += 1;
      const wait = cooldownLeftSec();
      throw new Error(`音源被限流（HTTP ${r.status}），已进入 ${wait} 秒冷却`);
    }
    if (!r.ok) {
      // 400 + "not supported" 是配置问题，不是网络抖动 —— 重试只会白烧配额
      const body = await r.text().catch(() => '');
      if (r.status === 400 && /not\s*supported/i.test(body)) {
        markSourceDead(params.source, `HTTP 400 ${body.slice(0, 80)}`);
        throw permanentError(`音源「${params.source}」不被接口支持`);
      }
      throw new Error(`HTTP ${r.status}${body ? '：' + body.slice(0, 100) : ''}`);
    }
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

/** 单源搜索 */
async function gdSearchOne(source, keyword, count) {
  const data = await gdRequest({ types: 'search', source, name: keyword, count: String(count), pages: '1' });
  const list = Array.isArray(data) ? data : [];
  return list.map((it) => normalizeSong(it, source));
}

/** 多源搜索：QQ 自建源优先（免费不限次），不够再回落到 GD 的各源并行查询 */
async function search(keyword, count = CONFIG.searchCount) {
  const ck = `${count}|${keyword}`;
  const hit = searchCache.get(ck);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
    log('info', `搜索「${keyword}」→ 命中缓存 ${hit.list.length} 条`);
    return hit.list;
  }

  const wanted = effectiveSources('searchSources').filter(
    (s) => !isSourceDead(s) && (s !== 'qq' || qqConfigured())
  );
  if (!wanted.length) {
    throw new Error('所有音源暂不可用（可能未配置账号、被限流或接口下线），稍后再试');
  }

  const enough = Math.max(0, Number(CONFIG.searchEnough) || 0);
  const seen = new Set();
  const merged = [];
  const stat = [];
  const absorb = (list) => {
    for (const s of list) {
      const key = `${s.name}|${s.artist}`.toLowerCase().replace(/\s+/g, '');
      if (!s.name || seen.has(key)) continue;
      seen.add(key);
      merged.push(s);
    }
  };

  // ① QQ 优先：它不计入公共配额，先问它能把 GD 的额度全省下来
  if (wanted.includes('qq')) {
    try {
      const got = await qqSearch(keyword, count);
      stat.push(`qq:${got.length}`);
      absorb(got);
    } catch (e) {
      stat.push('qq:×');
      log('warn', `搜索源 qq 失败：${e.message}`);
    }
    if (enough && merged.length >= enough) {
      searchCache.set(ck, { at: Date.now(), list: merged });
      if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
      log('info', `搜索「${keyword}」→ ${merged.length} 条（${stat.join(' ')}，QQ 已够，不打扰 GD）`);
      return merged;
    }
  }

  // ② 不够（或没配 QQ）才用 GD，各源仍并行
  const gdSources = wanted.filter((s) => s !== 'qq' && !isSourceDead(s));
  if (gdSources.length) {
    const results = await Promise.allSettled(gdSources.map((s) => gdSearchOne(s, keyword, count)));
    results.forEach((r, i) => {
      const src = gdSources[i];
      if (r.status === 'fulfilled') {
        stat.push(`${src}:${r.value.length}`);
        absorb(r.value);
      } else {
        stat.push(`${src}:×`);
        log('warn', `搜索源 ${src} 失败：${r.reason?.message || r.reason}`);
      }
    });
  }

  if (merged.length) {
    searchCache.set(ck, { at: Date.now(), list: merged });
    if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
  }
  log('info', `搜索「${keyword}」→ ${merged.length} 条（${stat.join(' ')}）`);
  return merged;
}

function normalizeSong(raw, source) {
  const artist = Array.isArray(raw.artist) ? raw.artist.join(' / ') : String(raw.artist || raw.singer || '');
  return {
    source: raw.source || source,
    id: String(raw.id ?? raw.url_id ?? raw.songid ?? ''),
    urlId: String(raw.url_id ?? raw.id ?? ''),
    /** QQ 取链要用的第二个 id（文件名里的那串）；GD 的源没有这个字段 */
    mediaMid: String(raw.mediaMid ?? raw.media_mid ?? ''),
    picId: String(raw.pic_id ?? raw.pic ?? ''),
    lyricId: String(raw.lyric_id ?? raw.lyric ?? ''),
    name: String(raw.name ?? raw.title ?? '').trim(),
    artist,
    album: String(raw.album ?? '').trim(),
  };
}

/** 取直链（单源，带重试） */
async function resolveUrl(song, { retry = CONFIG.retry, br = CONFIG.br } = {}) {
  let lastErr = null;
  for (let i = 0; i < Math.max(1, retry); i++) {
    try {
      const data = await gdRequest({
        types: 'url',
        source: song.source,
        id: song.urlId || song.id,
        br: String(br),
      });
      const url = typeof data === 'string' ? data : data?.url;
      if (!url || !/^https?:\/\//i.test(url)) throw new Error('未返回有效直链');
      return { url, br: data?.br || br, size: data?.size || 0 };
    } catch (e) {
      lastErr = e;
      log('debug', `取链失败 ${song.source}/${song.id} 第${i + 1}次：${e.message}`);
      // 永久错误（源不支持 / 已熔断）重试无意义，留着配额给能用的请求
      if (e.permanent) break;
      // 撞上限流冷却时重试毫无意义（请求会被门直接挡回），立刻冒泡，交给上层排队等
      if (cooldownLeftSec() > 0) break;
      if (i < retry - 1) await sleep(400 + i * 500);
    }
  }
  throw lastErr || new Error('取链失败');
}

/**
 * 完整解析：按 sources 优先级逐源降级，直到拿到可下载的直链
 * 返回 { url, source, br, size }
 *
 * 顺序规则：**用户点的那个源永远排第一**（避免"点的是 live 版、播出来是录音室版"），
 * 其余按 CONFIG.sources 的优先级依次兜底。
 */
async function resolveWithFallback(song) {
  const order = [...new Set([song.source, ...effectiveSources('sources')])].filter(Boolean);
  let lastErr = null;

  for (const src of order) {
    // 已熔断的源连试都不用试（比如接口已下线的 kugou/tencent/migu）
    if (isSourceDead(src)) {
      lastErr = lastErr || permanentError(`音源「${src}」已被标记不可用`);
      continue;
    }
    // QQ 是自建源：没配账号就直接跳过，别处当错误报
    if (src === 'qq' && !qqConfigured()) {
      lastErr = lastErr || permanentError('未配置 QQ 音乐账号');
      continue;
    }
    try {
      let target = song;
      let r;
      if (src === 'qq') {
        // 跨源过来（或手工点的歌）只有歌名歌手，得先在 QQ 里定位到 mid + mediaMid
        if (song.source !== 'qq' || !song.mediaMid) {
          const hits = await qqSearch(`${song.name} ${(song.artist || '').split(' / ')[0]}`.trim(), 5);
          const best = pickBest(hits, song);
          if (!best) {
            lastErr = lastErr || new Error(`QQ 里找不到《${song.name}》`);
            continue;
          }
          target = best;
        }
        r = await qqResolve(target);
      } else {
        // 若换了源，先用 歌名+歌手 在这个源里重新定位（不同源 id 不通用）
        if (src !== song.source) {
          const hits = await gdSearchOne(src, `${song.name} ${(song.artist || '').split(' / ')[0]}`.trim(), 3);
          const best = pickBest(hits, song);
          if (!best) continue;
          target = best;
        }
        r = await resolveUrl({ ...target, id: target.urlId || target.id });
      }
      log('debug', `取链成功：${src} ${song.name}`);
      return { ...r, source: src, matched: target };
    } catch (e) {
      lastErr = e;
      log('debug', `源 ${src} 整体失败：${e.message}`);
      // 限流是"全局性"的，换源也一样打不出去，别白转一圈
      if (cooldownLeftSec() > 0) break;
    }
  }
  throw lastErr || new Error('所有音源均取链失败');
}

function pickBest(candidates, want) {
  if (!candidates.length) return null;
  const wantName = (want.name || '').toLowerCase().replace(/\s+/g, '');
  const wantArtist = (want.artist || '').split(' / ')[0].toLowerCase().replace(/\s+/g, '');
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    const cn = c.name.toLowerCase().replace(/\s+/g, '');
    const ca = (c.artist || '').toLowerCase().replace(/\s+/g, '');
    let score = 0;
    if (cn === wantName) score += 3;
    else if (cn.includes(wantName) || wantName.includes(cn)) score += 1;
    if (wantArtist && ca.includes(wantArtist)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore > 0 ? best : candidates[0];
}

// ---------------------------------------------------------------- QQ 音乐（自建源）
/**
 * 为什么要有这一段
 * ------------------------------------------------------------
 * GD Studio 是公共聚合接口，5 分钟只给 50 次请求，撞线就 503 —— 一家人在客厅点歌，
 * 几十次搜索就见底了。QQ 官方接口这条路没有公共配额：搜索接口免费且免登录，
 * 取链用自己的会员 cookie（qm_keyst）换直链，请求只算在自己账号头上。
 *
 * 接口形态（2026-10-19 实测通过）：
 *   POST https://u.y.qq.com/cgi-bin/musics.fcg?format=json&sign=<QMWSign>
 *   搜索  module=music.search.SearchCgiService  → mid / media_mid / 时长 / 歌手
 *   取链  module=vkey.GetVkeyServer             → purl 拼接 sip 即完整直链
 *
 * 签名（QMWSign）是纯算法、没有密钥：md5(body) 大写后按固定位置取值，
 * 叠一层异或掩码再做变体 base64，前缀 `zzb`。移植自 Jusic 的 QMWSign.java。
 *
 * 实测能力（会员账号）：
 *   128k / 320k / flac 三档都能换到链；flac24bit、hires（臻品母带）要更高等级，返回 JSON 错误
 *   拿到的文件是**完整曲目**（320k≈269s 的歌 10.3MB，FLAC 52.8MB），不是试听片段
 *   CDN 支持 Range、可裸拉（音箱直连外网时就是这么拉的）
 */

const QQ_Q = {
  '128k': { prefix: 'M500', ext: '.mp3', br: 128 },
  '320k': { prefix: 'M800', ext: '.mp3', br: 320 },
  flac: { prefix: 'F000', ext: '.flac', br: 900 },
};

/** QQ 请求节流（独立于 GD 的门：GD 的冷却不该把 QQ 一起冻住，反之亦然） */
const QQG = {
  chain: Promise.resolve(),
  lastAt: 0,
  minGapMs: 250,
  /** 被风控时暂停到这个时间点 */
  blockedUntil: 0,
  lastOkAt: 0,
  lastErr: '',
  reqCount: 0,
};

function qqCfg() {
  return (CONFIG && CONFIG.qq) || DEFAULT_CONFIG.qq;
}

function qqConfigured() {
  const c = qqCfg();
  return !!(c.key && c.uin);
}

/**
 * 生效的音源列表（取链 `sources` / 搜索 `searchSources`）。
 *
 * 为什么要这一层：老配置里写的是 `["netease"]`（QQ 源还不存在那会儿），
 * 部署新代码后如果照搬配置，**就算在页面上填了 QQ 账号也不会被用到** ——
 * 排查起来极难发现。既然用户主动配了账号，就保证它排在最前面。
 */
function effectiveSources(key) {
  const list = Array.isArray(CONFIG[key]) ? CONFIG[key].slice() : [];
  if (!qqConfigured()) return list;
  return ['qq', ...list.filter((s) => s !== 'qq')];
}

/** QQ 号脱敏，日志和接口里都只出现这个形态 */
function qqMaskUin(uin) {
  const s = String(uin || '');
  if (!s) return '';
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 3)}${'*'.repeat(Math.max(2, s.length - 5))}${s.slice(-2)}`;
}

function qqQuality() {
  const q = String(qqCfg().quality || '320k');
  return QQ_Q[q] ? q : '320k';
}

function qqGuid() {
  return String(qqCfg().guid || '') || '114514';
}

/** QMWSign：纯计算，无密钥 */
function qqSign(params) {
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
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let enc = '';
  for (let i = 0; i < codes.length; i += 3) {
    const a = codes[i];
    const b = codes[i + 1];
    const c = codes[i + 2];
    if (i < codes.length - 2) {
      enc += table[a >> 2];
      enc += table[((a & 3) << 4) | (b >> 4)];
      enc += table[((b & 15) << 2) | (c >> 6)];
      enc += table[c & 63];
    } else {
      // 末块不足 3 字节：原实现仍补齐 4 个字符，最后统一砍掉尾部 2 个
      enc += table[a >> 2];
      enc += table[(a & 3) << 4];
      enc += table[0];
      enc += table[0];
    }
  }
  enc = enc.slice(0, enc.length - 2);
  const pick = (idx) => idx.map((i) => md5[i]).join('');
  const raw = 'zzb' + pick([21, 4, 9, 26, 16, 20, 27, 30]) + enc + pick([18, 11, 3, 2, 1, 7, 6, 25]);
  return raw.toLowerCase().replace(/[/+]/g, '');
}

/** 串行 + 最小间隔，避免同一账号短时间打太密 */
function qqGate(fn) {
  const run = async () => {
    const now = Date.now();
    if (QQG.blockedUntil > now) {
      throw new Error(`QQ 接口风控中，请 ${Math.ceil((QQG.blockedUntil - now) / 1000)} 秒后重试`);
    }
    const gap = QQG.minGapMs - (Date.now() - QQG.lastAt);
    if (gap > 0) await sleep(gap);
    try {
      return await fn();
    } finally {
      QQG.lastAt = Date.now();
    }
  };
  const p = QQG.chain.then(run, run);
  QQG.chain = p.then(
    () => {},
    () => {}
  );
  return p;
}

async function qqFcg(payload, timeoutMs = 12000) {
  if (!qqConfigured()) throw permanentError('未配置 QQ 音乐账号（qm_keyst / QQ 号）');
  const body = JSON.stringify(payload);
  // JB_QQ_API 只给离线测试用（指向 mock），生产不设这个变量
  const base = String(process.env.JB_QQ_API || 'https://u.y.qq.com').replace(/\/+$/, '');
  const url = `${base}/cgi-bin/musics.fcg?format=json&sign=${qqSign(body)}`;
  return qqGate(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    QQG.reqCount += 1;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': CONFIG.userAgent, 'Content-Type': 'application/json' },
        body,
        signal: ctl.signal,
      });
      if (r.status === 403 || r.status === 418 || r.status === 429 || r.status === 503) {
        QQG.blockedUntil = Date.now() + 5 * 60 * 1000;
        QQG.lastErr = `HTTP ${r.status}`;
        throw new Error(`QQ 接口被风控（HTTP ${r.status}），已暂停 5 分钟`);
      }
      if (!r.ok) throw new Error(`QQ 接口 HTTP ${r.status}`);
      const text = await r.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        QQG.lastErr = '非 JSON 响应';
        throw new Error('QQ 接口返回非 JSON（可能被风控拦截）');
      }
      QQG.lastOkAt = Date.now();
      return json;
    } finally {
      clearTimeout(timer);
    }
  });
}

/** 搜索：免费、不限次数，返回带 mediaMid（取链必需） */
async function qqSearch(keyword, count = CONFIG.searchCount) {
  const json = await qqFcg({
    req_1: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { num_per_page: count, page_num: 1, query: keyword, search_type: 0 },
    },
    comm: { ct: '19', cv: '1859', v: '1859' },
  });
  if (json.code !== 0) {
    QQG.lastErr = `搜索 code=${json.code}`;
    throw new Error(`QQ 搜索失败（code ${json.code}）`);
  }
  const list = json?.req_1?.data?.body?.song?.list || [];
  return list
    .map((x) => ({
      source: 'qq',
      id: String(x.mid || ''),
      urlId: String(x.mid || ''),
      mediaMid: String(x.file?.media_mid || x.mid || ''),
      picId: '',
      lyricId: '',
      name: String(x.name || '').trim(),
      artist: (x.singer || []).map((s) => s.name).join(' / '),
      album: String(x.album?.name || ''),
      duration: Number(x.interval) || 0,
    }))
    .filter((x) => x.id && x.name);
}

/**
 * 取直链。先按配置音质要，拿不到再退一档（会员歌单里偶尔有只给 128k 的）。
 * 返回 { url, br, quality }；purl 为空 = 这首没版权/要更高等级，交给上层降级。
 */
async function qqResolve(song) {
  const c = qqCfg();
  const mid = String(song.urlId || song.id || '');
  const mediaMid = String(song.mediaMid || song.media_mid || mid);
  if (!mid) throw permanentError('QQ 曲目缺少 mid');
  const want = qqQuality();
  const order = want === '320k' ? ['320k', '128k'] : want === 'flac' ? ['flac', '320k', '128k'] : ['128k'];
  let lastReason = '';

  for (const q of order) {
    const spec = QQ_Q[q];
    const json = await qqFcg({
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          filename: [spec.prefix + mediaMid + spec.ext],
          guid: qqGuid(),
          songmid: [mid],
          songtype: [0],
          uin: String(c.uin),
          loginflag: 1,
          platform: '20',
        },
      },
      comm: { qq: String(c.uin), authst: String(c.key), ct: '26', cv: '2010101', v: '2010101' },
    });
    if (json.code !== 0) {
      // code≠0 多半是签名/凭据问题 —— 这是源头级的，重试和换音质都没意义
      QQG.lastErr = `取链 code=${json.code}`;
      markSourceDead('qq', `取链返回 code=${json.code}`);
      throw permanentError(`QQ 取链失败（code ${json.code}）`);
    }
    const info = json?.req_0?.data?.midurlinfo?.[0] || {};
    const purl = String(info.purl || '');
    if (purl) {
      const sip = String(json?.req_0?.data?.sip?.[0] || 'http://aqqmusic.tc.qq.com/');
      const url = /^https?:\/\//i.test(purl) ? purl : sip.replace(/\/+$/, '') + '/' + purl.replace(/^\/+/, '');
      return { url, br: spec.br, quality: q };
    }
    // result 104003 = 需要登录/付费；110001 之类多为无版权
    lastReason = `result=${info.result ?? '?'} subcode=${info.subcode ?? '?'}`;
    log('debug', `QQ ${q} 无直链《${song.name}》${lastReason}`);
  }
  throw new Error(`QQ 无可用直链（${lastReason || '未知原因'}）`);
}

// ---------------------------------------------------------------- 排行榜
//
// QQ 的榜单接口和搜索在**同一个 musics.fcg** 上，只是 module 不同：
//   musicToplist.ToplistInfoServer / GetAll    → 30 个榜单（巅峰榜/地区/语种…）
//   musicToplist.ToplistInfoServer / GetDetail → 曲目
// ⚠️ 曲目在 `req_1.data.songInfoList`；`req_1.data.data` 是**榜单元信息**（标题/更新日期/总数），别搞反。
// 榜单给的字段（mid + file.media_mid）和搜索完全同构 → 取链、本地缓存、降级、投票全复用，
// 不新增任何音源侧的风险面；点歌走的还是 /api/enqueue。
//
// 缓存两层：内存 + <dataDir>/toplist.json（断网/QQ 挂了也能看榜，已缓存的歌照样能点）。

const TOP = {
  lists: [],          // [{ topId, title, group }]
  listsAt: 0,
  details: new Map(), // topId -> { at, title, updateTime, totalNum, songs }
  lastErr: '',
};

/** 一次抓满多少首存进缓存（QQ 侧 num 上限 100；总量 300，不翻页也够点歌） */
const TOP_FETCH_NUM = 100;
/** 榜单列表本身（哪个榜叫什么）很少变，缓存 6 小时 */
const TOP_LISTS_TTL_MS = 6 * 3600 * 1000;

function toplistTtlMs() {
  return Math.max(1, Number(CONFIG.toplistTtlMin) || 30) * 60000;
}
function toplistPath() {
  return path.join(CONFIG.dataDir, 'toplist.json');
}

function loadToplistCache() {
  try {
    if (!fs.existsSync(toplistPath())) return;
    const j = JSON.parse(fs.readFileSync(toplistPath(), 'utf8'));
    if (Array.isArray(j.lists)) {
      TOP.lists = j.lists;
      TOP.listsAt = Number(j.listsAt) || 0;
    }
    Object.entries(j.details || {}).forEach(([k, v]) => {
      if (v && Array.isArray(v.songs)) TOP.details.set(Number(k), { ...v, at: Number(v.at) || 0 });
    });
    log('info', `排行榜缓存已载入（${TOP.lists.length} 个榜单 / ${TOP.details.size} 份详情）`);
  } catch (e) {
    log('warn', `排行榜缓存载入失败（忽略）：${e.message}`);
  }
}

function saveToplistCache() {
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    const details = {};
    TOP.details.forEach((v, k) => {
      details[k] = v;
    });
    fs.writeFileSync(
      toplistPath(),
      JSON.stringify({ version: 1, lists: TOP.lists, listsAt: TOP.listsAt, details }),
      'utf8'
    );
  } catch (e) {
    log('warn', `排行榜缓存写入失败：${e.message}`);
  }
}

/** 榜单曲目 → 和 qqSearch 同构的 song 对象（rank 只是给前端显示名次） */
function mapTopSong(x, rank) {
  const mid = String(x.mid || x.songmid || '');
  return {
    source: 'qq',
    id: mid,
    urlId: mid,
    mediaMid: String((x.file && x.file.media_mid) || mid),
    name: String(x.name || x.title || '').trim(),
    artist: (x.singer || []).map((s) => s.name).filter(Boolean).join(' / '),
    album: String((x.album && x.album.name) || ''),
    duration: Number(x.interval) || 0,
    rank: rank || 0,
  };
}

/** 榜单列表（30 个）。缓存 6 小时；失败但有旧数据就返回旧数据 */
async function qqToplists({ force = false } = {}) {
  if (!force && TOP.lists.length && Date.now() - TOP.listsAt < TOP_LISTS_TTL_MS) {
    return { lists: TOP.lists, at: TOP.listsAt, cached: true };
  }
  try {
    const json = await qqFcg({
      comm: { ct: 24, cv: 0 },
      req_1: { module: 'musicToplist.ToplistInfoServer', method: 'GetAll', param: {} },
    });
    if (json.code !== 0) throw new Error(`榜单列表 code=${json.code}`);
    const groups = (json.req_1 && json.req_1.data && json.req_1.data.group) || [];
    const lists = [];
    for (const g of groups) {
      for (const t of g.toplist || []) {
        const topId = Number(t.topId);
        const title = String(t.title || '').trim();
        if (!topId || !title) continue;
        lists.push({ topId, title, group: String(g.groupName || '') });
      }
    }
    if (!lists.length) throw new Error('榜单列表是空的');
    TOP.lists = lists;
    TOP.listsAt = Date.now();
    TOP.lastErr = '';
    saveToplistCache();
    log('info', `🏆 已拉取榜单列表：${lists.length} 个`);
    return { lists, at: TOP.listsAt, cached: false };
  } catch (e) {
    TOP.lastErr = e.message;
    if (TOP.lists.length) {
      log('warn', `榜单列表拉取失败，用缓存兜底：${e.message}`);
      return { lists: TOP.lists, at: TOP.listsAt, cached: true, stale: true, error: e.message };
    }
    throw e;
  }
}

/**
 * 某个榜的曲目。缓存整份 100 首，按请求的 n 切片 ——
 * 这样切榜单/翻前 30 首都不会再打一次 QQ。
 */
async function qqToplist(topId, num, { force = false } = {}) {
  const id = Number(topId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('榜单 id 不对');
  const n = Math.max(1, Math.min(TOP_FETCH_NUM, Math.round(Number(num)) || Number(CONFIG.toplistCount) || 50));
  const hit = TOP.details.get(id);
  if (!force && hit && Date.now() - hit.at < toplistTtlMs()) {
    return { ...hit, songs: hit.songs.slice(0, n), cached: true };
  }
  try {
    const json = await qqFcg({
      comm: { ct: 24, cv: 0 },
      req_1: {
        module: 'musicToplist.ToplistInfoServer',
        method: 'GetDetail',
        param: { topId: id, offset: 0, num: TOP_FETCH_NUM, period: '' },
      },
    });
    if (json.code !== 0) throw new Error(`榜单 code=${json.code}`);
    const pkg = (json.req_1 && json.req_1.data) || {};
    const meta = pkg.data || {};
    const raw = Array.isArray(pkg.songInfoList) ? pkg.songInfoList : [];
    const songs = raw.map((x, i) => mapTopSong(x, i + 1)).filter((s) => s.id && s.name);
    if (!songs.length) throw new Error('这个榜单没有返回曲目');
    const data = {
      at: Date.now(),
      title: String(meta.title || ''),
      updateTime: String(meta.updateTime || ''),
      totalNum: Number(meta.totalNum) || songs.length,
      songs,
    };
    TOP.details.set(id, data);
    TOP.lastErr = '';
    saveToplistCache();
    log('info', `🏆 榜单「${data.title || id}」已更新：${songs.length} 首（榜单日期 ${data.updateTime || '?'}）`);
    return { ...data, songs: songs.slice(0, n), cached: false };
  } catch (e) {
    TOP.lastErr = e.message;
    if (hit) {
      log('warn', `榜单「${hit.title || id}」拉取失败，用缓存兜底：${e.message}`);
      return { ...hit, songs: hit.songs.slice(0, n), cached: true, stale: true, error: e.message };
    }
    throw e;
  }
}

/** 排行榜概况（/api/diag 用；不含曲目正文） */
function toplistStatus() {
  return {
    lists: TOP.lists.length,
    listsAt: TOP.listsAt,
    cachedTops: [...TOP.details.keys()],
    ttlMin: Math.round(toplistTtlMs() / 60000),
    lastErr: TOP.lastErr,
  };
}

/** 给接口/排障看的 QQ 状态（不含凭据本身） */
function qqStatus() {
  const c = qqCfg();
  return {
    configured: qqConfigured(),
    uin: qqMaskUin(c.uin),
    quality: qqQuality(),
    broken: isSourceDead('qq'),
    lastOkAt: QQG.lastOkAt,
    lastErr: QQG.lastErr,
    reqCount: QQG.reqCount,
    blockedLeftSec: QQG.blockedUntil > Date.now() ? Math.ceil((QQG.blockedUntil - Date.now()) / 1000) : 0,
  };
}

/**
 * 自测一条龙：搜一首 → 换直链 → Range 拉 1KB 验 CDN。
 * 用来回答"key 是不是过期了 / 会员是不是掉了"，比看日志快得多。
 */
async function qqSelfTest(keyword = '晴天 周杰伦') {
  const t0 = Date.now();
  const out = { ok: false, step: 'search', detail: '', ms: 0 };
  try {
    const hits = await qqSearch(keyword, 3);
    if (!hits.length) {
      out.detail = '搜索没有结果';
      out.ms = Date.now() - t0;
      return out;
    }
    const song = hits[0];
    out.song = `${song.name} — ${song.artist}`;
    out.step = 'resolve';
    const r = await qqResolve(song);
    out.quality = r.quality;
    out.urlHost = (() => {
      try {
        return new URL(r.url).host;
      } catch {
        return '';
      }
    })();
    out.step = 'download';
    const a = await fetch(r.url, { headers: { 'User-Agent': CONFIG.userAgent, Range: 'bytes=0-1023' } });
    const buf = Buffer.from(await a.arrayBuffer());
    const fmt = sniffAudio(buf);
    out.http = a.status;
    out.bytes = buf.length;
    out.format = fmt || 'unknown';
    out.ok = (a.status === 200 || a.status === 206) && !!fmt;
    if (!out.ok) out.detail = `CDN 返回 HTTP ${a.status}，内容识别为 ${fmt || '非音频'}`;
  } catch (e) {
    out.detail = e.message;
  }
  out.ms = Date.now() - t0;
  return out;
}

// ---------------------------------------------------------------- 下载与缓存

/** 按 歌手+歌名 生成稳定 key，用于本地曲库命中 */
function songKey(song) {
  const s = `${song.artist || ''}|${song.name || ''}`.toLowerCase().replace(/\s+/g, '');
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

function safeFileName(song, ext) {
  const base = `${song.artist ? song.artist + ' - ' : ''}${song.name}`;
  const clean = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  return `${clean}.${ext}`;
}

/** 音频格式嗅探（magic bytes） */
function sniffAudio(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (buf.slice(0, 4).toString('latin1') === 'fLaC') return 'flac';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (buf.slice(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF') return 'wav';
  return null;
}

/** 估算 mp3 时长（秒），用于兜底切歌。返回 0 表示无法估算 */
function estimateDurationSec(bytes, brKbps) {
  if (!bytes || !brKbps) return 0;
  return Math.round(bytes / (brKbps * 1000 / 8));
}

// ---------------------------------------------------------------- 真实时长探测
/**
 * 为什么需要它：音源接口给的 br 是"请求码率"，不等于文件真实码率。
 * 按错误码率算时长会让兜底切歌提前或延后（实测踩过：5 分钟的歌被当成 20 秒）。
 * 这里直接解析音频文件头拿真实时长 —— mp3(CBR) / flac / wav 都能精确算。
 */

const MP3_BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BR_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MP3_SR = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000],  // MPEG2.5
};

/** mp3：跳过 ID3v2 → 找到第一个合法帧头 → 按帧长推算总时长 */
function mp3DurationSec(b, totalBytes) {
  let off = 0;
  if (b.length > 10 && b.slice(0, 3).toString('latin1') === 'ID3') {
    const tagSize = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    off = 10 + tagSize + (b[5] & 0x10 ? 10 : 0);
  }
  for (let i = off; i < b.length - 4; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const verBits = (b[i + 1] >> 3) & 0x03;
    const layerBits = (b[i + 1] >> 1) & 0x03;
    const brIdx = (b[i + 2] >> 4) & 0x0f;
    const srIdx = (b[i + 2] >> 2) & 0x03;
    const pad = (b[i + 2] >> 1) & 0x01;
    if (verBits === 1 || layerBits !== 1) continue; // 只认 Layer III
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const mpeg1 = verBits === 3;
    const br = (mpeg1 ? MP3_BR_V1_L3 : MP3_BR_V2_L3)[brIdx] * 1000;
    const sr = MP3_SR[verBits] && MP3_SR[verBits][srIdx];
    if (!br || !sr) continue;
    const samplesPerFrame = mpeg1 ? 1152 : 576;
    const frameLen = Math.floor((samplesPerFrame / 8) * br / sr) + pad;
    if (frameLen <= 4 || i + frameLen > b.length) continue;
    // 用下一帧同步头校验，排除把随机数据当成帧头
    if (i + frameLen + 1 < b.length) {
      if (b[i + frameLen] !== 0xff || (b[i + frameLen + 1] & 0xe0) !== 0xe0) continue;
    }
    const audioBytes = (totalBytes || b.length) - i;
    const sec = (audioBytes / frameLen) * (samplesPerFrame / sr);
    return Math.round(sec * 10) / 10;
  }
  return 0;
}

/** flac：STREAMINFO 里有总采样数 */
function flacDurationSec(b) {
  if (b.length < 26 || b.slice(0, 4).toString('latin1') !== 'fLaC') return 0;
  if ((b[4] & 0x7f) !== 0) return 0; // 第一个元数据块必须是 STREAMINFO
  const sr = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  const total = (b[20] & 0x0f) * 4294967296 + b.readUInt32BE(21);
  if (!sr || !total) return 0;
  return Math.round((total / sr) * 10) / 10;
}

/** wav：data 块大小 / 字节率 */
function wavDurationSec(b) {
  if (b.length < 44) return 0;
  if (b.slice(0, 4).toString('latin1') !== 'RIFF' || b.slice(8, 12).toString('latin1') !== 'WAVE') return 0;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= b.length) {
    const id = b.slice(off, off + 4).toString('latin1');
    const size = b.readUInt32LE(off + 4);
    // fmt 块内布局：0-1 格式 2-3 声道 4-7 采样率 8-11 字节率 → 绝对偏移 off+8+8
    if (id === 'fmt ' && off + 20 <= b.length) byteRate = b.readUInt32LE(off + 16);
    if (id === 'data' && byteRate > 0) return Math.round((size / byteRate) * 10) / 10;
    if (size <= 0) break;
    off += 8 + size + (size % 2);
  }
  return 0;
}

/** 从缓冲区探测时长；返回 0 表示探不出来 */
function probeDurationSec(buf, totalBytes, ext) {
  const fmt = sniffAudio(buf) || (ext || '').replace('.', '');
  try {
    if (fmt === 'mp3') return mp3DurationSec(buf, totalBytes);
    if (fmt === 'flac') return flacDurationSec(buf);
    if (fmt === 'wav') return wavDurationSec(buf);
  } catch {
    return 0;
  }
  return 0;
}

/** 读文件头探测真实时长（秒），失败返回 0 */
async function measureDurationSec(file, totalBytes) {
  try {
    const fd = await fsp.open(file, 'r');
    try {
      const head = Buffer.alloc(Math.min(262144, Math.max(1024, totalBytes || 262144)));
      const { bytesRead } = await fd.read(head, 0, head.length, 0);
      return probeDurationSec(head.slice(0, bytesRead), totalBytes, path.extname(file));
    } finally {
      await fd.close();
    }
  } catch {
    return 0;
  }
}

/**
 * 曲库索引：songKey -> 曲目元信息
 *   { key, file, name, artist, album, source, ext, size, duration, addedAt, lastPlayedAt, plays, origin }
 *
 * 为什么不靠文件名反推：文件名约定是 "歌手 - 歌名.ext"，歌手名里只要带 ' - ' 就还原错；
 * 而且反推拿不到专辑 / 来源 / 真实时长。所以下载完当场把元信息写进 <dataDir>/library.json，
 * 重启直接读回来；只有人工丢进目录、索引里没有的文件才走文件名兜底。
 */
const LIB = new Map();
const fileIndex = new Map(); // songKey -> 绝对路径（推流 / 诊断沿用）
const AUDIO_EXTS = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav'];

function libraryIndexPath() {
  const cfg = CONFIG || DEFAULT_CONFIG;
  if (cfg.libraryIndexFile) return resolveDir(cfg.libraryIndexFile);
  return path.join(resolveDir(cfg.dataDir || DEFAULT_CONFIG.dataDir), 'library.json');
}

let libSaveTimer = null;

/**
 * 落盘曲库索引。
 * 直接同步写：写盘频率 = 每首歌（下载完 / 命中一次），量级极小；
 * 换来的是"哪怕容器被 kill 也不会把刚下载的歌从索引里丢掉"。
 */
function saveLibraryIndex() {
  flushLibraryIndex();
}

function flushLibraryIndex() {
  clearTimeout(libSaveTimer);
  const file = libraryIndexPath();
  const items = [...LIB.values()].map((v) => ({ ...v, file: path.basename(v.file) }));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: Date.now(), items }, null, 1), 'utf8');
  } catch (e) {
    log('warn', `曲库索引写入失败：${e.message}`);
  }
}

/** 收录/更新一条曲库记录 */
function upsertLocal(song, file, extra = {}) {
  const key = extra.key || songKey(song);
  const prev = LIB.get(key) || {};
  const rec = {
    key,
    file,
    name: song.name || prev.name || path.basename(file),
    artist: song.artist || prev.artist || '',
    album: song.album || prev.album || '',
    source: extra.source || song.source || prev.source || 'local',
    ext: (path.extname(file).slice(1) || 'mp3').toLowerCase(),
    size: extra.size || prev.size || 0,
    duration: extra.duration || prev.duration || 0,
    addedAt: prev.addedAt || extra.addedAt || Date.now(),
    lastPlayedAt: prev.lastPlayedAt || 0,
    plays: prev.plays || 0,
    origin: extra.origin || prev.origin || 'download',
  };
  LIB.set(key, rec);
  fileIndex.set(key, file);
  saveLibraryIndex();
  return rec;
}

async function scanLocalLibrary() {
  // ① 读回索引（元信息以它为准）
  const byBase = new Map();
  try {
    const raw = JSON.parse(await fsp.readFile(libraryIndexPath(), 'utf8'));
    for (const it of raw.items || []) {
      if (!it || !it.file || !it.key) continue;
      byBase.set(path.basename(it.file), it);
    }
  } catch {
    /* 首次运行还没有索引文件 */
  }

  LIB.clear();
  fileIndex.clear();
  let n = 0;
  let fromIndex = 0;
  try {
    const entries = await fsp.readdir(CONFIG.musicDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!AUDIO_EXTS.includes(ext)) continue;
      const full = path.join(CONFIG.musicDir, e.name);
      const st = await fsp.stat(full).catch(() => null);
      if (!st || st.size <= 8192) continue; // 碎文件 / .part 残渣不进库

      let rec = byBase.get(e.name);
      if (rec) {
        rec = { ...rec, file: full, size: st.size, ext: ext.slice(1) };
        fromIndex++;
      } else {
        // 索引里没有 → 人工放进来的文件，按 "歌手 - 歌名.ext" 兜底
        const stem = e.name.slice(0, -ext.length);
        const parts = stem.split(' - ');
        const artist = parts.length > 1 ? parts.slice(0, -1).join(' - ') : '';
        const name = parts.length > 1 ? parts[parts.length - 1] : stem;
        rec = {
          key: songKey({ artist, name }),
          file: full,
          name,
          artist,
          album: '',
          source: 'local',
          ext: ext.slice(1),
          size: st.size,
          duration: 0,
          addedAt: st.mtimeMs || Date.now(),
          lastPlayedAt: 0,
          plays: 0,
          origin: 'scanned',
        };
      }
      LIB.set(rec.key, rec);
      fileIndex.set(rec.key, full);
      n++;
    }
  } catch (e) {
    log('warn', `扫描本地曲库失败：${e.message}`);
  }

  // ② 给"还没量过时长"的补测（启动时最多补 40 首，别把启动拖太久）
  let probed = 0;
  for (const rec of LIB.values()) {
    if (rec.duration || probed >= 40) continue;
    rec.duration = await measureDurationSec(rec.file, rec.size);
    if (rec.duration) probed++;
  }
  if (n) saveLibraryIndex();
  const stat = libraryStats();
  log('info', `本地曲库：${n} 首 / ${(stat.bytes / 1048576).toFixed(1)}MB（索引命中 ${fromIndex} 首，补测时长 ${probed} 首）`);
  return n;
}

function libraryStats() {
  let bytes = 0;
  let secs = 0;
  for (const r of LIB.values()) {
    bytes += r.size || 0;
    secs += r.duration || 0;
  }
  return { count: LIB.size, bytes, durationSec: Math.round(secs), dir: CONFIG ? CONFIG.musicDir : '' };
}

/**
 * 命中本地曲库。
 * 查找顺序：显式 key（前端从曲库列表点进来的）→ 歌手+歌名哈希 → 只有歌名时的宽松匹配
 */
function findLocal(song) {
  if (!song) return null;
  if (song.localKey && LIB.has(song.localKey)) return LIB.get(song.localKey);
  const k = songKey(song);
  if (LIB.has(k)) return LIB.get(k);
  if (song.name && !song.artist) {
    const want = String(song.name).toLowerCase().replace(/\s+/g, '');
    for (const r of LIB.values()) {
      if (String(r.name).toLowerCase().replace(/\s+/g, '') === want) return r;
    }
  }
  return null;
}

/** 歌名 / 歌手打分，0 = 不匹配（搜索结果置顶与曲库搜索共用） */
function localMatchScore(rec, kw) {
  const k = String(kw || '').toLowerCase().replace(/\s+/g, '');
  if (!k) return 0;
  const n = String(rec.name || '').toLowerCase().replace(/\s+/g, '');
  const a = String(rec.artist || '').toLowerCase().replace(/\s+/g, '');
  let s = 0;
  if (n && n === k) s += 6;
  else if (n && n.includes(k)) s += 4;
  else if (n && k.includes(n)) s += 2;
  if (a && a === k) s += 3;
  else if (a && a.includes(k)) s += 2;
  if (!s && String(rec.album || '').toLowerCase().includes(k)) s += 1;
  return s;
}

/** 把曲库条目变成可直接点播的 song 对象（source:'local'，不需要再碰音源） */
function localSongOf(rec) {
  return {
    source: 'local',
    localKey: rec.key,
    id: `local:${rec.key}`,
    urlId: rec.key,
    picId: '',
    lyricId: '',
    name: rec.name || path.basename(rec.file, path.extname(rec.file)),
    artist: rec.artist || '',
    album: rec.album || '',
    duration: rec.duration || 0,
    bytes: rec.size || 0,
    cached: true,
    local: true,
  };
}

/**
 * 搜索结果"本地优先"装饰：
 *   ① 每首在线结果标注 cached（NAS 里已经有文件）
 *   ② 曲库里独有、在线源搜不到的（下架 / 限流）也一并列出来 —— 有 NAS 就还能点
 *   ③ 排序：本地独有 → 已缓存 → 在线，同组内保持音源原有顺序
 */
function decorateWithLocal(kw, list) {
  const seen = new Set();
  const online = [];
  for (const s of list || []) {
    const hit = findLocal(s);
    if (hit) {
      seen.add(hit.key);
      online.push({ ...s, cached: true, localKey: hit.key, duration: hit.duration || 0, bytes: hit.size || 0, ext: hit.ext });
    } else {
      online.push({ ...s, cached: false });
    }
  }

  const locals = [];
  for (const rec of LIB.values()) {
    if (seen.has(rec.key)) continue;
    const sc = localMatchScore(rec, kw);
    if (sc > 0) locals.push({ song: localSongOf(rec), sc, last: rec.lastPlayedAt || rec.addedAt || 0 });
  }
  locals.sort((x, y) => y.sc - x.sc || y.last - x.last);
  const topN = Math.max(0, Number(CONFIG.localTopN) || 10);

  return [
    ...locals.slice(0, topN).map((x) => x.song),
    ...online.filter((x) => x.cached),
    ...online.filter((x) => !x.cached),
  ];
}

/** 曲库列表（给前端「NAS 曲库」面板用） */
function libraryList({ q = '', limit = 200, offset = 0 } = {}) {
  let items = [...LIB.values()];
  if (q) items = items.filter((r) => localMatchScore(r, q) > 0);
  items.sort((a, b) => (b.lastPlayedAt || b.addedAt || 0) - (a.lastPlayedAt || a.addedAt || 0));
  const total = items.length;
  const page = items.slice(offset, offset + limit);
  return {
    total,
    count: page.length,
    offset,
    stats: libraryStats(),
    items: page.map((r) => ({
      ...localSongOf(r),
      key: r.key,
      file: path.basename(r.file),
      size: r.size || 0,
      ext: r.ext,
      addedAt: r.addedAt || 0,
      lastPlayedAt: r.lastPlayedAt || 0,
      plays: r.plays || 0,
      origin: r.origin,
      streamUrl: `${publicBase()}/audio/${r.key}.${r.ext}`,
    })),
  };
}

/**
 * 随机电台：从 NAS 曲库挑一首。
 *
 * 挑选规则（故意做得比 `Math.random()` 笨一点）：
 *   ① 只挑**文件确实在、且没被判定坏掉**的（LIB 里的记录可能是外部删掉的残留）
 *   ② 排掉最近播过的 `radioRecentMax` 首 —— 曲库只有 8 首时听感不会变成"两首来回换"
 *      （池子被排空就清空历史重新来，绝不返回 null 卡住）
 *   ③ 排掉刚播完那一首，避免连续两遍
 *   ④ 曲库多于 1 首时等概率随机；同分不做加权 —— 用户要的就是"随机"
 */
function pickRadioSong() {
  const bad = state.radioBad;
  const pool0 = [];
  for (const rec of LIB.values()) {
    if (!rec || !rec.file || !rec.key) continue;
    if (bad.has(rec.key)) continue;
    if (!(rec.size > 8192)) continue;
    pool0.push(rec);
  }
  if (!pool0.length) return null;

  const recent = new Set(state.radioRecent);
  let pool = pool0.filter((r) => !recent.has(r.key));
  if (!pool.length) {
    // 一圈轮完了：清空历史（保留"刚播这首"的排除），重新洗牌
    state.radioRecent = state.lastRadioKey ? [state.lastRadioKey] : [];
    pool = pool0;
  }
  if (pool.length > 1 && state.lastRadioKey) {
    const noLast = pool.filter((r) => r.key !== state.lastRadioKey);
    if (noLast.length) pool = noLast;
  }

  const rec = pool[Math.floor(Math.random() * pool.length)];
  state.radioRecent.push(rec.key);
  const max = Math.max(1, Number(state.cfg.radioRecentMax) || 10);
  while (state.radioRecent.length > max) state.radioRecent.shift();
  state.lastRadioKey = rec.key;
  return localSongOf(rec);
}

/** 把随机曲目包成和"点歌"一样的队列条目，让 startPlaying 走完全相同的链路 */
function makeRadioItem(song) {
  return {
    qid: newQid(),
    source: 'local', // 纯本地：downloadToCache 命中就直接用文件，绝不回音源
    id: song.id,
    urlId: song.urlId || song.id,
    name: song.name,
    artist: song.artist || '',
    album: song.album || '',
    picId: '',
    localKey: song.localKey || '',
    requester: '随机电台',
    status: 'pending',
    progress: 0,
    addedAt: Date.now(),
    tries: 0,
    radio: true, // 前端据此标「随机电台」，失败处理也能认出来
  };
}

/** 现在能不能自动放下一首（对前端/诊断可见，省得猜"为什么没声音"） */
function radioAvailable() {
  if (state.cfg.autoRadio === false) return false;
  if (state.radioPaused) return false;
  if (Date.now() < state.radioHoldUntil) return false;
  return LIB.size > 0;
}

/** 随机电台状态（给 /api/state 与 /api/diag） */
function radioStatus() {
  return {
    on: state.cfg.autoRadio !== false,
    paused: state.radioPaused,
    available: radioAvailable(),
    libCount: LIB.size,
    badCount: state.radioBad.size,
    recent: state.radioRecent.slice(-Math.max(1, Number(state.cfg.radioRecentMax) || 10)),
    holdSec: state.radioHoldUntil > Date.now() ? Math.ceil((state.radioHoldUntil - Date.now()) / 1000) : 0,
    lastKey: state.lastRadioKey,
  };
}

// ---------------------------------------------------------------- 定时关闭（睡眠定时器）
//
// 需求原话：「做个定时功能，定时关闭」。
//
// 语义定成这样（比"直接关机"更贴家用场景，也不会把别人点的歌弄丢）：
//   · 到点 → 立刻停声，**队列保留**（明早还在），随机电台一起按住；
//   · 按住是"持久的"，不是管理员停止那种 5 秒静默 —— 否则 2 秒后调度器又续上了；
//   · 谁想接着听：点一首歌（自动解除）或按「继续播放」。
//
// 两种设法定时的方式都支持：
//   minutes=30      → 30 分钟后
//   at='23:30'      → 到点关（今天已过就明天）；repeat=true 就是每天都关

/** 'HH:MM' → 下一个该时刻的时间戳（今天已经过了就顺延到明天）；格式不对返回 0 */
function nextClockAt(hhmm, from = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm == null ? '' : hhmm).trim());
  if (!m) return 0;
  const hh = Number(m[1]);
  const mi = Number(m[2]);
  if (!(hh >= 0 && hh <= 23) || !(mi >= 0 && mi <= 59)) return 0;
  const now = new Date(from);
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mi, 0, 0);
  // 已经过点（含"就是这一分钟"）→ 顺延到明天。当场设"现在这个点"应该是明天，
  // 不然按下确定的一瞬间就关，谁都反应不过来。
  if (t.getTime() <= from + 1000) t.setDate(t.getDate() + 1);
  return t.getTime();
}

function sleepTimedOut() {
  const s = state.sleep;
  return !!(s.until && Date.now() >= s.until && !state.sleepFiring);
}

/** 定时关闭的对外快照（/api/state、/api/diag 共用；不含任何凭据） */
function sleepSnapshot() {
  const s = state.sleep;
  return {
    active: !!s.until,
    until: s.until || 0,
    leftSec: s.until > Date.now() ? Math.ceil((s.until - Date.now()) / 1000) : 0,
    mode: s.mode || '',
    minutes: s.minutes || 0,
    at: s.at || '',
    repeat: !!s.repeat,
    setBy: s.setBy || '',
    setAt: s.setAt || 0,
    /** 已经按定时关过了、正被按住（前端显示「继续播放」） */
    hold: !!state.sleepHold,
    firedAt: s.firedAt || 0,
    firedFrom: s.firedAtUntil || 0,
    /** 被按住时队列里还剩几首（"继续播放"能接上多少） */
    queueLeft: state.queue.filter((q) => q.status !== 'failed').length,
    maxMin: Math.max(1, Number(CONFIG.sleepMaxMin) || 720),
  };
}

/** 解除"定时关闭"的按住（有人点歌 / 手动继续） */
function clearSleepHold(reason = '') {
  if (!state.sleepHold) return false;
  state.sleepHold = false;
  state.radioPaused = false; // 电台跟着恢复，否则队列空了还是哑的
  state.stopping = false;
  state.notice = null;
  log('info', `⏵ 解除定时关闭的按住${reason ? `（${reason}）` : ''}`);
  setTimeout(() => tick(), 200);
  return true;
}

/** 设定 / 取消定时关闭。返回快照；参数不合法就抛错（路由层转成 400） */
async function setSleepTimer({ minutes, at, repeat, by, cancel } = {}) {
  const s = state.sleep;
  const now = Date.now();
  const who = String(by || '').trim().slice(0, 24);

  if (cancel) {
    const had = !!s.until;
    Object.assign(s, { until: 0, mode: '', minutes: 0, at: '', repeat: false, setBy: '', setAt: 0 });
    try {
      await saveRuntimeConfig({ sleepTimer: { mode: 'off', repeat: false } });
    } catch (e) {
      log('warn', `定时设置落盘失败：${e.message}`);
    }
    log('info', `⏱ 已取消定时关闭${had ? '' : '（本来就没设定时）'}`);
    return { cancelled: had, sleep: sleepSnapshot() };
  }

  const maxMin = Math.max(1, Number(CONFIG.sleepMaxMin) || 720);
  if (at != null && String(at).trim()) {
    const until = nextClockAt(at, now);
    if (!until) throw new Error('时间格式不对，要 24 小时制 HH:MM');
    Object.assign(s, {
      until, mode: 'clock', at: String(at).trim(), repeat: !!repeat, minutes: 0,
      setBy: who, setAt: now, firedAt: 0, firedAtUntil: 0,
    });
  } else {
    const n = Math.round(Number(minutes));
    if (!Number.isFinite(n) || n < 1) throw new Error('分钟数要填 1 以上的整数');
    if (n > maxMin) throw new Error(`最多只能设 ${maxMin} 分钟（${Math.round(maxMin / 6) / 10} 小时）`);
    Object.assign(s, {
      until: now + n * 60000, mode: 'duration', minutes: n, at: '', repeat: false,
      setBy: who, setAt: now, firedAt: 0, firedAtUntil: 0,
    });
  }

  // 重新设定 = 明确想让它响着 → 顺手解除上一次的按住
  clearSleepHold('重新设定定时');

  // 「每天 / 到点」这类设定要能扛住容器重启，落到数据卷里的运行时配置
  try {
    await saveRuntimeConfig({ sleepTimer: { mode: s.mode, at: s.at, repeat: s.repeat } });
  } catch (e) {
    log('warn', `定时设置落盘失败（本次照常生效）：${e.message}`);
  }

  const when = s.mode === 'clock'
    ? `${s.at}（${s.repeat ? '每天' : '仅一次'}）`
    : `${s.minutes} 分钟后`;
  log('info', `⏱ 已设定定时关闭：${when}${who ? `｜${who}` : ''}｜到 ${new Date(s.until).toLocaleString('zh-CN', { hour12: false })}`);
  return { sleep: sleepSnapshot() };
}

/**
 * 到点执行：停声 + 按住调度器。
 * 和「管理员停止」的区别：**不清队列**（那是别人点的歌，明早还要听）。
 */
async function fireSleepTimer() {
  const s = state.sleep;
  if (!s.until || Date.now() < s.until || state.sleepFiring) return false;
  state.sleepFiring = true;
  const due = s.until;
  const repeat = !!s.repeat && s.mode === 'clock' && !!s.at;

  // 先按住，再停声：反过来的话 tick 可能在这中间又把下一首推上去
  state.sleepHold = true;
  state.radioPaused = true;
  state.stopping = true;
  setTimeout(() => { state.stopping = false; }, 5000);
  clearTimeout(playTimer);

  const cur = state.current;
  if (cur) {
    state.history.unshift({
      name: cur.name,
      artist: cur.artist,
      requester: cur.requester,
      at: Date.now(),
      reason: '定时关闭',
    });
    state.history = state.history.slice(0, 100);
  }
  state.current = null;
  state.playing = false;
  resetPlaybackObservation();
  resetVote();

  s.firedAt = Date.now();
  s.firedAtUntil = due;
  // 每天模式：把目标挪到明天的同一时刻（否则下一个 tick 又会"到点"）
  s.until = repeat ? nextClockAt(s.at, Date.now() + 1000) : 0;

  let how = '音箱本来就没在播';
  if (ENGINE) {
    try {
      how = await ENGINE.stop();
    } catch (e) {
      how = `停声失败：${e.message}`;
    }
  }
  persist();
  state.sleepFiring = false;
  const when = s.mode === 'clock' ? `到点 ${s.at}` : `${s.minutes} 分钟到`;
  log(
    'info',
    `⏱ 定时关闭已执行（${when}）${cur ? `，掐断《${cur.name}》` : ''}｜停声=${how}` +
      `｜队列保留 ${state.queue.length} 首${repeat ? `｜下次 ${new Date(s.until).toLocaleString('zh-CN', { hour12: false })}` : ''}`
  );
  return true;
}

/** 启动时把「每天定时」接回来（运行期配置里存的；一次性定时没有意义，不恢复） */
function restoreSleepSchedule() {
  const st = CONFIG && CONFIG.sleepTimer;
  if (!st || st.mode !== 'clock' || !st.at) return false;
  const until = nextClockAt(st.at, Date.now());
  if (!until) return false;
  Object.assign(state.sleep, {
    until, mode: 'clock', at: String(st.at), repeat: !!st.repeat, minutes: 0,
    setBy: '', setAt: Date.now(), firedAt: 0, firedAtUntil: 0,
  });
  log(
    'info',
    `⏱ 已恢复${st.repeat ? '每天' : ''}定时关闭：${st.at}｜下次 ${new Date(until).toLocaleString('zh-CN', { hour12: false })}`
  );
  return true;
}

/** 从曲库删一首（只允许删曲库目录内、且在索引里的文件） */
async function deleteLocal(key) {
  const rec = LIB.get(key);
  if (!rec) return { ok: false, error: '曲库里没有这首歌' };
  const full = path.normalize(rec.file);
  const root = path.normalize(CONFIG.musicDir) + path.sep;
  if (!full.startsWith(root)) return { ok: false, error: '该文件不在曲库目录内，拒绝删除' };
  try {
    await fsp.unlink(full);
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, error: `删除失败：${e.message}` };
  }
  LIB.delete(key);
  fileIndex.delete(key);
  saveLibraryIndex();
  log('info', `已从曲库删除《${rec.name}》（${path.basename(full)}）`);
  return { ok: true, name: rec.name, freed: rec.size || 0 };
}

async function downloadToCache(song, onProgress, opts = {}) {
  const countPlay = opts.countPlay !== false; // 预热命中不算"播过一次"
  // ① 本地命中（NAS 里已经有）—— 这应该是常规路径，命中就不再打扰音源
  if (CONFIG.preferCache !== false) {
    const hit = findLocal(song);
    if (hit) {
      const st = await fsp.stat(hit.file).catch(() => null);
      if (st && st.size > 8192) {
        const dur = hit.duration || (await measureDurationSec(hit.file, st.size));
        hit.size = st.size;
        hit.duration = dur;
        if (countPlay) {
          hit.lastPlayedAt = Date.now();
          hit.plays = (hit.plays || 0) + 1;
        }
        saveLibraryIndex();
        state.runtime.cacheHits += 1;
        log('info', `本地曲库命中《${hit.name}》${dur ? `（${Math.round(dur)}s）` : ''} —— 直接用 NAS 文件，不访问音源`);
        return { file: hit.file, fromCache: true, bytes: st.size, br: CONFIG.br, duration: dur, key: hit.key };
      }
      // 文件被外部删掉了 → 索引里清掉，往下走去下载
      log('warn', `索引里有《${hit.name}》但文件已不存在，重新下载`);
      LIB.delete(hit.key);
      fileIndex.delete(hit.key);
    }
  }
  // ② 纯本地条目（从「NAS 曲库」面板点进来的）不允许回音源，找不到就如实报错
  if (song.source === 'local' || song.localKey) {
    throw new Error(`本地曲库里找不到《${song.name}》，可能已被删除或改名`);
  }

  const resolved = await resolveWithFallback(song);
  log('info', `开始下载《${song.name}》← ${resolved.source}`);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  let buf;
  let contentType = '';
  try {
    const r = await fetch(resolved.url, {
      headers: { 'User-Agent': CONFIG.userAgent },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`下载 HTTP ${r.status}`);
    contentType = r.headers.get('content-type') || '';
    buf = Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }

  const fmt = sniffAudio(buf);
  if (!fmt) {
    throw new Error(`下载内容不是音频（${contentType || '未知类型'}，${buf.length} 字节）`);
  }
  if (buf.length < 16384) {
    throw new Error(`音频文件过小（${buf.length} 字节），可能是试听片段`);
  }

  await fsp.mkdir(CONFIG.musicDir, { recursive: true });
  const dest = path.join(CONFIG.musicDir, safeFileName(song, fmt));
  const tmp = `${dest}.part`;
  if (onProgress) onProgress(0.6, buf.length);
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, dest);
  if (onProgress) onProgress(1, buf.length);

  const measured = await measureDurationSec(dest, buf.length);
  // 落库：元信息（专辑/来源/时长/大小）一并进索引，下次命中就不用碰音源了
  const rec = upsertLocal(song, dest, {
    size: buf.length,
    duration: measured,
    source: resolved.source,
    origin: 'download',
  });
  state.runtime.downloadCount += 1;
  log(
    'info',
    `下载完成《${song.name}》${(buf.length / 1048576).toFixed(2)}MB` +
      `${measured ? ` 真实时长 ${Math.round(measured)}s` : '（时长未知）'} → ${path.basename(dest)}（已入曲库，共 ${LIB.size} 首）`
  );

  return {
    file: dest,
    fromCache: false,
    bytes: buf.length,
    br: resolved.br || CONFIG.br,
    duration: measured,
    source: resolved.source,
    key: rec.key,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- 播放引擎

class SongloftEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = String(cfg.engine.base || '').replace(/\/+$/, '');
    this.prefix = cfg.engine.prefix || '/api/v1/jsplugin/miot';
    this.token = null;
    this.expireAt = 0;
    this.refreshToken = null;
    this.device = null;
    this.lastLoginErr = null;
  }

  get configured() {
    return !!(this.base && this.cfg.engine.username && this.cfg.engine.password);
  }

  async login() {
    if (!this.configured) throw new Error('songloft 未配置账号密码（config.json → engine.username / engine.password）');
    const r = await fetch(`${this.base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.cfg.engine.username, password: this.cfg.engine.password }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.access_token) {
      throw new Error(`songloft 登录失败：${body.error || body.message || 'HTTP ' + r.status}`);
    }
    this.token = body.access_token;
    this.refreshToken = body.refresh_token || null;
    this.expireAt = Date.now() + Math.max(60, (body.expires_in || 3600) - 90) * 1000;
    this.lastLoginErr = null;
    log('info', 'songloft 登录成功');
  }

  async ensureToken() {
    if (!this.token || Date.now() >= this.expireAt) await this.login();
    return this.token;
  }

  async call(method, sub, { query, body, retry = 2 } = {}) {
    for (let attempt = 0; attempt <= retry; attempt++) {
      const token = await this.ensureToken();
      let url = `${this.base}${this.prefix}${sub}`;
      if (query) {
        const qs = new URLSearchParams(
          Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
        ).toString();
        if (qs) url += `?${qs}`;
      }
      const opt = {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000),
      };
      if (body !== undefined) opt.body = JSON.stringify(body);

      const r = await fetch(url, opt);
      if (r.status === 401 && attempt < retry) {
        this.token = null;
        continue;
      }
      const text = await r.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`songloft 返回非 JSON（HTTP ${r.status}）`);
      }
      if (!r.ok) throw new Error(`songloft HTTP ${r.status}：${data?.error || data?.message || text.slice(0, 120)}`);
      // 插件统一包 {success, data}
      if (data && typeof data === 'object' && 'success' in data) {
        if (data.success === false) throw new Error(data.error || '插件返回失败');
        return data.data;
      }
      return data;
    }
    throw new Error('songloft 请求失败');
  }

  get(pathname, query) {
    return this.call('GET', pathname, { query });
  }

  post(pathname, body) {
    return this.call('POST', pathname, { body });
  }

  async devices() {
    const groups = (await this.get('/mina/devices')) || [];
    const flat = [];
    for (const g of groups) {
      for (const d of g.devices || []) {
        flat.push({ ...d, account_id: g.account_id, account_name: g.account_name });
      }
    }
    return flat;
  }

  async pickDevice() {
    const want = this.cfg.engine.deviceId;
    const list = await this.devices();
    let dev = null;
    if (want) dev = list.find((d) => deviceIdOf(d) === want);
    if (want && !dev) {
      log('warn', `配置的 deviceId=${want} 不在设备列表里，已自动降级挑选`);
      log('warn', '当前可用设备：' + list.map((d) => `${d.name || '?'}[${deviceIdOf(d)}]`).join('  /  '));
    }
    if (!want) log('info', '未配置 deviceId，自动挑选目标音箱（优先 L17A + 已启用 + 在线）');
    if (!dev) dev = list.find((d) => d.managed && d.presence === 'online' && /L17A/i.test(d.hardware || ''));
    if (!dev) dev = list.find((d) => d.managed && d.presence === 'online');
    if (!dev) dev = list.find((d) => d.managed);
    if (!dev) throw new Error('未找到可用音箱（需在 songloft 插件中启用设备管理）');
    this.device = {
      accountId: String(dev.account_id || this.cfg.engine.accountId || ''),
      deviceId: deviceIdOf(dev),
      name: dev.name || dev.alias || '未知设备',
      hardware: dev.hardware || '',
    };
    log('info', `✅ 目标音箱：${this.device.name}（${this.device.deviceId}）机型 ${this.device.hardware || '-'}`);
    return this.device;
  }

  async ensureDevice() {
    // 注意：这里曾经写成"配了 deviceId 就每次重新 pick"，
    // 结果 status() 每 2 秒都会连带打一次 /mina/devices（米家云接口），
    // 既浪费又可能触发云端节流 → 改为缓存，命中就用缓存。
    if (this.device && (!this.cfg.engine.deviceId || this.device.deviceId === this.cfg.engine.deviceId)) {
      return this.device;
    }
    return this.pickDevice();
  }

  async playUrl(url) {
    const dev = await this.ensureDevice();
    return this.post('/mina/play-url', {
      account_id: dev.accountId,
      device_id: dev.deviceId,
      url,
    });
  }

  async status() {
    const dev = await this.ensureDevice();
    return this.get('/player/status', { account_id: dev.accountId, device_id: dev.deviceId });
  }

  async setVolume(volume) {
    const dev = await this.ensureDevice();
    return this.post('/mina/volume', {
      account_id: dev.accountId,
      device_id: dev.deviceId,
      volume: Math.max(0, Math.min(100, Math.round(volume))),
    });
  }

  /**
   * 让音箱立刻停下来。
   * 插件并不保证同时提供 stop / pause，所以按「最可能有效 → 兜底」逐级试：
   *   ① POST /mina/stop
   *   ② POST /mina/pause
   *   ③ 推 1 秒静音（播完自然静音结束，等价于停）
   * 返回真正生效的方式，会写进日志——以后就能确定这版插件到底吃哪个端点。
   */
  async stop() {
    const dev = await this.ensureDevice();
    const body = { account_id: dev.accountId, device_id: dev.deviceId };
    const errs = [];
    for (const sub of ['/mina/stop', '/mina/pause']) {
      try {
        await this.post(sub, body);
        return `${sub}`;
      } catch (e) {
        errs.push(`${sub}→${e.message}`);
      }
    }
    try {
      await this.post('/mina/play-url', { ...body, url: `${publicBase()}/audio/${SILENCE_NAME}` });
      return '静音兜底';
    } catch (e) {
      errs.push(`静音兜底→${e.message}`);
    }
    throw new Error(errs.join('；'));
  }
}

class XiaomusicEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = String(cfg.engine.base || '').replace(/\/+$/, '');
    this.device = null;
  }

  get configured() {
    return !!this.base;
  }

  async devices() {
    const r = await fetch(`${this.base}/device_list`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`xiaomusic HTTP ${r.status}`);
    const d = await r.json().catch(() => ({}));
    const list = Array.isArray(d) ? d : d.data || d.devices || [];
    return list.map((x) => ({
      device_id: x.device_id || x.deviceID || x.miotDID || '',
      name: x.name || x.device_name || '',
      hardware: x.hardware || x.model || '',
      managed: true,
      presence: 'online',
    }));
  }

  async ensureDevice() {
    if (this.device && !this.cfg.engine.deviceId) return this.device;
    const list = await this.devices();
    if (!list.length) throw new Error('xiaomusic 未配置任何设备（需在其配置中绑定米家账号）');
    let dev = this.cfg.engine.deviceId ? list.find((d) => d.device_id === this.cfg.engine.deviceId) : null;
    if (!dev) dev = list.find((d) => /L17A/i.test(d.hardware)) || list[0];
    this.device = dev;
    return dev;
  }

  async playUrl(url) {
    const dev = await this.ensureDevice();
    const qs = new URLSearchParams({ url, device_id: dev.device_id }).toString();
    const r = await fetch(`${this.base}/playurl?${qs}`, { method: 'POST', signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`xiaomusic playurl HTTP ${r.status}`);
    return r.json().catch(() => ({ ok: true }));
  }

  async status() {
    const dev = await this.ensureDevice();
    const qs = new URLSearchParams({ device_id: dev.device_id }).toString();
    const r = await fetch(`${this.base}/getplayerstatus?${qs}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`xiaomusic status HTTP ${r.status}`);
    return r.json().catch(() => ({}));
  }

  async setVolume(volume) {
    const dev = await this.ensureDevice();
    const qs = new URLSearchParams({ volume: String(Math.round(volume)), device_id: dev.device_id }).toString();
    const r = await fetch(`${this.base}/setvolume?${qs}`, { method: 'POST', signal: AbortSignal.timeout(15000) });
    return r.json().catch(() => ({ ok: true }));
  }

  /** xiaomusic 的 /stop 是 GET（它自己的一键停止） */
  async stop() {
    const dev = await this.ensureDevice();
    const qs = new URLSearchParams({ device_id: dev.device_id }).toString();
    const r = await fetch(`${this.base}/stop?${qs}`, { method: 'GET', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`xiaomusic stop HTTP ${r.status}`);
    return '/stop';
  }
}

function deviceIdOf(d) {
  return String(d.device_id || d.deviceID || d.id || '');
}

/** 播放状态容错解析：不同引擎字段不一，全部试一遍 */
function parseStatus(raw) {
  const p = (raw && (raw.data || raw)) || {};
  // 注意真机实测：songloft 插件会同时给出 `state:"playing"` 和 `is_playing:false`，
  // 布尔值不可信 —— 所以先找"明确表示在播"的信号（字符串状态 / true），
  // 都没有时才按"停"处理。（曾经优先读布尔，导致 playing 永远是 false）
  const bool = (...vals) => {
    let neg = null;
    for (const v of vals) {
      if (v === true) return true;
      if (typeof v === 'string') {
        const s = v.toLowerCase();
        if (s === 'playing' || s === 'play' || s === 'running' || s === 'buffering') return true;
        if (s === 'paused' || s === 'stopped' || s === 'stop' || s === 'idle' || s === 'none' || s === 'closed') neg = false;
      } else if (v === false) {
        neg = false;
      }
    }
    return neg;
  };
  const num = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };
  return {
    playing: bool(p.state, p.is_playing, p.playing, p.status, p.player_state),
    position: num(p.position, p.progress, p.current_time, p.cur_pos, p.currentTime),
    duration: num(p.duration, p.total, p.total_time, p.durationMs && p.durationMs / 1000),
    volume: num(p.volume, p.vol),
    playMode: p.play_mode || p.playMode || '',
    raw: p,
  };
}

/** 平滑器的初始状态（每换一首曲子重置一次） */
function makeDisplayStatus() {
  return {
    key: '',          // 曲子标识（qid）；换了就必须重来
    playing: false,
    position: 0,      // 发布给前端的进度（秒）
    duration: 0,
    volume: 0,
    at: 0,
    blip: 0,          // 连续"全零读数"的计数
    total: 0,         // 见过的最大 duration
    live: false,      // 是否已经采信过真实进度（前端据此决定显不显示 --:--）
    back: 0,          // 连续"疑似换了新基准"（大幅回退）的计数
    backPos: 0,       // 上一次那个更低的读数（用来判断新基准是不是在往上走）
  };
}

/**
 * 清空"当前曲目"的播放观测与进度平滑状态。
 * 起播 / 停止 / 队列播空 三处都必须调：上一首的进度、残留值、判定观测绝不能带到下一首。
 */
function resetPlaybackObservation() {
  state.obs = null;
  state.disp = makeDisplayStatus();
  state.lastStatus = null;
  state.lastRaw = null;
}

/**
 * 把接口的**原始状态**平滑成**可以给用户看的进度**。
 * ------------------------------------------------------------------
 * 为什么需要它（2026-10-16 / 10-17 两次真机问题，都是这台设备的假数据造成的）：
 *
 *   ① idle 闪烁：播放中大约每 7 秒闪一次 `{state:"idle", position:0, duration:0}`。
 *      照单全收 → 进度条掉到 0、时间显示 `--:--`，下一次轮询又弹回 → **来回跳**。
 *   ② 残留值：刚推流时 `position` 是**上一首的**（实测 92.37）。
 *   ③ ⚠️ 最阴的一种：那个残留值**还会继续往前走一两秒**
 *      （实测 190 → 202，是上一首的流还没断干净），然后才切成新流的真实进度（12 → 18 …）。
 *      它"在动"，所以 `sawProgress` 骗得过；又比真值大，所以「只增不减」会把它当基准粘死
 *      → 界面上的时间**卡住不动**（用户 10-17 报的"时间不动了"，实测卡在 211.7 而真值是 78.5）。
 *
 * 四条规则（全部只影响**展示**，不参与"是否播完"的判定 —— 那个用 decideEnd 的原始数据）：
 *   ① **挂钟校准**：进度不可能超过"这首歌已经播了多久"。80 秒前才开始播，就不可能已经播到 3:32。
 *      —— 这是唯一能治住 ③ 的办法（它比 sawProgress 可靠：假值动得再欢也超不过挂钟）。
 *   ② 没亲眼见过进度向前推进（`obs.sawProgress` 为假）之前，任何绝对值都不可信 → 发布 0；
 *   ③ 整份读数全零（pos≈0 且 dur≈0）时，连续次数没到 `blipHold` 就沿用上一次的进度；
 *   ④ 同一首曲子内进度只增不减，但**必须能自愈**：大幅回退时若看到新基准自己在往上走，
 *      连续两次就认它 —— 保证任何情况下最多卡 2 个轮询，绝不会永久冻结。
 *
 * @param {object} st    parseStatus() 的结果
 * @param {object} ctx   { key, disp, obs, blipHold, leadSec, elapsedMs }
 *   elapsedMs = 本曲推流至今的毫秒数；**传 null 表示未知**（会跳过规则 ①）
 * @returns {{next:object, held:boolean}}  next = 新的平滑状态，held = 本次是否沿用了旧值
 */
function smoothDisplayStatus(st, ctx) {
  const key = String((ctx && ctx.key) || '');
  const prev = (ctx && ctx.disp) || makeDisplayStatus();
  const obs = (ctx && ctx.obs) || {};
  const blipHold = Math.max(1, Number((ctx && ctx.blipHold) || 3));
  const leadRaw = ctx ? ctx.leadSec : undefined;
  const leadSec = leadRaw === undefined || leadRaw === null || !Number.isFinite(Number(leadRaw))
    ? 8
    : Math.max(0, Number(leadRaw));
  const pos = Math.max(0, Number(st && st.position) || 0);
  const dur = Math.max(0, Number(st && st.duration) || 0);
  const vol = Math.max(0, Number(st && st.volume) || 0);
  const playing = !!(st && st.playing);
  const now = Date.now();

  // 七处 return 只分两类，公共字段在这里收口，改动规则时不必逐处同步。
  // hold   = 沿用上一次的值（这次读数不可信）
  // accept = 采纳这次的读数（pos = 要发布的进度）
  const hold = (extra) => ({
    held: true,
    next: { ...prev, playing, volume: vol || prev.volume, at: now, ...extra },
  });
  const accept = (position, extra) => ({
    held: false,
    next: {
      key,
      playing,
      position,
      duration: dur || prev.duration,
      volume: vol || prev.volume,
      at: now,
      blip: 0,
      total: Math.max(prev.total, dur),
      live: position > 0,
      back: 0,
      backPos: 0,
      ...extra,
    },
  });

  // 换了曲子 → 上一首的进度一律不继承
  if (prev.key !== key) return accept(0, { duration: dur, volume: vol, total: 0 });

  // 规则 ①：挂钟校准 —— 进度不可能超过"这首歌已经播了多久"
  // （elapsedMs 为 null = 不知道推流时刻，跳过这条，宁可不拦也不要误拦）
  const elRaw = ctx ? ctx.elapsedMs : null;
  const elapsedSec =
    elRaw === null || elRaw === undefined || !Number.isFinite(Number(elRaw)) ? null : Math.max(0, Number(elRaw) / 1000);
  if (elapsedSec !== null && pos > elapsedSec + leadSec) return hold({ blip: 0 });

  // 规则 ②：还没见过进度推进 → 值不可信（预热期），统一从 0 起步
  if (!obs.sawProgress) return hold({ position: 0, duration: dur || prev.duration, blip: 0 });

  // 规则 ③：全零读数 = 疑似 idle 闪烁
  if (pos <= 0.5 && dur <= 0.5) {
    const blip = prev.blip + 1;
    if (blip < blipHold) return hold({ blip, live: true });
    // 连着好几次都是零 → 这次是真停了，放行
    return accept(0, { duration: 0, blip, live: false });
  }

  // 规则 ④：进度只增不减 —— 但必须能自愈，不能永久粘在一个错的值上
  const BACK_TOL = 3; // 小幅回退（≤3 秒）当抖动处理
  if (pos < prev.position - BACK_TOL) {
    // 这一次比上一次那个"更低的值"还高 → 新基准自己在往上走 → 认它
    const advancing = prev.back > 0 && pos > prev.backPos + 0.05;
    const back = advancing ? prev.back + 1 : 1;
    if (back >= 2) return accept(pos);
    return hold({ blip: 0, back, backPos: pos });
  }

  // 正常前进（小幅回退按"没动"处理）
  return accept(Math.max(pos, prev.position));
}

// ---------------------------------------------------------------- 队列与调度

/**
 * 判定"当前曲目是否该切下一首"。
 * ------------------------------------------------------------
 * 2026-10-16 真机实测（小米 Sound Pro + songloft 插件）拿到的原始状态：
 *
 *   { state:"paused", is_playing:false, position:92.37, duration:319.112, ... }   ← 刚推流时
 *   { state:"paused", is_playing:false, position:92.37,  duration:319.112 }       ← 3 次都不动
 *   { state:"idle",   is_playing:false, position:0,      duration:0       }       ← 播放中也会偶发闪一下
 *   { state:"paused", is_playing:false, position:5.868,  duration:319.112 }       ← 才真正开始播
 *
 * 结论：这台设备的 `is_playing` **恒定 false**（插件播放器与 MiNA 推流解耦），
 * 且刚推流时 `position` 是**上一首的残留值**。
 * 旧逻辑 `is_playing===false && position>0` 在第一次轮询就成立 → 刚点歌就切歌。
 *
 * 所以现在的判定只认**正向证据**：
 *   ① 必须亲眼看到 position **向前推进**过（sawProgress），否则说明数据是残留/冻结的，一律不采信；
 *   ② 任何自动切歌都要等过 minPlayMs（新推的曲子不可能几秒就播完）；
 *   ③ 只有"进度走到尾部（接口时长或实测时长）"或"确实卡住/流已停止"才算结束。
 * 拿不到证据就不切，交给 expectedEnd（按真实时长算的超时兜底）。
 *
 * @returns {{ended:boolean, reason:string, obs:object}}
 */
function decideEnd(st, ctx) {
  const prev = ctx.obs || {};
  const obs = {
    lastPos: prev.lastPos === undefined ? null : prev.lastPos,
    sawProgress: !!prev.sawProgress,
    frozenCount: prev.frozenCount || 0,
    idleCount: prev.idleCount || 0,
    progPos: prev.progPos || 0, // 亲眼看到的最高进度
    polls: prev.polls || 0,
  };
  const pos = Number(st.position) || 0;
  const dur = Number(st.duration) || 0;
  const elapsed = ctx.elapsedMs;
  const measured = Number(ctx.measuredSec) || 0;

  // ---- 用"进度增量"判断这份状态是不是活的 ----
  const delta = obs.lastPos === null ? 0 : pos - obs.lastPos;
  if (delta > 0.05) {
    // 向前推进 → 真在播
    obs.sawProgress = true;
    obs.frozenCount = 0;
    obs.idleCount = 0;
    obs.progPos = Math.max(obs.progPos, pos);
  } else if (delta < -0.05) {
    // 大幅回退（换曲/流重置/残留值被清零）→ 重置基准，不算"停住"
    obs.frozenCount = 0;
    obs.idleCount = pos <= 0.5 && dur === 0 ? obs.idleCount + 1 : 0;
  } else {
    // 原地不动
    if (pos > 0.5) obs.frozenCount += 1;
    obs.idleCount = pos <= 0.5 && dur === 0 ? obs.idleCount + 1 : 0;
  }
  obs.lastPos = pos;
  obs.polls += 1;

  // 接口报的时长可信吗？（不小于 20s，且不少于实测时长的一半）
  const durTrust = dur >= 20 && (!measured || dur >= measured * 0.5);
  const posTrust = measured > 0 ? pos <= measured + 60 : true; // 进度远超实测时长 → 数据不可信
  const total = measured || (durTrust ? dur : 0);

  const reasons = [];
  const ready = elapsed >= ctx.minPlayMs && obs.sawProgress && posTrust;
  if (ready) {
    if (durTrust && pos >= dur - 2) reasons.push('进度到接口时长的尾部');
    if (measured > 0 && pos >= measured - 2) reasons.push('进度到实测时长的尾部');
    // 卡住不动：接口说"在播"却不动 → 8 秒就切；接口说"暂停" → 宽容到 40 秒再切（避免误伤手动暂停）
    const frozenLimit = st.playing === true ? 4 : 20;
    if (obs.frozenCount >= frozenLimit && pos > 5) reasons.push(`连续 ${obs.frozenCount} 次进度不动`);
    if (obs.idleCount >= 3 && total > 0 && obs.progPos >= total * 0.5) reasons.push('流已停止（连续 idle）');
  }
  return { ended: reasons.length > 0, reason: reasons.join(' + '), obs, pos, dur, measured, elapsedMs: elapsed };
}

const state = {
  cfg: null,
  queue: [],        // 待播
  current: null,    // 正在播的条目
  playing: false,
  history: [],      // 已播（最多保留 100）
  devices: [],
  deviceInfo: null,
  engineOk: false,
  engineErr: '',
  lastStatus: null,   // 发布给前端的进度（已平滑，不跳）
  lastRaw: null,      // 接口原始读数（诊断用，不发布）
  disp: makeDisplayStatus(), // 平滑器状态
  startedAt: 0,     // 当前曲目推流时刻
  expectedEnd: 0,   // 预估结束时刻（兜底）
  tickBusy: false,
  probeBusy: false, // 诊断推流进行中（此时调度让路）
  stopping: false,  // 「停止」后的短暂静默期：不许调度器立刻又推流
  lastStop: null,   // 最近一次停止 { by, at, cleared }（全场都能停，页面据此显示"谁停的"）
  obs: null,        // 当前曲目的"播放状态观测"（每次推流重置）
  lastVerdict: null, // 最近一次"是否播完"的判定结果（诊断用）
  statusLog: [],    // 原始状态采样环形缓冲（诊断用，最多 60 条）
  notice: null,     // 给用户看的一条提示（限流/重试/失败），成功推流后清空
  nextRetryAt: 0,   // 队首歌的下次重试时刻（0 = 立即可试）
  // ---- 随机电台（队列空时自动放 NAS 曲库） ----
  radioRecent: [],      // 最近随机播过的 key（轮转，避免刚播完又播同一首）
  radioBad: new Set(),  // 起播失败过的 key（坏文件/已删除），本次运行不再挑它
  radioPaused: false,   // 管理员「停止」后的临时按住；有人点歌自动解除
  lastRadioKey: '',     // 上一首随机曲（连播两首不重样）
  radioFailStreak: 0,   // 连续失败次数（用于退避，别把调度器刷爆）
  radioHoldUntil: 0,    // 退避截止时刻
  // ---- 定时关闭（到点停声 + 按住调度器） ----
  /**
   * until = 目标时刻（ms）。0 表示没设定时。
   * mode: 'duration'（N 分钟后）| 'clock'（到 HH:MM）
   */
  sleep: { until: 0, mode: '', minutes: 0, at: '', repeat: false, setBy: '', setAt: 0, firedAt: 0, firedAtUntil: 0 },
  /** 定时关闭已经执行过 → 调度器不许再自动续播（有人点歌 / 点「继续播放」才解除） */
  sleepHold: false,
  /** 正在执行停声（防重入：tick 每 2 秒都会看到"到点了"） */
  sleepFiring: false,
  runtime: {
    searchCount: 0,
    downloadCount: 0,
    cacheHits: 0,
    playCount: 0,
    failCount: 0,
    lastError: '',
  },

  // ---------------- 聊天室 ----------------
  /** 聊天记录：{seq, msgs:[{id,at,kind,clientId,nick,text}]}，kind = msg | sys */
  chat: { seq: 0, msgs: [] },
  /** clientId → { nick, lastSeen, joinedAt }（在线判定靠 lastSeen 心跳，不靠连接） */
  clients: new Map(),
  /**
   * nick → { clientId, lastSeen }（昵称唯一性：一个昵称只能被一个人占着）
   * lastSeen = 原主人最后一次出现的时刻，用来判断占用是否已过期。
   * 读取一律走 nickHolder()，别直接 .get() —— 那里会处理 TTL。
   */
  nickOwner: new Map(),
  /** 最近一次发言时间：clientId → ms（用于限流防刷屏） */
  lastChatAt: new Map(),
  /** 切歌投票：只针对"当前这一首"，歌一换就作废 */
  vote: { qid: '', voters: new Set(), startedAt: 0 },
};

let ENGINE = null;

function queueSnapshot() {
  return {
    version: VERSION,
    engine: state.cfg.engine.type,
    engineOk: state.engineOk,
    engineErr: state.engineErr,
    device: state.deviceInfo,
    devices: state.devices,
    current: state.current
      ? {
          qid: state.current.qid,
          name: state.current.name,
          artist: state.current.artist,
          status: state.current.status,
          progress: state.current.progress || 0,
          requester: state.current.requester,
          source: state.current.source,
          fromCache: !!state.current.fromCache,
          startedAt: state.current.startedAt || 0,
          duration: state.current.duration || 0, // 从文件里量出来的真实时长（秒）
          /** 是随机电台自动挑的（没人点歌时兜底） */
          radio: !!state.current.radio,
        }
      : null,
    playing: state.playing,
    status: state.lastStatus,
    queue: state.queue.map((q) => ({
      qid: q.qid,
      name: q.name,
      artist: q.artist,
      status: q.status,
      progress: q.progress || 0,
      requester: q.requester,
      tries: q.tries || 0,
      /** 这首歌 NAS 曲库里已经有了 → 冷却期也能秒播（前端标「已缓存」） */
      cached: !!findLocal(q),
      lastError: q.status === 'pending' && q.tries ? q.lastError || '' : '',
      /** 👍 往前挪：已赞人数 + 谁赞的（前端判断"我赞过没有"，和投票切歌一样只给小范围 clientId） */
      tops: { votes: Array.isArray(q.tops) ? q.tops.length : 0, voters: Array.isArray(q.tops) ? q.tops.slice() : [] },
    })),
    /** 「👍 往前挪」需要几个赞（前端显示 x/N） */
    queueTopNeed: Math.max(1, Number(state.cfg.queueTopNeed) || 3),
    history: state.history.slice(0, 20),
    stats: state.runtime,
    /** NAS 曲库概况（前端顶部展示 / 面板统计） */
    library: libraryStats(),
    /**
     * 随机电台：队列空了自动放 NAS 曲库里的歌。
     * `available` 才是"现在真的会接上吗"——关掉、被停止按住、曲库空、退避中都会是 false。
     */
    radio: radioStatus(),
    /**
     * 定时关闭：active = 还真在倒计时；hold = 已经关过、正被按住（等人点歌或点「继续播放」）。
     * leftSec 由服务端算，前端只做本地递减，避免时钟不一致。
     */
    sleep: sleepSnapshot(),
    /** 最近一次「停止」是谁按的（所有人都能按；by 为空表示没认出昵称） */
    stop: state.lastStop ? { by: state.lastStop.by, at: state.lastStop.at, cleared: state.lastStop.cleared } : null,
    /** 缓存优先开关（默认开） */
    preferCache: state.cfg.preferCache !== false,
    /** 管理员口令是否已设置（前端据此决定"引导设置"还是"输入口令"）。
     *  只给布尔值与来源，绝不下发口令本身。 */
    adminConfigured: adminConfigured(),
    adminSource: adminSource(),
    publicBase: publicBase(),
    volume: state.cfg.volume,
    // 给用户看的提示（限流 / 正在重试 / 最终失败）
    notice: state.notice,
    /** 音源冷却剩余秒数（>0 表示正在等音源解封） */
    cooldownLeftSec: cooldownLeftSec(),
    /** 队列里那首歌还要等几秒才会自动重试 */
    retryInSec: state.nextRetryAt > Date.now() ? Math.ceil((state.nextRetryAt - Date.now()) / 1000) : 0,
    /** 单曲最多尝试次数（前端用来显示"第 N/M 次"） */
    maxTries: Number(state.cfg.maxTries) || 5,

    // ---------------- 聊天室 / 投票（消息内容走 /api/live，这里只给"场况"） ----------------
    /** 聊天室里现在有多少人（在线 + 已设昵称） */
    online: onlineCount(),
    /** 切歌需要几票（超过在线人数一半） */
    voteNeed: voteNeed(),
    /** 切歌投票当前状态 */
    vote: voteSnapshot(),
    /** 聊天消息序号（前端据此判断要不要拉增量） */
    chatSeq: state.chat.seq,
    /** 投票切歌开关（关掉就等于"点了就切"） */
    voteEnabled: state.cfg.skipVoteEnabled !== false,
    /** 昵称占用有效期（秒，0 = 永不过期）；超过这个期限没出现就自动释放给别人用 */
    nickTtlSec: nickTtlSecCfg(),
    /** 当前被占的昵称数（不含已过期的） */
    nickCount: activeNickCount(),
    /**
     * 进度条防抖阈值：状态接口的全零读数连续出现几次才认账。
     * 真机那台会每 7 秒闪一次 idle（position/duration 全 0），照单全收进度条就来回跳。
     */
    statusBlipHold: Math.max(1, Number(state.cfg.statusBlipHold) || 3),
    /**
     * 进度"超前"容差（秒）：进度超出"本曲已播时长 + 这个值"就判定为上一首的残留，不予发布。
     */
    statusLeadSec: Math.max(0, Number(state.cfg.statusLeadSec) || 8),
    /**
     * 当前生效的音源（取链降级顺序 + 搜索并行源）。
     * 部署后可以直接看这里确认配置是否真的换过来了 —— 接口不支持的死源留在列表里
     * 只会白烧配额，所以这两项值得摆到明面上。
     */
    sources: effectiveSources('sources'),
    searchSources: effectiveSources('searchSources'),
    /** 已判定不可用、正在熔断跳过的源（1 小时后自动重试） */
    deadSources: [...deadSources.keys()],
    /** QQ 自建音源状态（是否已配、音质、最近一次失败原因；绝不含凭据） */
    qq: qqStatus(),

    // 首次配置引导（只暴露"是否已配"，绝不回传密码）
    needSetup: !(state.cfg.engine.username && state.cfg.engine.password),
    engineBase: state.cfg.engine.base || '',
    engineUser: state.cfg.engine.username || '',
    engineDeviceId: state.cfg.engine.deviceId || '',
    hasPassword: !!state.cfg.engine.password,
  };
}

function publicBase() {
  if (state.cfg.publicBase) return String(state.cfg.publicBase).replace(/\/+$/, '');
  const ip = pickLanIp();
  return `http://${ip}:${state.cfg.port}`;
}

function pickLanIp() {
  const ifaces = os.networkInterfaces();
  const cands = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      cands.push(i.address);
    }
  }
  // 优先 192.168.x / 10.x，其次 172.16-31
  const rank = (a) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : 2);
  cands.sort((a, b) => rank(a) - rank(b));
  return cands[0] || '127.0.0.1';
}

function persist() {
  const file = path.join(state.cfg.dataDir, 'queue.json');
  const data = {
    queue: state.queue,
    current: state.current,
    history: state.history.slice(0, 100),
    savedAt: Date.now(),
  };
  fsp.mkdir(state.cfg.dataDir, { recursive: true })
    .then(() => fsp.writeFile(file, JSON.stringify(data, null, 1)))
    .catch((e) => log('warn', `队列持久化失败：${e.message}`));
}

async function restore() {
  const file = path.join(state.cfg.dataDir, 'queue.json');
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const d = JSON.parse(raw);
    state.queue = Array.isArray(d.queue) ? d.queue : [];
    state.history = Array.isArray(d.history) ? d.history : [];
    // 重进队列的条目一律重置为待播
    for (const q of state.queue) {
      q.status = 'pending';
      q.progress = 0;
    }
    log('info', `恢复队列：${state.queue.length} 首待播`);
  } catch {
    /* 首次运行无文件 */
  }
}

let qidSeq = 0;
function newQid() {
  qidSeq += 1;
  return `q${Date.now().toString(36)}${qidSeq}`;
}

function enqueue(song, requester) {
  const item = {
    qid: newQid(),
    source: song.source,
    id: song.id,
    urlId: song.urlId || song.id,
    name: song.name,
    artist: song.artist,
    album: song.album || '',
    picId: song.picId || '',
    // 从「NAS 曲库」面板点进来的会带 key；带着它就不怕歌手/歌名对不上
    localKey: song.localKey || '',
    requester: requester || '匿名',
    status: 'pending',
    progress: 0,
    addedAt: Date.now(),
    tries: 0,
    /** 「👍 往前挪」的点赞人 clientId（凑够 queueTopNeed 个才挪一位，挪完清零） */
    tops: [],
  };
  state.queue.push(item);
  persist();
  log(
    'info',
    `点歌《${item.name}》by ${item.requester}（队列 ${state.queue.length}）${findLocal(item) ? '｜NAS 曲库已有，秒播' : ''}`
  );
  return item;
}

function removeFromQueue(qid) {
  const i = state.queue.findIndex((q) => q.qid === qid);
  if (i < 0) return false;
  state.queue.splice(i, 1);
  persist();
  return true;
}

/**
 * 队列「👍 往前挪一位」——不再是"点一下就飞到最前"，而是**凑够 queueTopNeed 个人点赞**才往前挪**一步**。
 *
 * 为什么改：一键置顶等于任何一个人都能把自己的歌顶到最前，队头会被反复插队；
 * 点赞制下一个人点不动，得真的有 3 个人想听它。
 *
 * 规则：
 *   · 一人一票，同一个人再点 = 撤票（返回 voted:false）；
 *   · 凑够票 → 和**前一位**换位置（只前进一步），然后把这首歌的票清零重新攒；
 *   · 已经在第 1 位的，票照记但不挪（`first:true`），也不清零。
 * 只影响"待播放"队列，不碰正在播的那首。
 */
function toggleQueueTop(qid, clientId) {
  const i = state.queue.findIndex((q) => q.qid === qid);
  if (i < 0) return { ok: false, status: 404, error: '队列里没有这首歌（可能已经播了/被清空了）' };
  const need = Math.max(1, Number(CONFIG.queueTopNeed) || 3);
  const item = state.queue[i];
  const tops = Array.isArray(item.tops) ? item.tops : (item.tops = []);

  const at = tops.indexOf(clientId);
  if (at >= 0) {
    tops.splice(at, 1);
    persist();
    return { ok: true, voted: false, votes: tops.length, need, moved: false, index: i, qid };
  }

  tops.push(clientId);
  let moved = false;
  let first = i === 0;
  if (tops.length >= need && !first) {
    state.queue.splice(i, 1);
    state.queue.splice(i - 1, 0, item); // 只前进一位
    item.tops = []; // 这次表决完成，重新攒
    moved = true;
    log('info', `👍《${item.name}》凑够 ${need} 个赞，往前挪到第 ${i} 位`);
  }
  persist();
  return {
    ok: true,
    voted: true,
    votes: moved ? 0 : tops.length,
    need,
    moved,
    first: first && tops.length >= need,
    index: moved ? i - 1 : i,
    qid,
  };
}

function clearQueue() {
  state.queue = [];
  state.notice = null;
  state.nextRetryAt = 0;
  persist();
}

async function skip(reason = '手动跳过') {
  if (state.current) {
    log('info', `切歌（${reason}）：${state.current.name}`);
    state.history.unshift({
      name: state.current.name,
      artist: state.current.artist,
      requester: state.current.requester,
      at: Date.now(),
      reason,
    });
    state.history = state.history.slice(0, 100);
    state.current = null;
  }
  state.playing = false;
  clearTimeout(playTimer);
  resetVote(); // 歌都换了，针对上一首的切歌票自然作废
  persist();
  // 立即触发下一次调度
  setTimeout(() => tick(), 300);
}

/**
 * 「停止」——和「切歌」是两回事：
 *   切歌 = 跳过这首，接着播下一首；
 *   停止 = 真的别放了：立刻停声 + 清空队列（否则调度器 2 秒后就又续上了）。
 *
 * 2026-10-21 起任何人都能按（`POST /api/stop`，不需要口令）；
 * 管理员那条 `/api/admin/stop` 仍然保留，语义完全一致，只是带口令、写给脚本/老前端用。
 */
async function stopPlayback(reason = '有人按了停止', opts = {}) {
  const cur = state.current;
  const by = String(opts.by || '').slice(0, 24);
  if (cur) {
    state.history.unshift({
      name: cur.name,
      artist: cur.artist,
      requester: cur.requester,
      at: Date.now(),
      reason,
    });
    state.history = state.history.slice(0, 100);
  }
  const cleared = state.queue.length;
  clearTimeout(playTimer);
  state.current = null;
  state.playing = false;
  resetPlaybackObservation();
  clearQueue(); // 队列清空 → tick() 不会再把下一首推上去
  state.stopping = true;
  state.lastStop = { by, at: Date.now(), cleared };
  // 随机电台必须一起按住，否则 5 秒静默期一过它又自己接上了 ——「停止」就变成了「换一首」
  state.radioPaused = true;
  setTimeout(() => { state.stopping = false; }, 5000);

  let how = '音箱本来就没在播';
  if (ENGINE) {
    try {
      how = await ENGINE.stop();
    } catch (e) {
      how = `停声失败：${e.message}`;
    }
  }
  persist();
  log('info', `⏹ 停止播放（${reason}）：清掉队列 ${cleared} 首${cur ? `，掐断《${cur.name}》` : ''}，停声方式=${how}`);
  return { how, cleared, stopped: cur ? cur.name : '' };
}

// ---------------------------------------------------------------- 聊天室 / 在线人数
//
// 设计要点：
//   · 在线判定不看 TCP 连接，只看"心跳"（前端每 2 秒 POST /api/live 带 clientId）——
//     手机息屏、切后台、断网都会自然掉线，不需要额外处理。
//   · 昵称**全局唯一**：nick → clientId 一一对应，被别人占了就换一个。
//     同一个人改昵称会释放旧昵称。
//   · "聊天室里的人" = 在线 **且** 已设昵称的人。投票切歌的分母就是它。

const chatFile = () => path.join(CONFIG.dataDir, 'chat.json');
const nicksFile = () => path.join(CONFIG.dataDir, 'nicks.json');

function chatLimit() {
  return Math.max(20, Number(CONFIG.chatMaxMessages) || 200);
}
function onlineWindow() {
  return Math.max(5000, Number(CONFIG.onlineWindowMs) || 20000);
}

let chatSaveTimer = null;
function saveChatSoon() {
  clearTimeout(chatSaveTimer);
  chatSaveTimer = setTimeout(flushChat, 400);
}
function flushChat() {
  clearTimeout(chatSaveTimer);
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    fs.writeFileSync(
      chatFile(),
      JSON.stringify({ version: 1, seq: state.chat.seq, msgs: state.chat.msgs.slice(-chatLimit()) }, null, 0),
      'utf8'
    );
  } catch (e) {
    log('warn', `聊天记录写入失败：${e.message}`);
  }
}

let nickSaveTimer = null;
function saveNicksSoon() {
  clearTimeout(nickSaveTimer);
  nickSaveTimer = setTimeout(flushNicks, 400);
}
function flushNicks() {
  clearTimeout(nickSaveTimer);
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    // 落盘时顺手剔掉已过期的，别让文件无限长大
    const ttl = nickTtlMs();
    const now = Date.now();
    const nicks = {};
    for (const [nick, it] of state.nickOwner) {
      if (ttl && now - Number(it.lastSeen || 0) > ttl) continue;
      nicks[nick] = { clientId: it.clientId, lastSeen: Number(it.lastSeen) || now };
    }
    fs.writeFileSync(nicksFile(), JSON.stringify({ version: 2, nicks }, null, 0), 'utf8');
  } catch (e) {
    log('warn', `昵称表写入失败：${e.message}`);
  }
}

/** 启动时读回聊天记录与昵称占用表（重启不丢） */
async function restoreChat() {
  try {
    const d = JSON.parse(await fsp.readFile(chatFile(), 'utf8'));
    state.chat.msgs = Array.isArray(d.msgs) ? d.msgs.slice(-chatLimit()) : [];
    state.chat.seq = Number(d.seq) || (state.chat.msgs.length ? state.chat.msgs[state.chat.msgs.length - 1].id : 0);
    if (state.chat.msgs.length) log('info', `恢复聊天记录：${state.chat.msgs.length} 条`);
  } catch {
    /* 首次运行无文件 */
  }
  try {
    const d = JSON.parse(await fsp.readFile(nicksFile(), 'utf8'));
    const now = Date.now();
    let dropped = 0;
    for (const [nick, v] of Object.entries(d.nicks || {})) {
      // v1 存的是裸 clientId 字符串；v2 存 {clientId,lastSeen}
      const item =
        typeof v === 'string'
          ? { clientId: v, lastSeen: now } // 旧格式：当作"刚刚还在用"，给满一个 TTL（宁可保守，别误抢）
          : { clientId: String((v && v.clientId) || ''), lastSeen: Number(v && v.lastSeen) || now };
      if (!item.clientId) continue;
      if (nickExpired(item)) {
        dropped++;
        continue;
      }
      state.nickOwner.set(nick, item);
    }
    if (dropped) log('info', `启动时丢弃 ${dropped} 个已过期的昵称占用`);
    if (state.nickOwner.size) log('info', `恢复昵称占用：${[...state.nickOwner.keys()].join('、')}`);
  } catch {
    /* 首次运行无文件 */
  }
}

/** 追加一条消息（kind: 'msg' 用户发言 | 'sys' 系统提示） */
function pushChat(kind, opt = {}) {
  const msg = {
    id: ++state.chat.seq,
    at: Date.now(),
    kind,
    clientId: String(opt.clientId || ''),
    nick: String(opt.nick || ''),
    text: String(opt.text || '').slice(0, Math.max(20, Number(CONFIG.chatMaxLen) || 300)),
  };
  state.chat.msgs.push(msg);
  if (state.chat.msgs.length > chatLimit()) state.chat.msgs = state.chat.msgs.slice(-chatLimit());
  saveChatSoon();
  return msg;
}
/** 系统消息（点歌/切歌这类"场上发生的事"，让聊天室有上下文） */
function sysChat(text) {
  return pushChat('sys', { text });
}

/**
 * 记一次心跳。
 * 注意：**只认"服务端认过的昵称"** —— 你不能靠 heartbeat 里自己填个名字
 * 就冒充聊天室里的人（否则"投票过半"的分母就被灌水了）。
 */
function touchClient(clientId, nick) {
  if (!clientId) return null;
  let c = state.clients.get(clientId);
  if (!c) {
    c = { nick: '', lastSeen: 0, joinedAt: Date.now() };
    state.clients.set(clientId, c);
  }
  c.lastSeen = Date.now();
  if (nick && nickHolder(nick) === clientId) {
    c.nick = nick;
    touchNick(nick, clientId); // 露面即给昵称续期
  }
  return c;
}

/** 该 clientId 当前"合法持有"的昵称（没占名 / 被抢走都返回 ''） */
function validNickOf(clientId) {
  const c = state.clients.get(clientId);
  if (!c || !c.nick) return '';
  return nickHolder(c.nick) === clientId ? c.nick : '';
}

/** 在线且已设昵称的人 = "聊天室里的人"（昵称还得仍然归他） */
function onlineClients() {
  const now = Date.now();
  const win = onlineWindow();
  const out = [];
  for (const [id, c] of state.clients) {
    if (now - c.lastSeen > win) continue;
    if (!c.nick) continue;
    if (nickHolder(c.nick) !== id) continue;
    out.push({ clientId: id, nick: c.nick, joinedAt: c.joinedAt, lastSeen: c.lastSeen });
  }
  out.sort((a, b) => a.joinedAt - b.joinedAt);
  return out;
}
function onlineCount() {
  return onlineClients().length;
}

/** 切歌门槛：超过在线人数的一半（1 人 1 票 / 2 人 2 票 / 3 人 2 票 / 4 人 3 票） */
function voteNeed() {
  return Math.max(1, Math.floor(onlineCount() / 2) + 1);
}

/** 清掉长时间没心跳的僵尸客户端（防止 Map 无限增长） */
function gcClients() {
  const now = Date.now();
  const ttl = onlineWindow() * 12;
  for (const [id, c] of state.clients) {
    if (now - c.lastSeen > ttl) {
      state.clients.delete(id);
      state.lastChatAt.delete(id);
    }
  }
  // 昵称不在这里释放：人可能只是关了页过会儿再回来。
  // 只清内存中的在线记录；昵称归属由 nickTtlSec 单独判过期（见 dropExpiredNicks）。
  dropExpiredNicks();
}

// ---------------------------------------------------------------- 昵称占用（带 TTL）

/** 配置里的原始 TTL 秒数（规范化：非法/负数 → 0 = 永不过期） */
function nickTtlSecCfg() {
  const s = Number(CONFIG.nickTtlSec);
  return Number.isFinite(s) && s > 0 ? Math.round(s) : 0;
}

/** 昵称占用的有效期（毫秒）；0 = 永不过期 */
function nickTtlMs() {
  return nickTtlSecCfg() * 1000;
}

/** TTL 的人类可读写法（日志用） */
function nickTtlText() {
  const s = nickTtlSecCfg();
  if (!s) return '永不过期';
  return s >= 86400 ? `${Math.round(s / 86400)} 天` : `${s} 秒`;
}

/** 这条占用记录是否已过期（超过 TTL 没人用过） */
function nickExpired(item) {
  const ttl = nickTtlMs();
  if (!ttl) return false;
  return Date.now() - Number((item && item.lastSeen) || 0) > ttl;
}

/** 距离被释放还有多久（秒）；0 = 永不过期，负数 = 已过期 */
function nickExpiresInSec(nick, clientId) {
  const ttl = nickTtlMs();
  if (!ttl) return 0;
  const it = state.nickOwner.get(nick);
  if (!it) return 0;
  if (clientId && it.clientId !== clientId) return 0;
  return Math.round((Number(it.lastSeen || 0) + ttl - Date.now()) / 1000);
}

/** 当前有效（未过期）的昵称占用数 */
function activeNickCount() {
  let n = 0;
  for (const nick of state.nickOwner.keys()) if (nickHolder(nick)) n++;
  return n;
}

/**
 * 昵称当前归谁 —— `''` 表示没人占，或原主人已超过 TTL 没出现（可被认领）。
 * 所有判断归属的地方都必须走这里：直接读 Map 会拿到已经过期的占用。
 */
function nickHolder(nick) {
  const it = state.nickOwner.get(nick);
  if (!it) return '';
  if (nickExpired(it)) return '';
  return it.clientId;
}

/** 原主人露面了 → 续期（心跳/发言/点歌都会经过这里） */
function touchNick(nick, clientId) {
  const it = state.nickOwner.get(nick);
  if (!it || it.clientId !== clientId) return;
  const now = Date.now();
  it.lastSeen = now;
  // 内存里每次心跳都刷新；但没必要每 2 秒就写一次盘 —— 距上次落盘不足 10 分钟就先攒着
  if (now - Number(it.savedAt || 0) >= 600000) {
    it.savedAt = now;
    saveNicksSoon();
  }
}

/** 清掉所有已过期的占用（由 gcClients 顺手调用，避免表越涨越大） */
function dropExpiredNicks() {
  const ttl = nickTtlMs();
  if (!ttl) return 0;
  const now = Date.now();
  let n = 0;
  for (const [nick, it] of state.nickOwner) {
    if (now - Number(it.lastSeen || 0) > ttl) {
      state.nickOwner.delete(nick);
      n++;
    }
  }
  if (n) {
    log('info', `昵称占用过期回收：${n} 个（超过 ${nickTtlText()}没出现）`);
    saveNicksSoon();
  }
  return n;
}

function normNick(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
}

/**
 * 占昵称。严格唯一：别人用过（哪怕离线）就不能重复用，
 * 除非是他自己（同一 clientId 回来接着用）。
 */
function claimNick(clientId, rawNick) {
  clientId = String(clientId || '').trim();
  if (!clientId) return { ok: false, error: '缺少客户端标识（刷新页面重试）' };
  const nick = normNick(rawNick);
  if (!nick) return { ok: false, error: '昵称不能为空' };
  const max = Math.max(4, Number(CONFIG.nickMaxLen) || 12);
  if (nick.length > max) return { ok: false, error: `昵称最多 ${max} 个字` };

  // nickHolder 已处理 TTL：原主人超过期限没出现 → 视为没人占，可以被别人认领
  const owner = nickHolder(nick);
  if (owner && owner !== clientId) {
    return { ok: false, taken: true, error: `昵称「${nick}」已经有人用了，换一个吧` };
  }

  // 同一个人换昵称 → 把旧昵称释放掉，否则他会一直占着两个名字
  const c = state.clients.get(clientId);
  const old = c && c.nick;
  if (old && old !== nick && nickHolder(old) === clientId) state.nickOwner.delete(old);

  const now = Date.now();
  state.nickOwner.set(nick, { clientId, lastSeen: now, savedAt: now });
  touchClient(clientId, nick);
  saveNicksSoon();
  return { ok: true, nick };
}

/** 该昵称是否已被"别人"占用（前端输入时实时提示用） */
function nickTaken(rawNick, clientId) {
  const nick = normNick(rawNick);
  if (!nick) return false;
  const owner = nickHolder(nick);
  return !!owner && owner !== String(clientId || '');
}

// ---------------------------------------------------------------- 切歌投票

function resetVote() {
  state.vote = { qid: '', voters: new Set(), startedAt: 0 };
}

/**
 * 当前投票快照。票**只对"正在播的这一首"有效** —— 歌一换，
 * qid 对不上，旧票自动作废（不需要额外的清理定时器）。
 */
function voteSnapshot() {
  const cur = state.current;
  const qid = cur ? cur.qid : '';
  const need = voteNeed();
  const online = onlineCount();
  const active = !!qid && state.vote.qid === qid;
  const voters = active ? [...state.vote.voters] : [];
  return {
    /** 被投票的那首歌 */
    qid,
    name: cur ? cur.name : '',
    enabled: CONFIG.skipVoteEnabled !== false,
    votes: voters.length,
    need,
    online,
    passed: votePassed(voters.length, need),
    voters: voters.map((cid) => ({ clientId: cid, nick: validNickOf(cid) || '（已离开）' })),
    startedAt: active ? state.vote.startedAt : 0,
  };
}
function votePassed(votes, need) {
  return need > 0 && votes >= need;
}

/**
 * 投/撤一票。
 * 返回 { ok, mode, switched, ...voteSnapshot }：
 *   mode='direct' 直接切了（管理员 / 关闭了投票）| 'vote' 记为投票
 */
async function requestSkip(clientId, opt = {}) {
  const cur = state.current;

  // 管理员 / 关掉投票开关 → 直接切
  if (opt.force) {
    if (cur) sysChat(`⏭ ${opt.by || '管理员'} 直接切掉了《${cur.name}》`);
    await skip(opt.by ? `${opt.by} 切歌` : '手动跳过');
    resetVote();
    return { ok: true, mode: 'direct', switched: true, ...voteSnapshot() };
  }
  if (CONFIG.skipVoteEnabled === false) {
    await skip('手动跳过');
    resetVote();
    return { ok: true, mode: 'direct', switched: true, ...voteSnapshot() };
  }

  if (!cur) {
    return { ok: false, error: '现在没有在播的歌，不用切', ...voteSnapshot() };
  }
  // 聊天室里一个人都没有 → 没有"过半"可言，直接切（也兼容脚本调用）
  if (onlineCount() === 0) {
    await skip('手动跳过');
    resetVote();
    return { ok: true, mode: 'direct', switched: true, note: '聊天室里没人，直接切', ...voteSnapshot() };
  }
  if (!clientId) return { ok: false, error: '缺少客户端标识（刷新页面重试）', ...voteSnapshot() };
  // 只有"聊天室里的人"能投票（否则分母和票数都能被灌水）
  const voterNick = validNickOf(clientId);
  if (!voterNick) {
    return { ok: false, needNick: true, error: '先给自己起个昵称，才能参与切歌投票', ...voteSnapshot() };
  }

  // 歌变了 → 重新开一局
  if (state.vote.qid !== cur.qid) {
    state.vote = { qid: cur.qid, voters: new Set(), startedAt: Date.now() };
  }

  const had = state.vote.voters.has(clientId);
  if (had) state.vote.voters.delete(clientId);
  else state.vote.voters.add(clientId);

  let snap = voteSnapshot();
  log('info', `🗳 切歌投票《${cur.name}》：${had ? '撤票' : '投票'} → ${snap.votes}/${snap.need}（在线 ${snap.online}）`);
  if (!had && snap.votes === 1) {
    // 只在第一票时提醒一次，免得聊天室被投票消息刷屏
    if (snap.need > 1) sysChat(`🗳 有人想切歌了（1/${snap.need} 票），想切的点「投票切歌」`);
  }

  if (snap.passed) {
    sysChat(`⏭ 《${cur.name}》票数过半（${snap.votes}/${snap.need}），已切歌`);
    await skip('投票过半');
    resetVote();
    return { ok: true, mode: 'vote', switched: true, ...voteSnapshot() };
  }
  return { ok: true, mode: 'vote', switched: false, ...snap };
}

// ---------------------------------------------------------------- 管理员口令
// 只存 sha256(salt::pin)，不存明文；口令也绝不下发给前端。
// 优先用环境变量 JB_ADMIN_PIN（容器里配了就以它为准，页面上不给改）。

function adminFile() {
  return path.join(CONFIG.dataDir, 'admin.json');
}

function readAdminRecord() {
  try {
    const j = JSON.parse(fs.readFileSync(adminFile(), 'utf8'));
    if (j && j.salt && j.hash) return j;
  } catch {
    /* 没设置过 / 文件坏了都当"没设置" */
  }
  return null;
}

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(`${salt}::${pin}`).digest('hex');
}

/** 定长比较，避免用 === 泄漏长度/前缀信息 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function adminSource() {
  if (CONFIG.adminPin) return 'env';
  return readAdminRecord() ? 'file' : 'none';
}

function adminConfigured() {
  return adminSource() !== 'none';
}

function verifyAdminPin(pin) {
  const p = String(pin == null ? '' : pin);
  if (!p) return false;
  if (CONFIG.adminPin) return safeEqual(p, CONFIG.adminPin);
  const rec = readAdminRecord();
  if (!rec) return false;
  return safeEqual(hashPin(p, rec.salt), rec.hash);
}

function setAdminPin(pin) {
  const salt = crypto.randomBytes(12).toString('hex');
  const rec = { salt, hash: hashPin(pin, salt), algo: 'sha256(salt::pin)', updatedAt: Date.now() };
  fs.mkdirSync(path.dirname(adminFile()), { recursive: true });
  fs.writeFileSync(adminFile(), JSON.stringify(rec, null, 1), 'utf8');
  return rec;
}

/** 管理员动作的准入检查：不过就自己回 403 并返回 false */
function requireAdmin(req, res, body) {
  if (!adminConfigured()) {
    send(res, 403, { error: '这台点歌台还没设管理员口令，请先在页面上设置', needSetup: true });
    return false;
  }
  const pin = (body && body.pin) || req.headers['x-admin-pin'] || '';
  if (!verifyAdminPin(pin)) {
    send(res, 403, { error: '管理员口令不对' });
    return false;
  }
  return true;
}

let playTimer = null;

/** 主调度：确保"有歌在播"，否则从队列取下一首 */
async function tick() {
  // 定时关闭到点：先掐声（哪怕 tickBusy 也要抢在调度前面处理）
  if (sleepTimedOut()) {
    await fireSleepTimer();
    return;
  }
  if (state.sleepHold) return; // 已经按定时关过了：不许自动续播，等人点歌 / 点「继续播放」
  if (state.tickBusy) return;
  if (state.probeBusy) return; // 诊断推流期间不要调度，避免互相干扰
  if (state.stopping) return;  // 管理员刚按了「停止」，这轮别急着续播
  state.tickBusy = true;
  try {
    // 1) 若当前无曲目 → 启动下一首
    if (!state.current) {
      const next = state.queue.find((q) => q.status !== 'failed');
      // 关键：这首歌 NAS 曲库里已经有 → 压根不用碰音源，
      // 冷却/重试窗口对它没有意义，直接播（这就是"缓存优先"的意义）
      const nextCached = !!next && !!findLocal(next);
      // ⚠️ 两个等待条件只在**队列里真有歌**时才成立：
      // 队列空的时候不该陪着音源冷却干等，那首还没点的歌跟冷却毫无关系（随机电台要用这条）。
      const retryWait = !!next && !nextCached && state.nextRetryAt && Date.now() < state.nextRetryAt;
      const cooling = !!next && !nextCached && cooldownLeftSec() > 0;

      if (retryWait || cooling) {
        // 队首在等音源，但队列后面可能有"NAS 里已经有"的歌 —— 别让整条队列陪着一起等
        const playable = state.queue.find((q) => q.status !== 'failed' && findLocal(q));
        if (playable && playable !== next) {
          log('info', `音源冷却/重试等待中，先播 NAS 曲库里已有的《${playable.name}》（顺序不变，只借道）`);
          await startPlaying(playable);
          return;
        }
        if (cooling) {
          state.nextRetryAt = RATE.cooldownUntil + 1500;
          // 有可能是预热阶段撞上的限流，这里补一条提示，别让队列"看起来卡住"
          if (!state.notice) {
            state.notice = {
              level: 'warn',
              text: `音源正在限流冷却（剩 ${cooldownLeftSec()} 秒），队列里的歌会自动重试，不用重新点。`,
              at: Date.now(),
            };
          }
        }
        // 重试窗口内不要空转：否则每 2 秒就白打一次音源，还会把 tries 计数刷爆
        return;
      }

      if (next) await startPlaying(next);
      else {
        // 队列空了 → 随机电台接上（只放 NAS 里已经下载过的歌，不碰音源、不烧配额）
        const song = radioAvailable() ? pickRadioSong() : null;
        if (song) {
          log(
            'info',
            `队列空了 → 随机电台接上《${song.name}》${song.artist ? `（${song.artist}）` : ''}｜曲库 ${LIB.size} 首`
          );
          await startPlaying(makeRadioItem(song));
          return;
        }
        state.playing = false;
        resetPlaybackObservation();
      }
      return;
    }

    // 2) 有曲目在播 → 查状态判断是否结束
    let st = null;
    try {
      st = parseStatus(await ENGINE.status());
      // 原始读数只作诊断留档：它含 idle 闪烁与上一首的残留值，**不发布给前端**
      state.lastRaw = {
        state: (st.raw && st.raw.state) || '',
        playing: st.playing,
        position: Math.round(st.position * 10) / 10,
        duration: Math.round(st.duration * 10) / 10,
        volume: st.volume,
        at: Date.now(),
      };
      state.engineOk = true;
      state.engineErr = '';
    } catch (e) {
      state.engineOk = false;
      state.engineErr = e.message;
      log('debug', `状态查询失败：${e.message}`);
    }

    if (st) {
      const cur = state.current;
      const measuredSec = cur.duration || 0;
      const verdict = decideEnd(st, {
        obs: state.obs,
        elapsedMs: Date.now() - (cur.startedAt || Date.now()),
        measuredSec,
        minPlayMs: (CONFIG.minPlaySec || 12) * 1000,
      });
      state.obs = verdict.obs;
      state.lastVerdict = {
        reason: verdict.reason,
        pos: verdict.pos,
        dur: verdict.dur,
        elapsed: Math.round(verdict.elapsedMs / 1000),
        sawProgress: verdict.obs.sawProgress,
        frozen: verdict.obs.frozenCount,
        idle: verdict.obs.idleCount,
        at: Date.now(),
      };

      // ---- 发布给前端的进度：走平滑器，避免"残留值 + idle 闪烁"把进度条拽得来回跳
      const sm = smoothDisplayStatus(st, {
        key: cur.qid || cur.name,
        disp: state.disp,
        obs: verdict.obs,
        blipHold: CONFIG.statusBlipHold,
        leadSec: CONFIG.statusLeadSec,
        // 本曲推流至今多久（挂钟校准用）；startedAt 缺失时传 null，让平滑器跳过这条规则
        elapsedMs: cur.startedAt ? Date.now() - cur.startedAt : null,
      });
      state.disp = sm.next;
      state.lastStatus = {
        playing: sm.next.playing,
        position: Math.round(sm.next.position * 10) / 10,
        duration: Math.round(sm.next.duration * 10) / 10,
        volume: sm.next.volume,
        at: sm.next.at,
        /** 本次是"沿用上一次的值"（idle 闪烁 / 预热期），前端据此不重置进度条 */
        held: sm.held,
        /** 已经采信过真实进度（前端据此把 --:-- 换成 0:00） */
        live: sm.next.live,
        rawPos: Math.round((Number(st.position) || 0) * 10) / 10, // 诊断：接口原始值
      };

      const total = measuredSec || verdict.dur;
      // 注意：插件偶尔会闪一下 idle（position=0），别让进度条跟着归零
      if (total > 0 && verdict.pos > 0) cur.progress = Math.min(100, (verdict.pos / total) * 100);

      state.statusLog.unshift({
        at: Date.now(),
        playing: st.playing,
        rawState: (st.raw && st.raw.state) || '',
        pos: verdict.pos,
        dur: verdict.dur,
        sawProgress: verdict.obs.sawProgress,
        frozen: verdict.obs.frozenCount,
        idle: verdict.obs.idleCount,
      });
      state.statusLog = state.statusLog.slice(0, 60);

      if (verdict.obs.frozenCount === 2) {
        log('warn', `进度连续 ${verdict.obs.frozenCount} 次未推进（pos=${verdict.pos} dur=${verdict.dur} raw.state=${(st.raw && st.raw.state) || '-'}）`);
      }

      if (verdict.ended) {
        log('info', `判定播完 → 切歌（依据：${verdict.reason}）`);
        await skip('播放结束');
        return;
      }
    }

    // 3) 时长兜底：即使状态接口不可用，也不至于卡死
    if (state.expectedEnd && Date.now() > state.expectedEnd) {
      log('warn', `曲目超时兜底切歌：${state.current.name}`);
      await skip('超时兜底');
      return;
    }

    // 4) 预热下载后续曲目（音源冷却期间不要白打请求）
    if (cooldownLeftSec() === 0) prefetch();
  } finally {
    state.tickBusy = false;
  }
}

async function startPlaying(item) {
  item.status = 'downloading';
  item.progress = 5;
  state.current = item;
  state.queue = state.queue.filter((q) => q.qid !== item.qid);
  persist();

  try {
    const r = await downloadToCache(item, (p, bytes) => {
      item.progress = Math.round(5 + p * 60);
    });
    item.fromCache = r.fromCache;
    item.bytes = r.bytes;
    item.br = r.br;
    item.progress = 80;

    // 让音箱去拉：http://<本服务>/audio/<hash>.<ext>
    // 注意：这里刻意使用纯 ASCII 的哈希流名而不是中文文件名 ——
    // 部分音箱的 HTTP 栈对 URL 里的百分号编码处理不可靠，用哈希可彻底规避。
    const ext = (path.extname(r.file).slice(1) || 'mp3').toLowerCase();
    const streamName = `${r.key}.${ext}`;
    const url = `${publicBase()}/audio/${streamName}`;
    log('info', `推流 → ${url}${r.fromCache ? '（本地缓存命中）' : ''}`);

    if (state.cfg.forceVolume) {
      try {
        await ENGINE.setVolume(state.cfg.volume);
      } catch (e) {
        log('debug', `设音量失败：${e.message}`);
      }
    }

    await ENGINE.playUrl(url);

    /**
     * ⚠️ 推流是异步的，这期间用户可能已经切歌 / 管理员按了停止（`state.current` 换了或清了）。
     * 老代码在这里直接写 `state.current.progress = 100` —— 一旦被切走就是 null，
     * 抛 `Cannot set properties of null`，然后被当成"起播失败"处理（随机电台里还会把歌拉黑）。
     * 更隐蔽的是：继续往下写会把**新曲**的播放观测 / 结束时刻一起污染。
     * 所以状态写入前必须确认"我还是当前这首"。
     */
    // 推流期间撞上「定时关闭」：声音已经推上去了，得补一刀停掉（调度器被按住，不会有人来管它）
    if (state.sleepHold) {
      log('warn', `《${item.name}》推流途中撞上定时关闭，补一次停声`);
      try {
        await ENGINE.stop();
      } catch (e) {
        log('debug', `补停声失败：${e.message}`);
      }
      return;
    }

    if (state.current !== item) {
      log('debug', `《${item.name}》推流完成时已被切走，忽略本次状态写入`);
      return;
    }

    item.status = 'playing';
    item.progress = 95;
    item.startedAt = Date.now();
    resetPlaybackObservation(); // 新曲目重新开始观测，上一首的进度/残留值绝不能带过来
    state.playing = true;
    state.startedAt = Date.now();
    state.runtime.playCount += 1;
    state.notice = null;      // 这一首成功了，清掉之前的限流/重试提示
    state.nextRetryAt = 0;
    // 随机电台连续失败计数归零（下一首放不出来时不至于立刻跳 2 倍退避）
    state.radioFailStreak = 0;
    state.radioHoldUntil = 0;

    // 预估时长 → 兜底结束时刻（优先用文件里量出来的真实时长）
    item.duration =
      r.duration || estimateDurationSec(r.bytes, r.br || CONFIG.br) || 0;
    const fallbackSec = item.duration || 240;
    if (!item.duration) log('warn', `《${item.name}》测不出真实时长，兜底按 ${fallbackSec}s 处理`);
    state.expectedEnd = Date.now() + (fallbackSec + CONFIG.overtimeGraceSec) * 1000;
    log('info', `已推流，时长 ${item.duration ? Math.round(item.duration) + 's（实测）' : fallbackSec + 's（兜底）'}，超时宽限 ${CONFIG.overtimeGraceSec}s`);

    item.progress = 100;
    persist();
  } catch (e) {
    handleStartFailure(item, e);
  }
}

/**
 * 起播失败的处理。
 * ------------------------------------------------------------
 * 用户报的「加了歌，队列却还是空的」就出在这里：原先任何失败都会
 * ①把曲目从队列里永久移除 ②只往 history 里塞一条"失败"，
 * 而限流冷却恰好是**必然会发生**的常态（GD Studio 挂在 Cloudflare 后，
 * 密集请求就 503 → 60 秒冷却）。结果就是点一首没一首，界面上什么都看不见。
 *
 * 现在：限流/网络这类"可恢复"错误 → 曲目**放回队首**，等冷却结束自动重试；
 *       只有重试到上限或明显的永久性错误（下架/无版权）才判定失败。
 */
function handleStartFailure(item, e) {
  const msg = e?.message || String(e);
  const tries = (item.tries || 0) + 1;
  const maxTries = Number(CONFIG.maxTries) || 5;

  /**
   * 下载/推流期间用户已经切走（或管理员停止）→ 这条失败**已经过期**。
   * 尤其不能往下走 `state.current = null`：那会把别人刚起播的新曲直接打掉。
   */
  if (state.current !== item) {
    log('debug', `《${item.name}》失败时已不是当前曲目，忽略：${msg}`);
    return;
  }

  state.runtime.failCount += 1;
  state.runtime.lastError = msg;
  state.current = null;
  state.playing = false;

  /**
   * 随机电台的失败是另一套逻辑：
   * 曲目来自 NAS 本地文件，"取不到"基本等于坏文件 / 被手工删了，
   * 重试一万次也一样 —— 所以**不重试、不进队列**（队列是用户点的歌，不能混进无人认领的条目），
   * 直接把这首拉黑，退避一会儿再挑下一首。否则坏文件会让调度器每 3 秒空转一轮。
   */
  if (item.radio) {
    if (item.localKey) state.radioBad.add(item.localKey);
    state.radioFailStreak += 1;
    const baseSec = Math.max(10, Number(CONFIG.radioErrorPauseSec) || 60);
    const pauseSec = baseSec * Math.min(3, state.radioFailStreak); // 连续失败翻倍，最多 3 倍
    state.radioHoldUntil = Date.now() + pauseSec * 1000;
    state.history.unshift({
      name: item.name,
      artist: item.artist,
      requester: item.requester,
      at: Date.now(),
      reason: `随机电台播放失败：${msg}`,
    });
    state.history = state.history.slice(0, 100);
    state.notice = {
      level: 'warn',
      text: `随机电台这首《${item.name}》放不出来（${msg}），${pauseSec} 秒后换一首。`,
      at: Date.now(),
    };
    log('warn', `随机电台《${item.name}》失败（已拉黑，${pauseSec}s 后再挑）：${msg}`);
    persist();
    setTimeout(() => tick().catch(() => {}), Math.min(pauseSec, 20) * 1000);
    return;
  }

  // e.permanent = 音源不支持 / 已熔断这类"再试一万次也一样"的错误，直接判死，
  // 别让它在队列里空转 5 轮还反复弹"正在自动重试"。
  const canRetry = !e?.permanent && isRetryableErr(msg) && tries < maxTries;

  if (canRetry) {
    item.tries = tries;
    item.status = 'pending';
    item.progress = 0;
    item.lastError = msg;
    item.lastErrorAt = Date.now();
    // 放回队首（原样保留点歌人，队列顺序不乱）
    if (!state.queue.some((q) => q.qid === item.qid)) state.queue.unshift(item);

    // 限流冷却 → 等冷却结束再来；其他错误 → 稍等一会儿再试
    const coolMs = cooldownLeftSec() * 1000;
    const waitMs = Math.max(3000, coolMs + 1500);
    state.nextRetryAt = Date.now() + waitMs;
    const waitSec = Math.round(waitMs / 1000);
    state.notice = {
      level: 'warn',
      text: `《${item.name}》暂时取不到音源（${msg}），${waitSec} 秒后自动重试（第 ${tries + 1}/${maxTries} 次），不用重新点。`,
      at: Date.now(),
    };
    log('warn', `《${item.name}》起播失败（第 ${tries}/${maxTries} 次）：${msg} → 放回队列，${waitSec}s 后重试`);
    persist();
    setTimeout(() => tick().catch(() => {}), waitMs + 200);
    return;
  }

  // 真的不行了：记进历史，让用户看得见
  item.status = 'failed';
  item.error = msg;
  log('error', `播放《${item.name}》最终失败（已试 ${tries} 次）：${msg}`);
  state.history.unshift({
    name: item.name,
    artist: item.artist,
    requester: item.requester,
    at: Date.now(),
    reason: `失败（试 ${tries} 次）：${msg}`,
  });
  state.history = state.history.slice(0, 100);
  state.notice = {
    level: 'err',
    text: `《${item.name}》尝试 ${tries} 次仍失败：${msg}`,
    at: Date.now(),
  };
  state.nextRetryAt = 0;
  persist();
  setTimeout(() => tick(), 1200);
}

const inflight = new Set();

/** 预下载队列中的后续曲目，减少点歌后的等待 */
function prefetch() {
  if (!state.queue.length) return;
  let n = 0;
  for (const q of state.queue) {
    if (n >= CONFIG.prefetchCount) break;
    if (q.status !== 'pending') continue;
    // 已经反复失败的先别预热（等正式起播时再走重试逻辑，别浪费重试预算）
    if ((q.tries || 0) >= (Number(CONFIG.maxTries) || 5)) continue;
    if (inflight.has(q.qid)) {
      n++;
      continue;
    }
    inflight.add(q.qid);
    n++;
    (async () => {
      try {
        q.status = 'prefetching';
        const r = await downloadToCache(q, (p) => {
          q.progress = Math.round(p * 100);
        }, { countPlay: false });
        q.status = 'ready';
        q.ready = true;
        q.progress = 100;
        log('debug', `预热完成《${q.name}》${r.fromCache ? '(缓存)' : ''}`);
      } catch (e) {
        // 预热只是为了"快一点"，失败了不能占用正式起播的重试次数
        q.status = 'pending';
        q.lastError = e.message;
        log('debug', `预热失败《${q.name}》：${e.message}`);
      } finally {
        inflight.delete(q.qid);
      }
    })();
  }
}

let schedulerTimer = null;

function startScheduler() {
  clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => {
    tick().catch((e) => log('error', '调度异常：', e.message));
  }, CONFIG.pollIntervalMs);
  tick().catch(() => {});
}

// ---------------------------------------------------------------- 播放引擎初始化

async function initEngine() {
  ENGINE = CONFIG.engine.type === 'xiaomusic' ? new XiaomusicEngine(CONFIG) : new SongloftEngine(CONFIG);
  if (!ENGINE.configured) {
    state.engineOk = false;
    state.engineErr =
      CONFIG.engine.type === 'songloft'
        ? '未配置 songloft 账号密码（config.json → engine.username/password）'
        : '未配置 xiaomusic 地址';
    log('warn', state.engineErr);
    return false;
  }
  try {
    if (ENGINE instanceof SongloftEngine) await ENGINE.ensureToken();
    const list = await ENGINE.devices();
    state.devices = list.map((d) => ({
      id: deviceIdOf(d),
      name: d.name || d.alias || '',
      hardware: d.hardware || '',
      managed: !!d.managed,
      presence: d.presence || '',
    }));
    const dev = await ENGINE.ensureDevice();
    state.deviceInfo = { id: dev.deviceId || deviceIdOf(dev), name: dev.name, hardware: dev.hardware };
    state.engineOk = true;
    state.engineErr = '';
    log('info', `播放引擎就绪（${CONFIG.engine.type}）→ 音箱：${dev.name} [${dev.hardware || '?'}]`);
    return true;
  } catch (e) {
    state.engineOk = false;
    state.engineErr = e.message;
    log('warn', `播放引擎初始化失败：${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------- HTTP

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    ...headers,
  });
  res.end(data);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, filePath) {
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) throw new Error('not file');
    const ext = path.extname(filePath).toLowerCase();
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    stream.pipe(res);
    return true;
  } catch {
    return false;
  }
}

/** 音频服务（支持 Range，音箱 seek 需要） */
async function serveAudio(req, res, fileName) {
  const decoded = decodeURIComponent(fileName);
  const base = path.basename(decoded);

  // 内置静音（「停止」的兜底音源）：现场生成，不落盘
  if (base === SILENCE_NAME) {
    const buf = silenceMp3();
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': buf.length,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    });
    return res.end(buf);
  }

  // 优先按哈希流名（纯 ASCII，推流用）解析；否则按真实文件名
  let full;
  const hashMatch = /^([0-9a-f]{16})\.([a-z0-9]+)$/i.exec(base);
  if (hashMatch && fileIndex.has(hashMatch[1])) {
    full = fileIndex.get(hashMatch[1]);
  } else {
    full = path.join(CONFIG.musicDir, base);
  }

  let st;
  try {
    st = await fsp.stat(full);
  } catch {
    return send(res, 404, { error: '音频不存在' });
  }
  const ext = path.extname(full).toLowerCase();
  const type = MIME[ext] || 'audio/mpeg';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    });
    fs.createReadStream(full, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  });
  fs.createReadStream(full).pipe(res);
}

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // ---- 音频
  if (p.startsWith('/audio/')) {
    return serveAudio(req, res, p.slice('/audio/'.length));
  }

  // ---- 封面代理（同源，避免前端跨域）
  if (p === '/api/cover') {
    const id = u.searchParams.get('id') || '';
    const source = u.searchParams.get('source') || 'netease';
    if (!id) return send(res, 400, { error: 'missing id' });
    try {
      const r = await fetch(`${gdApi()}?types=pic&source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&size=300`, {
        headers: { 'User-Agent': CONFIG.userAgent },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      return send(res, 200, buf, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public,max-age=86400' });
    } catch {
      return send(res, 404, { error: 'no cover' });
    }
  }

  // ---- API
  if (p === '/api/state' && req.method === 'GET') {
    return send(res, 200, queueSnapshot());
  }

  if (p === '/api/search' && (req.method === 'GET' || req.method === 'POST')) {
    const kw = (u.searchParams.get('q') || '').trim();
    if (!kw) return send(res, 400, { error: '请输入歌名或歌手' });
    const localOnly = u.searchParams.get('local') === '1';
    try {
      // 只找本地（曲库面板的搜索框用它，不打扰音源）
      if (localOnly) {
        const lib = libraryList({ q: kw, limit: Math.max(1, Math.min(200, Number(u.searchParams.get('limit')) || 100)) });
        state.runtime.searchCount += 1;
        return send(res, 200, { q: kw, count: lib.count, localOnly: true, localCount: lib.total, results: lib.items, stats: lib.stats });
      }

      const online = await search(kw, CONFIG.searchCount);
      // 本地优先：已缓存的置顶并打标，曲库里独有的（在线源搜不到/已下架）也一并列出来
      const list = decorateWithLocal(kw, online);
      state.runtime.searchCount += 1;
      // 音源在限流冷却时会静默返回空 —— 明确告诉前端"这不是没有，是查不到"
      const cooling = cooldownLeftSec();
      return send(res, 200, {
        q: kw,
        count: list.length,
        localCount: list.filter((x) => x.cached).length,
        onlineCount: online.length,
        warning: !online.length && cooling > 0
          ? `音源正在限流（剩 ${cooling} 秒），下面只显示 NAS 曲库里的结果`
          : undefined,
        results: list,
        stats: libraryStats(),
      });
    } catch (e) {
      // 音源全挂时也别让用户彻底搜不到 —— 曲库里有的先给他
      const local = libraryList({ q: kw, limit: Math.max(1, Number(CONFIG.localTopN) || 10) });
      if (local.total) {
        log('warn', `搜索「${kw}」在线失败（${e.message}），已降级为仅返回本地曲库 ${local.total} 首`);
        return send(res, 200, {
          q: kw,
          count: local.count,
          localCount: local.total,
          onlineCount: 0,
          warning: `音源暂时不可用（${e.message}），下面只显示 NAS 曲库里的结果`,
          results: local.items,
          stats: local.stats,
        });
      }
      return send(res, 502, { error: e.message });
    }
  }

  // ---- 排行榜（QQ 音乐榜单）：只读，带缓存；点歌仍走 /api/enqueue
  //   GET /api/toplist                      → 榜单列表（30 个）
  //   GET /api/toplist?topId=26&n=50        → 某个榜的曲目
  //   加 &force=1 可强制刷新（前端「刷新」按钮）
  if (p === '/api/toplist' && (req.method === 'GET' || req.method === 'POST')) {
    const b = req.method === 'POST' ? await readBody(req) : {};
    const pick = (k) => (b[k] != null && b[k] !== '' ? b[k] : u.searchParams.get(k));
    const rawId = pick('topId');
    const force = /^(1|true|yes)$/i.test(String(pick('force') || ''));
    if (!qqConfigured()) {
      return send(res, 503, { error: '还没配 QQ 音乐账号（点 🔒 → 🎵 QQ 会员音源，填 qm_keyst 和 QQ 号）' });
    }
    try {
      if (rawId == null || rawId === '') {
        const r = await qqToplists({ force });
        return send(res, 200, { ok: true, ...r });
      }
      const r = await qqToplist(rawId, pick('n'), { force });
      // 标出"NAS 里已经有"的曲目：点下去秒播、不占音源额度（缓存里存的是干净数据，这里现算）
      const songs = r.songs.map((x) => ({ ...x, cached: !!findLocal(x) }));
      return send(res, 200, { ok: true, topId: Number(rawId), ttlMin: Math.round(toplistTtlMs() / 60000), ...r, songs });
    } catch (e) {
      return send(res, 502, { error: `榜单拉取失败：${e.message}` });
    }
  }

  // ---- NAS 曲库：列表 / 重扫 / 删除 / 单曲直链
  if (p === '/api/library' && req.method === 'GET') {
    const q = (u.searchParams.get('q') || '').trim();
    const limit = Math.max(1, Math.min(500, Number(u.searchParams.get('limit')) || 200));
    const offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    return send(res, 200, libraryList({ q, limit, offset }));
  }

  if (p === '/api/library/rescan' && req.method === 'POST') {
    const n = await scanLocalLibrary();
    return send(res, 200, { ok: true, count: n, stats: libraryStats() });
  }

  if (p === '/api/library/delete' && req.method === 'POST') {
    const b = await readBody(req);
    const key = String(b.key || '').trim();
    if (!key) return send(res, 400, { error: '缺少 key' });
    const r = await deleteLocal(key);
    return send(res, r.ok ? 200 : 400, { ...r, stats: libraryStats() });
  }

  if (p === '/api/enqueue' && req.method === 'POST') {
    const b = await readBody(req);
    const song = b.song || b;
    if (!song || !song.name) return send(res, 400, { error: '缺少歌曲信息' });
    if (!state.engineOk) {
      const ok = await initEngine();
      if (!ok) return send(res, 503, { error: `播放未就绪：${state.engineErr}` });
    }
    const item = enqueue(song, b.requester);
    // 有人主动点歌 → 撤掉管理员「停止」之后的静默期（新点歌优先，别让它干等）
    state.stopping = false;
    // 有真人点歌 = 「停止」的意图已经过去了；播完这一轮随机电台可以继续兜底
    state.radioPaused = false;
    // 上一次「定时关闭」按住的调度器也一起松开 —— 人都来点歌了，当然是要听
    if (state.sleepHold) clearSleepHold(`有人点歌：${item.requester || '匿名'}`);
    const cached = !!findLocal(item);
    // NAS 曲库已有 → 不用碰音源，冷却也不影响，立刻播
    if (cached || cooldownLeftSec() === 0) {
      prefetch();
      setTimeout(() => tick(), 50);
    } else {
      const waitSec = cooldownLeftSec();
      // 队首要是这首"已缓存"的，tick 会无视冷却直接播，提示里就别乱说等 60 秒
      state.nextRetryAt = RATE.cooldownUntil + 1500;
      const headCached = !!findLocal(state.queue.find((q) => q.status !== 'failed') || {});
      state.notice = {
        level: 'warn',
        text: `音源正在限流冷却中，《${item.name}》已排进队列，约 ${waitSec} 秒后自动开始播放。`,
        at: Date.now(),
      };
      log('warn', `音源冷却中（剩 ${waitSec}s），《${item.name}》已入队等待自动重试`);
      persist();
      if (!headCached) setTimeout(() => tick().catch(() => {}), waitSec * 1000 + 1500);
      else setTimeout(() => tick(), 50);
    }
    // 聊天室里播报一句，让大家知道谁点了什么（也让聊天室有"场上的上下文"）
    sysChat(`${item.requester} 点了一首《${item.name}》`);
    return send(res, 200, {
      ok: true,
      item: { qid: item.qid, name: item.name, artist: item.artist, cached },
      queueLength: state.queue.length,
      cached,
      cooldownLeftSec: cached ? 0 : cooldownLeftSec(),
    });
  }

  // ---- 切歌：默认要「超过聊天室在线人数一半」的票；管理员（带对的口令）可直接切
  if ((p === '/api/skip' || p === '/api/vote/skip') && req.method === 'POST') {
    const b = await readBody(req);
    const clientId = String(b.clientId || '').trim();
    const nick = validNickOf(clientId);
    if (clientId) touchClient(clientId, nick);
    // 管理员解锁后点切歌 = 立即切（和「停止」一样属于管理权限）
    const isAdmin = adminConfigured() && verifyAdminPin(b.pin);
    const r = await requestSkip(clientId, {
      force: isAdmin,
      by: isAdmin ? (nick ? `管理员 ${nick}` : '管理员') : '',
    });
    return send(res, r.ok ? 200 : 400, r);
  }

  // ---- 聊天室：心跳 + 拉增量（一次请求同时完成"我在线"和"给我新消息"）
  if (p === '/api/live' && (req.method === 'POST' || req.method === 'GET')) {
    const b = req.method === 'POST' ? await readBody(req) : {};
    const clientId = String(b.clientId || u.searchParams.get('clientId') || '').trim();
    const nick = normNick(b.nick || u.searchParams.get('nick'));
    const rawSince = b.since != null ? b.since : u.searchParams.get('since');
    const since = Number(rawSince) || 0;
    if (clientId) touchClient(clientId, nick);
    gcClients();

    const limit = Math.max(1, Math.min(200, Number(b.limit) || 120));
    const msgs = since > 0
      ? state.chat.msgs.filter((m) => m.id > since).slice(-limit)
      : state.chat.msgs.slice(-Math.min(limit, 50));

    const me = clientId ? state.clients.get(clientId) : null;
    const mineNick = !!(me && me.nick && nickHolder(me.nick) === clientId);
    return send(res, 200, {
      ok: true,
      serverTime: Date.now(),
      seq: state.chat.seq,
      msgs,
      online: onlineCount(),
      need: voteNeed(),
      vote: voteSnapshot(),
      users: onlineClients().map((x) => ({ clientId: x.clientId, nick: x.nick, isMe: x.clientId === clientId })),
      me: me ? { clientId, nick: me.nick || '', nickOk: mineNick } : null,
      /** 前端据此决定要不要弹"先设昵称"的门（含"昵称被别人抢了"的情况） */
      needNick: !mineNick,
      windowMs: onlineWindow(),
    });
  }

  // 只读拉消息（不带副作用，调试/兜底用）
  if (p === '/api/chat' && req.method === 'GET') {
    const since = Number(u.searchParams.get('since')) || 0;
    const limit = Math.max(1, Math.min(200, Number(u.searchParams.get('limit')) || 100));
    const msgs = since > 0 ? state.chat.msgs.filter((m) => m.id > since).slice(-limit) : state.chat.msgs.slice(-limit);
    return send(res, 200, { ok: true, seq: state.chat.seq, msgs, online: onlineCount(), need: voteNeed() });
  }

  // 发言
  if (p === '/api/chat/send' && req.method === 'POST') {
    const b = await readBody(req);
    const clientId = String(b.clientId || '').trim();
    const text = String(b.text || '').trim();
    if (!clientId) return send(res, 400, { error: '缺少客户端标识（刷新页面重试）' });
    const myNick = validNickOf(clientId);
    if (!myNick) return send(res, 403, { error: '请先设置昵称再发言', needNick: true });
    if (!text) return send(res, 400, { error: '说点什么吧' });
    const maxLen = Math.max(20, Number(CONFIG.chatMaxLen) || 300);
    if (text.length > maxLen) return send(res, 400, { error: `一条最多 ${maxLen} 个字` });
    const gap = Math.max(0, Number(CONFIG.chatMinGapMs) || 600);
    const last = state.lastChatAt.get(clientId) || 0;
    if (gap && Date.now() - last < gap) return send(res, 429, { error: '说得太快了，喘口气再发' });
    state.lastChatAt.set(clientId, Date.now());
    touchClient(clientId, myNick);
    const msg = pushChat('msg', { clientId, nick: myNick, text });
    return send(res, 200, { ok: true, msg, seq: state.chat.seq });
  }

  // ---- 昵称：占用 / 查重（唯一性由服务端裁定，前端只是提示）
  if (p === '/api/nick/claim' && req.method === 'POST') {
    const b = await readBody(req);
    const clientId = String(b.clientId || '').trim();
    const firstTime = !validNickOf(clientId);
    const r = claimNick(clientId, b.nick);
    if (!r.ok) return send(res, r.taken ? 409 : 400, r);
    if (firstTime) log('info', `「${r.nick}」进入聊天室（在线 ${onlineCount()} 人）`);
    return send(res, 200, {
      ok: true,
      nick: r.nick,
      online: onlineCount(),
      need: voteNeed(),
      users: onlineClients().map((x) => ({ clientId: x.clientId, nick: x.nick, isMe: x.clientId === clientId })),
    });
  }

  if (p === '/api/nick/check' && req.method === 'GET') {
    const nick = normNick(u.searchParams.get('nick'));
    const clientId = u.searchParams.get('clientId') || '';
    const taken = nickTaken(nick, clientId);
    return send(res, 200, {
      nick,
      valid: !!nick && nick.length <= Math.max(4, Number(CONFIG.nickMaxLen) || 12),
      maxLen: Math.max(4, Number(CONFIG.nickMaxLen) || 12),
      taken,
      /** 被别人占着的话：还有多少秒自动释放（0 = 永不过期） */
      releasesInSec: taken ? Math.max(0, nickExpiresInSec(nick, '')) : 0,
      /** 占用有效期（秒，0 = 永不过期）—— 前端文案用 */
      ttlSec: nickTtlSecCfg(),
    });
  }

  // ---- 管理员：口令状态 / 设置 / 停止播放（停止必须管理员）
  /**
   * 定时关闭（睡眠定时器）。**故意不要求管理员口令** —— 睡前谁都能顺手设一下。
   * body：
   *   { minutes: 30 }                 → 30 分钟后关
   *   { at: '23:30', repeat: false }  → 到点关（今天已过就顺延到明天）
   *   { at: '23:30', repeat: true }   → 每天都关
   *   { cancel: true }                → 取消定时
   *   { resume: true }                → 已经关过了，接着放（队列里还有歌就续上）
   *   {}                              → 只查询
   */
  if (p === '/api/sleep' && (req.method === 'POST' || req.method === 'GET')) {
    if (req.method === 'GET') return send(res, 200, { ok: true, sleep: sleepSnapshot() });
    const b = await readBody(req);
    if (b.resume) {
      const resumed = clearSleepHold('手动继续播放');
      return send(res, 200, { ok: true, resumed, sleep: sleepSnapshot() });
    }
    try {
      const r = await setSleepTimer({
        minutes: b.minutes,
        at: b.at,
        repeat: b.repeat,
        by: b.by || b.requester,
        cancel: !!b.cancel,
      });
      return send(res, 200, { ok: true, ...r });
    } catch (e) {
      return send(res, 400, { error: e.message, sleep: sleepSnapshot() });
    }
  }

  if (p === '/api/admin/status' && req.method === 'GET') {
    return send(res, 200, { configured: adminConfigured(), source: adminSource() });
  }

  if (p === '/api/admin/setup' && req.method === 'POST') {
    const b = await readBody(req);
    const pin = String(b.pin || '').trim();
    if (pin.length < 4) return send(res, 400, { error: '口令至少 4 位' });
    if (CONFIG.adminPin) return send(res, 400, { error: '管理员口令由环境变量 JB_ADMIN_PIN 指定，页面上不能改' });
    if (adminConfigured() && !verifyAdminPin(b.oldPin)) {
      return send(res, 403, { error: '原管理员口令不对' });
    }
    const existed = adminConfigured();
    setAdminPin(pin);
    log('info', `管理员口令已${existed ? '更新' : '设置'}`);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/admin/stop' && req.method === 'POST') {
    const b = await readBody(req);
    if (!requireAdmin(req, res, b)) return;
    const r = await stopPlayback(b.reason ? `管理员停止（${b.reason}）` : '管理员停止', { by: '管理员' });
    return send(res, 200, { ok: true, ...r });
  }

  // 只校验口令，不做动作（前端"解锁"用）
  if (p === '/api/admin/verify' && req.method === 'POST') {
    const b = await readBody(req);
    if (!requireAdmin(req, res, b)) return;
    return send(res, 200, { ok: true });
  }

  /**
   * 管理员：随机电台开关。
   * body { pin, on?: boolean, clearBad?: boolean, skip?: boolean }
   *   on       —— 开/关（写 runtime-config，重启不丢）
   *   clearBad —— 把"起播失败的坏文件"黑名单清空，给它们一次重试机会
   *   skip     —— 正在放随机曲目时，立刻换一首（不占切歌票，只有管理员能用）
   * 不带任何动作参数 = 纯查询。
   */
  if (p === '/api/admin/radio' && req.method === 'POST') {
    const b = await readBody(req);
    if (!requireAdmin(req, res, b)) return;

    if (b.clearBad) {
      const n = state.radioBad.size;
      state.radioBad.clear();
      log('info', `随机电台：坏文件黑名单已清空（${n} 首）`);
    }
    if (typeof b.on === 'boolean') {
      await saveRuntimeConfig({ autoRadio: b.on });
      state.cfg.autoRadio = b.on; // 立即生效，不必重启
      if (b.on) state.radioPaused = false;
      log('info', `随机电台已${b.on ? '开启' : '关闭'}`);
    }
    if (b.skip) {
      if (state.current && state.current.radio) {
        log('info', '随机电台：管理员要求换一首');
        await skip('管理员换一首（随机电台）');
      } else {
        return send(res, 400, { error: '当前播放的不是随机电台的曲目' });
      }
    }
    return send(res, 200, { ok: true, radio: radioStatus() });
  }

  /**
   * 管理员：写入 / 更新 / 清除 QQ 音乐凭据，并当场自测。
   * body { pin, key?, uin?, quality?, clear?, test? }
   *   key / uin 留空 = 不改；clear=true = 清掉回落 GD；test 默认 true
   * 凭据只落 <dataDir>/runtime-config.json，不回显、不进日志。
   */
  if (p === '/api/admin/qq' && req.method === 'POST') {
    const b = await readBody(req);
    if (!requireAdmin(req, res, b)) return;

    // 清除：deepMerge 会跳过空字符串，所以这里直接把 qq 块从运行期配置里摘掉
    if (b.clear) {
      const file = runtimeCfgFile(CONFIG);
      let cur = {};
      try {
        if (fs.existsSync(file)) cur = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch {
        /* 读不出来就当空的 */
      }
      delete cur.qq;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(cur, null, 2), 'utf8');
      CONFIG.qq = { ...DEFAULT_CONFIG.qq };
      deadSources.delete('qq');
      QQG.lastErr = '';
      log('warn', 'QQ 音乐凭据已清除，音源回落到 GD');
      return send(res, 200, { ok: true, cleared: true, qq: qqStatus() });
    }

    const patch = {};
    const key = String(b.key || '').trim();
    const uin = String(b.uin || '').trim();
    const quality = String(b.quality || '').trim();
    if (uin) {
      if (!/^\d{4,12}$/.test(uin)) return send(res, 400, { error: 'QQ 号格式不对（应为 4~12 位数字）' });
      patch.uin = uin;
    }
    if (key) {
      if (key.length < 20) return send(res, 400, { error: 'qm_keyst 看起来不完整（正常是 90 个字符左右）' });
      patch.key = key;
    }
    if (quality) {
      if (!QQ_Q[quality]) return send(res, 400, { error: `quality 只能是 ${Object.keys(QQ_Q).join(' / ')}` });
      patch.quality = quality;
    }
    if (!Object.keys(patch).length) return send(res, 400, { error: '没有要改的内容' });

    await saveRuntimeConfig({ qq: patch });
    // 立刻生效，不用重启容器
    CONFIG.qq = { ...CONFIG.qq, ...patch };
    deadSources.delete('qq');
    QQG.lastErr = '';
    log('info', `QQ 音乐凭据已更新（${qqMaskUin(CONFIG.qq.uin)}，音质 ${qqQuality()}）`);
    const test = b.test === false ? null : await qqSelfTest(String(b.q || '').trim() || undefined);
    return send(res, 200, { ok: true, qq: qqStatus(), test });
  }

  /** 管理员：只测不写。用来判断"key 过期 / 会员掉了 / 接口改版" */
  if (p === '/api/admin/qq/test' && req.method === 'POST') {
    const b = await readBody(req);
    if (!requireAdmin(req, res, b)) return;
    const test = await qqSelfTest(String(b.q || '').trim() || undefined);
    return send(res, 200, { ok: test.ok, qq: qqStatus(), test });
  }

  // 管理员：看当前昵称被谁占着
  if (p === '/api/admin/nicks' && req.method === 'POST') {
    const b = await readBody(req);
    if (!requireAdmin(req, res, b)) return;
    const now = Date.now();
    const nicks = [];
    for (const [nick, it] of state.nickOwner) {
      if (!nickHolder(nick)) continue; // 已过期的就不用列了
      const c = state.clients.get(it.clientId);
      nicks.push({
        nick,
        online: !!c && now - c.lastSeen <= onlineWindow(),
        idleDays: Math.floor((now - Number(it.lastSeen || 0)) / 86400000),
        releasesInSec: Math.max(0, nickExpiresInSec(nick, '')),
      });
    }
    nicks.sort((x, y) => y.idleDays - x.idleDays);
    return send(res, 200, {
      ok: true,
      ttlSec: nickTtlSecCfg(),
      nicks,
    });
  }

  /**
   * 管理员：立刻释放某个昵称。
   * TTL 到期本来就会自动释放，但那要等满一个周期；
   * 家里人换了手机/清了浏览器数据想马上拿回旧名字，就用这个口子。
   */
  if (p === '/api/admin/nick/release' && req.method === 'POST') {
    const b = await readBody(req);
    if (!requireAdmin(req, res, b)) return;
    const nick = normNick(b.nick);
    if (!nick) return send(res, 400, { error: '要释放哪个昵称？' });
    if (!state.nickOwner.has(nick)) return send(res, 404, { error: `「${nick}」现在没人占用` });
    state.nickOwner.delete(nick);
    // 还挂在这个名字上的人一并摘掉 → 他下次心跳就会被告知要重新起名
    for (const c of state.clients.values()) if (c.nick === nick) c.nick = '';
    saveNicksSoon();
    log('info', `管理员释放了昵称「${nick}」`);
    sysChat(`🔓 管理员释放了昵称「${nick}」，现在谁都可以用`);
    return send(res, 200, { ok: true, nick, nickCount: activeNickCount() });
  }

  /**
   * 从队列里删掉一首 —— **页面上已经不提供这个按钮了**（2026-10-21 用户要求）。
   * 接口留着只为排障/脚本用，所以必须带管理员口令，普通人删不了别人的歌。
   */
  if (p === '/api/remove' && req.method === 'POST') {
    const b = await readBody(req);
    if (!requireAdmin(req, res, b)) return;
    return send(res, 200, { ok: removeFromQueue(String(b.qid || '')) });
  }

  // 「👍 往前挪一位」：凑够 queueTopNeed 个不同的人点赞才前进一步（一人一票，可撤）
  if (p === '/api/top' && req.method === 'POST') {
    const b = await readBody(req);
    const clientId = String(b.clientId || '').trim();
    const qid = String(b.qid || '').trim();
    if (!qid) return send(res, 400, { error: '缺少 qid' });
    if (!clientId) return send(res, 400, { error: '缺少 clientId（浏览器里刷新一下页面）' });
    // 只认服务端认过的昵称：不能让一个人开几个标签页刷票
    const nick = validNickOf(clientId);
    if (!nick) return send(res, 403, { error: '先在聊天室起个昵称，才能给歌点赞' });
    const r = toggleQueueTop(qid, clientId);
    if (!r.ok) return send(res, r.status || 400, { error: r.error });
    if (r.moved) sysChat(`👍《${state.queue[r.index] ? state.queue[r.index].name : ''}》凑够 ${r.need} 个赞，往前挪了一位`);
    return send(res, 200, { ...r, by: nick });
  }

  if (p === '/api/clear' && req.method === 'POST') {
    clearQueue();
    return send(res, 200, { ok: true });
  }

  /**
   * 全场停止 —— **任何人都能用，不需要口令**。
   * 语义和管理员那条完全一致：立刻掐声 + 清空队列 + 按住随机电台。
   * （不动队列的「停止」等于两秒后自动换一首，那就不是停止了。）
   * 谁按的会播报到聊天室，方便追责；body { clientId } 用来认人。
   */
  if (p === '/api/stop' && req.method === 'POST') {
    const b = await readBody(req);
    const clientId = String(b.clientId || '').trim();
    const by = (clientId && validNickOf(clientId)) || '';
    const r = await stopPlayback(by ? `${by} 按了停止` : '有人按了停止', { by });
    // 本来就没在放、队列也空 → 不刷屏（那种情况多半是误点）
    if (r.stopped || r.cleared) sysChat(by ? `⏹ ${by} 按了停止，全场静音` : '⏹ 有人按了停止，全场静音');
    return send(res, 200, { ok: true, by, ...r });
  }

  // ---- 首次配置：验证凭据 → 落盘 → 重新初始化引擎
  if (p === '/api/setup' && req.method === 'POST') {
    const b = await readBody(req);
    const next = {
      base: String(b.base || '').trim().replace(/\/+$/, '') || CONFIG.engine.base,
      username: String(b.username || '').trim() || CONFIG.engine.username,
      password: b.password === undefined || b.password === null ? CONFIG.engine.password : String(b.password),
      deviceId: b.deviceId === undefined ? CONFIG.engine.deviceId : String(b.deviceId || '').trim(),
    };
    try {
      // 先用新凭据探一次，通了才落盘 —— 避免把错的密码写进 NAS
      const probe = new SongloftEngine({ engine: { ...CONFIG.engine, ...next } });
      if (!probe.configured) return send(res, 400, { error: '引擎地址 / 账号 / 密码都不能为空' });
      await probe.ensureToken();
      const list = await probe.devices();
      if (!list.length) return send(res, 400, { error: '登录成功但没读到任何设备：请在 songloft 的「智能音箱」页面用米家扫码登录并勾选音箱' });

      await saveRuntimeConfig({ engine: next });
      Object.assign(CONFIG.engine, next);
      ENGINE = null;                       // 丢掉旧实例，强制用新配置重建
      const ok = await initEngine();
      return send(res, ok ? 200 : 502, {
        ok,
        error: ok ? undefined : state.engineErr,
        devices: state.devices,
        device: state.deviceInfo || null,
      });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  if (p === '/api/volume' && req.method === 'POST') {
    const b = await readBody(req);
    const v = Math.max(0, Math.min(100, Number(b.volume)));
    if (!Number.isFinite(v)) return send(res, 400, { error: 'volume 无效' });
    CONFIG.volume = v;
    try {
      if (state.engineOk) await ENGINE.setVolume(v);
      return send(res, 200, { ok: true, volume: v });
    } catch (e) {
      return send(res, 502, { error: e.message });
    }
  }

  if (p === '/api/engine/retry' && req.method === 'POST') {
    const ok = await initEngine();
    return send(res, ok ? 200 : 503, { ok, error: state.engineErr });
  }

  if (p === '/api/health' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      version: VERSION,
      engine: CONFIG.engine.type,
      engineOk: state.engineOk,
      engineErr: state.engineErr,
      musicDir: CONFIG.musicDir,
      library: libraryStats(),
      preferCache: CONFIG.preferCache !== false,
      queued: state.queue.length,
      playing: !!state.current,
      uptime: Math.round(process.uptime()),
    });
  }

  // ---- 诊断：曲库内容（含每首是否在磁盘上真的存在）
  if (p === '/api/diag/library' && req.method === 'GET') {
    const items = [];
    for (const r of LIB.values()) {
      const st = await fsp.stat(r.file).catch(() => null);
      items.push({
        key: r.key,
        name: r.name,
        artist: r.artist,
        file: path.basename(r.file),
        origin: r.origin,
        ext: r.ext,
        size: st ? st.size : 0,
        onDisk: !!st,
        measuredSec: r.duration || 0,
        plays: r.plays || 0,
        lastPlayedAt: r.lastPlayedAt || 0,
      });
    }
    return send(res, 200, { stats: libraryStats(), count: items.length, items });
  }

  // ---- 诊断：把引擎的原始状态透传出来（默认只回看缓存，不打扰正在播放的流）
  if (p === '/api/diag' && req.method === 'GET') {
    const live = u.searchParams.get('live') === '1';
    let raw = null;
    let err = '';
    if (live) {
      try {
        if (state.engineOk) raw = await ENGINE.status();
      } catch (e) {
        err = e.message;
      }
    }
    return send(res, 200, {
      device: state.deviceInfo,
      current: state.current
        ? { name: state.current.name, status: state.current.status, measuredSec: state.current.duration || 0, startedAt: state.current.startedAt || 0 }
        : null,
      expectedEndInSec: state.expectedEnd ? Math.round((state.expectedEnd - Date.now()) / 1000) : null,
      obs: state.obs,
      lastVerdict: state.lastVerdict,
      lastStatus: state.lastStatus,
      lastRaw: state.lastRaw,
      statusLog: state.statusLog.slice(0, 30),
      parsed: raw ? parseStatus(raw) : null,
      raw,
      err,
      /** 随机电台：为什么接上/没接上（队列空时的兜底） */
      radio: radioStatus(),
      /** 定时关闭：倒计时 / 是否正被按住 */
      sleep: sleepSnapshot(),
      /** 最近一次「停止」是谁按的（排障：明明没人点歌为什么安静） */
      stop: state.lastStop ? { by: state.lastStop.by, at: state.lastStop.at, cleared: state.lastStop.cleared } : null,
      /** 排行榜：缓存了哪些榜、多久过期、最近一次错误 */
      toplist: toplistStatus(),
      /** 音源侧现状：QQ 是否在岗、GD 是否在冷却、哪些源被熔断 */
      sources: {
        qq: qqStatus(),
        gdCooldownLeftSec: cooldownLeftSec(),
        dead: [...deadSources.keys()],
        config: { sources: CONFIG.sources, searchSources: CONFIG.searchSources },
      },
      hint: live ? undefined : '原始状态请加 ?live=1（默认不打扰播放中的流）',
    });
  }

  // ---- 诊断：最近日志（容器里看不到 stdout 时的排障入口）
  if (p === '/api/diag/log' && req.method === 'GET') {
    const n = Math.max(1, Math.min(500, Number(u.searchParams.get('n')) || 120));
    return send(res, 200, { count: LOG_RING.length, lines: LOG_RING.slice(-n) });
  }

  // ---- 诊断：音量置 0（静音）真推一段流，采样状态接口，看它到底怎么报
  if (p === '/api/diag/probe' && req.method === 'POST') {
    const b = await readBody(req);
    const secs = Math.max(5, Math.min(90, Number(b.seconds) || 25));
    const wantName = String(b.file || '').trim();
    let full = null;
    if (wantName) full = path.join(CONFIG.musicDir, path.basename(wantName));
    else {
      // 没指定就挑曲库里最大的那个文件
      let max = 0;
      for (const [, v] of fileIndex) {
        const s = await fsp.stat(v).catch(() => null);
        if (s && s.size > max) {
          max = s.size;
          full = v;
        }
      }
    }
    if (!full) return send(res, 400, { error: '曲库里没有可用音频文件，请先点一首歌让它下载下来' });

    let key = null;
    for (const [k, v] of fileIndex) if (v === full) key = k;
    const base = key ? `${key}${path.extname(full)}` : path.basename(full);
    const url = `${publicBase()}/audio/${encodeURIComponent(base)}`;

    const prevVolume = CONFIG.volume;
    const samples = [];
    state.probeBusy = true;
    try {
      if (!state.engineOk) await initEngine();
      await ENGINE.setVolume(0); // 静音，别吵到人
      const t0 = Date.now();
      await ENGINE.playUrl(url);
      while (Date.now() - t0 < secs * 1000) {
        let raw = null;
        let err = '';
        try {
          raw = await ENGINE.status();
        } catch (e) {
          err = e.message;
        }
        const parsed = raw ? parseStatus(raw) : null;
        samples.push({
          t: Math.round((Date.now() - t0) / 100) / 10,
          err: err || undefined,
          playing: parsed && parsed.playing,
          pos: parsed && parsed.position,
          dur: parsed && parsed.duration,
          volume: parsed && parsed.volume,
          raw, // 原始读数留着，方便对照字段有没有变
        });
        await sleep(1500);
      }
      await ENGINE.setVolume(prevVolume);
    } catch (e) {
      return send(res, 502, { error: e.message, samples });
    } finally {
      state.probeBusy = false;
    }
    return send(res, 200, { url, file: path.basename(full), seconds: secs, samples });
  }

  // ---- 静态资源
  if (req.method === 'GET') {
    let rel;
    try {
      rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    } catch {
      return send(res, 400, { error: 'bad path' });
    }
    const pubDir = path.join(ROOT, 'public');
    const full = path.normalize(path.join(pubDir, rel));
    if (full.startsWith(pubDir) && (await serveStatic(res, full))) return;
  }

  send(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- 启动

let CONFIG;

async function main() {
  CONFIG = loadConfig();
  CONFIG.musicDir = resolveDir(CONFIG.musicDir);
  CONFIG.dataDir = resolveDir(CONFIG.dataDir);
  state.cfg = CONFIG;

  await fsp.mkdir(CONFIG.musicDir, { recursive: true });
  await fsp.mkdir(CONFIG.dataDir, { recursive: true });

  await scanLocalLibrary();
  await restore();
  await restoreChat();
  loadToplistCache();
  restoreSleepSchedule(); // 「每天 23:30 关」这类设定：容器重建后自动接回来

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('error', '请求处理失败：', e.message);
      if (!res.headersSent) send(res, 500, { error: e.message });
    });
  });

  server.listen(CONFIG.port, '0.0.0.0', () => {
    log('info', `小爱点歌台 v${VERSION} 已启动`);
    log('info', `  本机访问：http://127.0.0.1:${CONFIG.port}`);
    log('info', `  音箱拉流：${publicBase()}/audio/<文件名>`);
    log('info', `  曲库目录：${CONFIG.musicDir}`);
    log('info', `  播放引擎：${CONFIG.engine.type} @ ${CONFIG.engine.base}`);
  });

  initEngine().then(() => {
    startScheduler();
    log('info', `调度器已启动（每 ${CONFIG.pollIntervalMs}ms）`);
  });

  // 每分钟清一次"心跳停了很久"的客户端，避免内存表越滚越大
  const gcTimer = setInterval(gcClients, 60000);
  gcTimer.unref && gcTimer.unref();

  const shutdown = () => {
    log('info', '正在退出…');
    persist();
    flushLibraryIndex();
    flushChat();
    flushNicks();
    clearInterval(schedulerTimer);
    clearInterval(gcTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('启动失败：', e);
    process.exit(1);
  });
}

// 供单元测试引用（避免测试时必须起一个真服务）
module.exports = {
  decideEnd,
  parseStatus,
  // 进度条防跳（展示层平滑）
  makeDisplayStatus,
  smoothDisplayStatus,
  probeDurationSec,
  mp3DurationSec,
  flacDurationSec,
  wavDurationSec,
  estimateDurationSec,
  // 曲库相关纯函数
  songKey,
  safeFileName,
  localMatchScore,
  sniffAudio,
  // 聊天室 / 昵称 / 投票切歌相关纯函数
  normNick,
  votePassed,
  voteNeed,
  // 昵称占用 TTL
  nickTtlMs,
  nickExpired,
  nickExpiresInSec,
  // 音源熔断（接口下线的源不要反复重试烧配额）
  isSourceDead,
  markSourceDead,
  deadSources,
  DEAD_SOURCE_TTL_MS,
  // 定时关闭（纯函数，可离线校验"到点"换算）
  nextClockAt,
  // QQ 自建音源（签名是纯函数，可离线校验；取链/搜索走网络）
  qqSign,
  mapTopSong,
  toplistStatus,
  qqConfigured,
  qqQuality,
  qqStatus,
  qqSearch,
  qqResolve,
  qqSelfTest,
};

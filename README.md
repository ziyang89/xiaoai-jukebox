# 小爱点歌台 · XiaoAI Jukebox

> 局域网网页点歌台：手机打开网页点歌，家里的小爱音箱接着放。
> 零 npm 依赖，后端只有一个 Node 文件，前端只有一个 HTML 页面。

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 这是什么

聚会、做饭、打扫卫生的时候，家里人想听什么歌，不用抢手机、不用喊小爱、不用登别人的音乐账号——
**打开一个网页，搜歌、点歌、投票切歌，声音从小爱音箱出来。**

它不替代音乐 App，只解决一件事：**一个房间、一台音箱、几个人同时想听歌时，怎么排队。**

## 功能

| 模块 | 说明 |
|---|---|
| 搜歌点歌 | 搜歌名/歌手 → 点 `＋` 入队，自动排队播放 |
| 本地曲库 | 播过的歌自动下载到 NAS，下次**秒播**；断网也能放 |
| 正在播放 | 封面、歌名、来源、点歌人、进度条、时长，多端实时同步 |
| 投票切歌 | **票数 > 在线人数一半**才切歌，避免一个人霸占音箱 |
| ⏹ 停止 | **所有人都能按**，不需要口令；掐断当前 + 清空全场队列 + 暂停电台，并在聊天室喊一声是谁按的 |
| 队列点赞前挪 | 每首歌一个 `👍 x/N`：**N 个不同的人**点赞才往前挪一位（默认 3 人），挪完清零；一人一票可撤 |
| QQ 排行榜 | 30 个官方榜单（热歌/飙升/地区/主题/场景/风格/电台），一键点歌 |
| 随机电台 | 队列播空后自动从本地曲库接着放，不重复、不联网 |
| 定时关闭 | 5 分钟后 / 今晚 23:30 / 每天 23:30，到点静音但**不清队列** |
| 聊天室 | 系统播报 + 自由聊天 + 在线人数 |
| 昵称门禁 | 进门必须起一个唯一昵称（全场认人，不认浏览器），闲置 7 天自动释放 |
| 曲库管理 | 删除单曲、重新扫描；所有下载都落在自己的 NAS 上 |

## 它是怎么跑的

```
  手机 / 电脑浏览器
        │  HTTP
        ▼
  ┌───────────────┐        ┌──────────────────────┐        ┌────────────┐
  │  jukebox      │  HTTP  │  songloft            │  MIoT  │  小爱音箱   │
  │  (Node，本仓)  │ ─────► │  (智能音箱插件服务)    │ ─────► │ Sound Pro  │
  └───────┬───────┘        └──────────────────────┘        └────────────┘
          │
          ├──► QQ 音乐 / 网易云：搜索 + 取直链
          └──► 本地磁盘：缓存 mp3 / flac，下次直接放
```

本项目只做「网页 + 队列 + 调度 + 缓存」，真正的「让音箱出声」交给第三方播放引擎：

- **songloft**（推荐）——带「智能音箱 / MIoT」插件的播放服务，支持小爱音箱系列；
- **xiaomusic** ——更轻，但只支持部分型号（本项目保留了兼容适配）。

## 快速开始

### 0. 前提

- 一台常开的机器（NAS / 小主机 / 树莓派都行），装了 Docker 或 Node ≥ 18；
- 家里有小爱音箱，并且已经能在米家里正常播放；
- 一个能访问它的内网地址（例如 `http://192.168.1.100:58092`）。

### 1. 先把播放引擎跑起来

按 songloft 的官方文档起一个服务（默认 `58091` 端口），
在它的界面里登录米家账号、把音箱设成「受管设备」，记下**音箱的 device_id**。

> 这一步是绕不开的：本项目不直接对接米家协议，而是让播放引擎去控制音箱。

### 2. 起点歌台

**Docker（推荐）**

```bash
docker build -t xiaoai-jukebox ./jukebox

docker run -d --name xiaoai-jukebox --restart always \
  -p 58092:58092 \
  -v /path/to/Music:/music \
  -v /path/to/jukebox-data:/data \
  -e JB_PUBLIC_BASE=http://192.168.1.100:58092 \
  -e JB_ENGINE_BASE=http://192.168.1.100:58091 \
  -e JB_ENGINE_DEVICE=<音箱的 device_id> \
  -e JB_VOLUME=15 \
  xiaoai-jukebox
```

**或者直接跑 Node（零依赖，不用装任何包）**

```bash
cd jukebox
cp config.example.json config.json   # 然后改成你自己的地址和 device_id
JB_CONFIG=./config.json node server.js
```

### 3. 打开网页

浏览器访问 `http://<你的内网IP>:58092`，起个昵称就能点歌了。
点右下角 **🔒** 可以设管理员口令、配音源。

### 4. （可选）接入 QQ 音乐

QQ 音源走的是**你自己账号的会员 cookie**，音质更高、不占公共接口配额：

1. 网页 → 🔒 → **🎵 QQ 会员音源**；
2. 填 `qm_keyst`（登录 y.qq.com 后从 cookie 里取）和 QQ 号；
3. 点「测试」通过即可，**默认 320k**，有更高会员等级可改 FLAC。

> 不配也能用——会自动回退到公开音源（网易云，有频率限制）。

## 配置

完整示例见 [`jukebox/config.example.json`](jukebox/config.example.json)，常用项：

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | 58092 | 网页端口 |
| `publicBase` | 自动探测 | **音箱能访问到的**本服务地址，写内网 IP |
| `engine.base` / `engine.deviceId` | — | 播放引擎地址与音箱 ID |
| `sources` / `searchSources` | `["qq","netease"]` | 音源顺序，配了 QQ 会自动排最前 |
| `volume` | 15 | 音量（0–100），`forceVolume` 开启时每首歌都拉回这个值 |
| `autoRadio` | true | 队列空了自动续播本地曲库 |
| `sleepMaxMin` | 720 | 定时关闭最长可设多少分钟 |
| `toplistTtlMin` | 30 | 榜单缓存时长 |
| `queueTopNeed` | 3 | 几个人点赞才能往前挪一位 |

所有键都能用环境变量覆盖（`JB_PORT` / `JB_VOLUME` / `JB_ENGINE_BASE` …）。

## 安全与隐私

- **凭据不写进代码、不进镜像**：QQ cookie、管理员口令只落在 `<dataDir>/runtime-config.json` 和 `admin.json` 里，都挂在你自己的磁盘上；
- **管理员口令只存哈希**：`sha256(salt::pin)`，服务端不下发、日志不打印；
- **不往外发数据**：没有账号体系、没有埋点、没有云服务，所有请求只在你家局域网里;
- **只适合内网**：没有 HTTPS、没有多租户隔离，**请不要直接暴露到公网**。

## 已知限制

- 播放能力受限于播放引擎和音箱型号（小米 Sound Pro 实测最稳）；
- QQ 音源用的是非官方接口，随时可能失效——所以有本地缓存和网易云兜底；
- 网易云公共源有频率限制（5 分钟 50 次），批量点歌会排队重试；
- 进度条依赖音箱回报的状态，而那个状态**经常给假数据**（残留值、闪 0、残留值还会往前走），代码里做了挂钟校准来兜住——详见 `jukebox/README.md`。

## 目录结构

```
jukebox/
  server.js              后端全部逻辑（零依赖，单文件）
  public/index.html      前端全部界面（单文件，无构建）
  config.example.json    配置模板
  Dockerfile
  tests/                 30 个自测脚本（含 mock 音箱 / mock 音源 / mock QQ）
  README.md              实现细节、踩坑记录、调试手册
tools/static-server.js   本地预览用的静态服务 + 反代
```

## 测试

不需要真音箱、也不需要真音源，全程 mock：

```bash
cd jukebox
node tests/smoke.js          # 基础链路
node tests/chat-vote.js      # 聊天室 + 投票切歌
node tests/toplist.js        # 排行榜
node tests/queue-top.js      # 点赞前挪
node tests/sleep-timer.js    # 定时关闭
```

还有一批真机只读验收脚本（`verify-nas-*.js`），改完代码直接对线上实例跑一遍，
用指纹 + 字节比对确认「新版真的上线了」。

## 许可

[MIT](LICENSE)。QQ 音乐、网易云、小爱音箱的相关权利归各自厂商所有；
本项目只做局域网内的个人使用，**不要用于商业用途或大规模抓取**。

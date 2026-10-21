# 小爱点歌台（Jukebox）

局域网内任何人用手机打开一个网页，搜索、点歌，由**小爱音箱（小米 Sound Pro / L17A）**播放。
跑在 fnOS NAS 的 Docker 里，零外部服务依赖。

```
┌──────────────┐   HTTP    ┌────────────────────────────┐
│ 手机 / 平板   │ ────────► │  点歌台服务 (本容器)         │
│ 浏览器点歌 H5 │ ◄──────── │   :58092                   │
└──────────────┘   JSON    │                            │
                           │  ① 音源聚合搜索 + 限流节流    │
                           │  ② NAS 曲库缓存（命中即秒播） │
                           │  ③ 点歌队列（JSON 持久化）    │
                           │  ④ /audio/<file> 提供音频     │
                           │  ⑤ 状态轮询 + 时长兜底续播    │
                           └─────────┬──────────────────┘
                                     │ Bearer token
             ┌───────────────────────┼───────────────────────┐
             ▼                       ▼                       ▼
    ┌────────────────┐   ┌────────────────────┐   ┌──────────────────┐
    │ songloft :58091│   │ xiaomusic :58090   │   │ GD Studio 音源    │
    │ 「智能音箱」插件 │   │ （零鉴权 HTTP API） │   │ music-api.       │
    │  └ play-url    │   │  └ /playurl        │   │  gdstudio.xyz    │
    └───────┬────────┘   └─────────┬──────────┘   └──────────────────┘
            └──────────┬───────────┘
                       ▼
              ┌─────────────────┐
              │ 小爱音箱 L17A    │ ← 自己去 NAS 拉 /audio/xxx.mp3
              └─────────────────┘
```

---

## 一、部署

### 1. 准备目录（fnOS 上路径**不带前导斜杠**）

```
vol1/docker/xiaoai-dj/
├── Music/          ← 音频落地 + 你自己的本地音乐（文件名建议「歌手 - 歌名.mp3」）
└── jukebox/
    └── data/
        └── config.json   ← 配置（见下）
```

### 2. 写配置 `vol1/docker/xiaoai-dj/jukebox/data/config.json`

```json
{
  "port": 58092,
  "publicBase": "http://192.168.1.100:58092",
  "engine": {
    "type": "songloft",
    "base": "http://192.168.1.100:58091",
    "prefix": "/api/v1/jsplugin/miot",
    "username": "admin",
    "password": "songloft 的登录密码"
  },
  "volume": 15,
  "logLevel": "info"
}
```

> `publicBase` 必须是**音箱能访问到**的地址，填 NAS 的内网 IP。填错音箱会拉不到音频。

### 3. 构建镜像

在 NAS 的 SSH 里（或在能访问 NAS 的机器上 build 后 save/load）：

```bash
cd /vol1/docker/xiaoai-jukebox/jukebox
docker build -t xiaoai-jukebox:1.0.0 .
```

### 4. 建容器

```bash
docker run -d \
  --name xiaoai-jukebox \
  --restart unless-stopped \
  -p 58092:58092 \
  -v /vol1/docker/xiaoai-jukebox/Music:/music \
  -v /vol1/docker/xiaoai-jukebox/jukebox/data:/data \
  -e JB_CONFIG=/data/config.json \
  -e TZ=Asia/Shanghai \
  xiaoai-jukebox:1.0.0
```

### 5. 用 fnOS 的 Docker 管理接口建（无 SSH 时）

```
trim-cli docker container create \
  --image xiaoai-jukebox:1.0.0 \
  --name xiaoai-jukebox --restart --start \
  --port "58092:58092" \
  --mount "/vol1/docker/xiaoai-jukebox/Music:/music:rw" \
  --mount "/vol1/docker/xiaoai-jukebox/jukebox/data:/data:rw" \
  --env "JB_CONFIG=/data/config.json" \
  --env "TZ=Asia/Shanghai" --yes
```

> ⚠️ Git Bash 里执行必须带 `MSYS_NO_PATHCONV=1`，否则路径会被 MSYS 改写。

### 6. 打开

手机连同一 WiFi → `http://192.168.1.100:58092`

---

## 二、配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | 58092 | 服务端口 |
| `publicBase` | 自动探测 | **音箱能访问到**的地址，务必填内网 IP |
| `musicDir` | `/music` | 音频落地目录，容器内路径 |
| `dataDir` | `/data` | 队列持久化 + 配置目录 |
| `engine.type` | `songloft` | `songloft` 或 `xiaomusic` |
| `engine.base` | — | 播放引擎地址 |
| `engine.username/password` | — | songloft 登录凭据（xiaomusic 无需） |
| `engine.deviceId` | 自动 | 指定音箱；留空自动挑 L17A 且在线且已启用的 |
| `sources` | `["qq","netease"]` | 取链降级顺序。`qq` 是**自建源**（直连 QQ 官方接口，不占公共配额），`netease` 是 GD 公共源兜底（见下节） |
| `searchSources` | `["qq","netease"]` | 搜索源顺序：qq 优先，够了就不打扰 GD |
| `searchEnough` | 3 | QQ 搜到多少条就不再问后面的源（`0` = 每个源都问一遍） |
| `qq.key` | 空 | QQ 音乐的 `qm_keyst`。**别写进 config.json 模板**，用页面「管理员 → QQ 会员音源」写入 `runtime-config.json` |
| `qq.uin` | 空 | QQ 号 |
| `qq.guid` | `114514` | 设备指纹（随便一串数字），换它等于"换台设备" |
| `qq.quality` | `320k` | 音质：`320k` / `128k` / `flac`（FLAC 体积约 5 倍，且音箱不一定吃得下） |
| `retry` | 3 | 单源取链重试次数 |
| `br` | 320 | 目标码率 |
| `volume` | 15 | 推流前设置的音量（自家实测 15 足够，40 偏吵；设 0 = 静音，可用于自测） |
| `forceVolume` | true | 是否每次推流都强制设音量 |
| `pollIntervalMs` | 2000 | 播放状态轮询间隔 |
| `minPlaySec` | 12 | **防误判**：新推流后这段时间内绝不因为状态接口而切歌（音箱起播有延迟） |
| `overtimeGraceSec` | 25 | 超时兜底：超过**实测时长**这么多秒仍无结束信号就强制切 |
| `prefetchCount` | 2 | 队列预下载数（减少点歌后的等待） |
| `preferCache` | true | **缓存优先**：曲库里已有的歌直接用 NAS 文件，不回音源（设为 `false` 则每次都重新下载） |
| `autoRadio` | true | **随机电台**：待播队列播空时自动从 NAS 曲库随机挑一首接着放（只放已缓存的歌，不碰音源） |
| `radioRecentMax` | 10 | 随机电台记住最近播过的多少首（轮完一圈才可能重复）；曲库少于这个数就全库随机 |
| `radioErrorPauseSec` | 60 | 随机曲目起播失败后的退避秒数（连续失败会翻倍，最多 3 倍）；坏文件会被拉黑本次运行不再挑 |
| `sleepMaxMin` | 720 | 定时关闭单次最长可设多少分钟（12 小时，防手抖） |
| `libraryIndexFile` | `<dataDir>/library.json` | 曲库索引落盘位置 |
| `localTopN` | 10 | 搜索时最多额外置顶多少首"曲库独有"的曲目 |
| `maxTries` | 5 | **单曲最多尝试次数**：限流/网络这类可恢复错误会把曲目放回队首自动重试，超过这个次数才判失败 |
| `rateCooldownMs` | 60000 | 撞上音源 429/503 后的全局冷却时长 |
| `chatMaxMessages` | 200 | 聊天室最多保留多少条消息（内存 + `chat.json`） |
| `chatMaxLen` | 300 | 单条聊天消息最长字数 |
| `chatMinGapMs` | 600 | 同一个人两次发言的最小间隔（防刷屏） |
| `nickMaxLen` | 12 | 昵称最长字数 |
| `nickTtlSec` | 604800（7 天） | **昵称占用有效期**（秒）：原主人超过这个期限没出现就自动释放给别人用；设 `0` = 永不过期 |
| `onlineWindowMs` | 20000 | 多久没心跳算"离开聊天室"（代码里有 5 秒下限） |
| `skipVoteEnabled` | true | **切歌要投票过半**；设 `false` 退回"点了就切" |
| `statusBlipHold` | 3 | **进度条防抖**：状态接口的"全零读数"连续出现几次才认账（详见下节）；设 `1` = 不防抖 |
| `statusLeadSec` | 8 | **进度超前容差**（秒）：进度超出"本曲已播时长 + 这个值"就判为上一首的残留，不予发布 |

所有键都可用环境变量覆盖：`JB_PORT` `JB_CONFIG` `JB_RUNTIME_CONFIG` `JB_ENGINE_TYPE` `JB_ENGINE_BASE`
`JB_ENGINE_USER` `JB_ENGINE_PASS` `JB_ENGINE_DEVICE` `JB_ENGINE_ACCOUNT` `JB_ENGINE_PREFIX`
`JB_VOLUME` `JB_MIN_PLAY_SEC` `JB_POLL_MS` `JB_STATUS_BLIP_HOLD` `JB_STATUS_LEAD_SEC` `JB_MAX_TRIES`
`JB_RATE_COOLDOWN_MS` `JB_PUBLIC_BASE` `JB_MUSIC_DIR` `JB_DATA_DIR` `JB_PREFER_CACHE` `JB_LIBRARY_INDEX`
`JB_CHAT_MAX` `JB_NICK_MAX` `JB_NICK_TTL_SEC` `JB_ONLINE_WINDOW_MS` `JB_SKIP_VOTE`
`JB_ADMIN_PIN`（管理员口令，配了就以此为准、页面不可改）
`JB_QQ_KEY` `JB_QQ_UIN` `JB_QQ_GUID` `JB_QQ_QUALITY`（QQ 自建源；`JB_QQ_API` 只给离线测试指 mock 用）。

### 进度条为什么"来回跳 / 时间卡住"（`statusBlipHold` / `statusLeadSec`）

这台音箱（小米 Sound Pro + songloft 插件）的状态接口有**三类假数据**（前两类让进度条来回跳，第三类让它卡死）：

| 假数据 | 长什么样 | 不处理会怎样 |
|---|---|---|
| **idle 闪烁** | 播放中约每 7 秒闪一次 `{state:"idle", position:0, duration:0}`（单次，不影响实际播放） | 进度条掉回 0、秒数变 `--:--`，下一次轮询又弹回去 → **来回跳** |
| **残留进度** | 刚推流时 `position` 是**上一首的**（实测 92.37） | 进度条先跳到 29% 再掉回 0 |
| ⚠️ **会动的残留** | 那个残留值**还在继续往前走一两秒**（实测 190 → 202，上一首的流没断干净），之后才切成新流的真实进度（4 → 6 → 8…） | 它"在动"所以骗得过"看到进度在推进"，又比真值大所以被"只增不减"当基准粘住 → **时间卡死在 3:32 不动**，直到真进度追过它（可能好几分钟） |

修法是把「**判定**」和「**展示**」拆开：

- **判定**（该不该切歌）继续用 `decideEnd` 的原始数据 —— 只认"亲眼看到进度向前推进"的正向证据；
- **展示**（给前端看的进度）过一层 `smoothDisplayStatus()`，四条规则：
  1. **挂钟校准**：进度不可能超过"这首歌已经播了多久"（80 秒前才开始播，不可能已经播到 3:32）。
     —— 这是唯一能治住"会动的残留"的办法：假值动得再欢也超不过挂钟（留 `statusLeadSec` 秒余量给缓冲）；
  2. 还没见过进度推进 → 任何绝对值都不发布（统一 0）；
  3. 整份读数全零 → 连续次数没到 `statusBlipHold`（默认 3 次 ≈ 6 秒）就**沿用上一次的进度**；
  4. 同一首曲子内进度**只增不减**，但**必须能自愈** —— 大幅回退时若看到新基准自己在往上走，
     连续两次就认它，保证任何情况下最多卡 1 个轮询，**绝不会永久冻结**；换歌则整体重置。
- 发布值在 `/api/state` 的 `status` 里，附带 `held`（本次是否沿用旧值）与 `live`（是否已采信）；
  **接口原始读数挪到 `status.rawPos` 与 `/api/diag` 的 `lastRaw`**，排障照样看得到。
  > 排障小抄：`position` 明显大于 `rawPos` 就是"发布值卡在假的基准上"（这正是 10-17 那次的症状）。

因为只动展示层，**切歌逻辑一行没改**，`unit-decide.js` / `smoke.js` 的结论不受影响。
> ⚠️ 挂钟校准假设播放是 **1x**（真机就是 1x）。若将来要倍速播放，需要调 `statusLeadSec` 或改这条规则。

### 昵称为什么会自动释放（`nickTtlSec`）

`clientId` 存在浏览器 localStorage 里 —— 一旦清了浏览器数据、换手机或换浏览器，
那个人就换了新 clientId，**旧昵称会永久锁死**（家里有人叫「妈妈」，换台设备就再也用不了）。

所以昵称占用带有效期：**原主人在期限内出现过（心跳/发言/点歌都算）就一直续期**；
超过期限没人用 → 视为弃用，别人可以认领。被占了也不用干等，昵称框里会提示"还有 N 天自动释放"。

想立刻放掉某个名字（等不到 TTL），管理员在 🔒 弹层里点「👥 管理昵称占用」就能手动释放。
占名记录落在 `<dataDir>/nicks.json`（v2 格式，带 `lastSeen`；能读旧的 v1 格式）。

## 首次配置（推荐）

不想往 NAS 上写 config.json 的话：容器起来后直接用浏览器打开点歌台，
页面会自动摊开「⚙️ 连接播放引擎」面板，填 **songloft 地址 / 账号 / 密码**（可选填 device_id），
点「保存并连接」即可。凭据会先探一次登录，通了才写入
`<dataDir>/runtime-config.json`（在数据卷里，容器重建不丢）；**密码不会回传到页面**。
配好后按钮收起来，需要改时点右上角 ⚙ 再打开。

---

## 三、API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 全量状态：当前曲目 / 队列 / 音箱 / 进度，另含 `notice`（给用户看的提示）/ `cooldownLeftSec` / `retryInSec` / `maxTries` / `library`（曲库概况）/ `preferCache` |
| GET | `/api/search?q=关键词` | 搜索（多源归并 90s 缓存 + **NAS 曲库合并**，已缓存的置顶并打 `cached:true`；加 `&local=1` 只搜本地不联网） |
| GET | `/api/toplist` | **QQ 榜单列表**（30 个榜，带 `group` 分组；缓存 6 小时）。**不需要口令** |
| GET | `/api/toplist?topId=26&n=50` | **某个榜的曲目**（默认 50，最多 100）。缓存 `toplistTtlMin`（默认 30 分钟），`&force=1` 强刷；QQ 挂了自动回退旧缓存并标 `stale:true` |
| POST | `/api/enqueue` | `{song, requester}` 点歌入队，返回 `queueLength` / `cooldownLeftSec` / **`cached`**（true = 直接读 NAS 秒播） |
| GET | `/api/library?q=&limit=&offset=` | **NAS 曲库列表**（含时长/体积/播放次数/直链）+ 占用统计 |
| POST | `/api/library/rescan` | 重新扫描曲库目录（人工丢进去的文件也能入库） |
| POST | `/api/library/delete` | `{key}` 从曲库删除该文件（仅限曲库目录内的文件） |
| POST | `/api/skip` | **切歌**：默认走投票（`{clientId, nick}`）→ 票数超过聊天室在线人数一半才真的切；带正确的 `pin` = 管理员直接切。返回 `{mode:'vote'\|'direct', switched, votes, need, online, voters}` |
| POST | `/api/live` | **心跳 + 拉增量一次搞定**：`{clientId, nick, since}` → `{seq, msgs, online, need, vote, users, needNick}`。前端每 2s 调一次 |
| GET | `/api/chat?since=&limit=` | 只读拉聊天记录（无副作用，调试用） |
| POST | `/api/chat/send` | `{clientId, text}` 发言（没昵称 403、空/超长 400、刷屏 429） |
| POST | `/api/nick/claim` | `{clientId, nick}` 占昵称（**全局唯一**，重名 409；改名自动释放旧名；**原主人超过 `nickTtlSec` 没出现则视为弃用，别人可认领**） |
| GET | `/api/nick/check?nick=&clientId=` | 昵称能否用（`{valid, taken, maxLen, releasesInSec, ttlSec}`，前端输入时实时提示） |
| POST | `/api/remove` | **`{pin, qid}` 管理员从队列移除**（页面上已无删除按钮；不带口令 403，只为排障/脚本保留） |
| POST | `/api/top` | **`{qid, clientId}` 给队列里的歌点赞**：一人一票、可撤；凑够 `queueTopNeed`（默认 3 = 超过 2 名）个不同的人 → 只往前挪**一位**，随后票清零。已在第 1 位的不挪 |
| POST | `/api/clear` | 清空队列 |
| POST | `/api/volume` | `{volume}` 设音量 |
| GET | `/api/admin/status` | 管理员口令是否已设置（`{configured, source}`，绝不下发口令） |
| POST | `/api/admin/setup` | `{pin, oldPin?}` 设置/修改管理员口令（≥4 位；改口令必须先验旧口令） |
| POST | `/api/admin/verify` | `{pin}` 只校验口令（前端"解锁"用） |
| POST | `/api/stop` | **停止播放（所有人都能用，不需要口令）**：掐断当前曲目 + 清空队列 + 按住随机电台；`{clientId}` 用来在聊天室播报「谁按的」 |
| POST | `/api/admin/stop` | **`{pin}` 管理员停止**：和 `/api/stop` 完全同义，只是要口令（给脚本 / 老页面用） |
| POST | `/api/admin/nicks` | `{pin}` 列出当前被占用的昵称（含 `online` / `idleDays` / `releasesInSec`；已过期的不列） |
| POST | `/api/admin/nick/release` | **`{pin, nick}` 立刻释放某个昵称**（等不到 TTL 时的自救口子：家里人换手机想马上拿回旧名字）；被释放的人下次心跳会被告知重新起名 |
| POST | `/api/engine/retry` | 重新初始化播放引擎 |
| GET | `/api/health` | 健康检查（含 `library` 概况 / `preferCache`） |
| GET | `/api/diag` | 排障：最近一次状态观测 / 判定依据（加 `?live=1` 才实时打一次引擎） |
| POST | `/api/diag/probe` | 排障：`{seconds,file?}` 把音量置 0 真推一段流并采样状态，返回时间线 |
| GET | `/api/diag/library` | 排障：逐首列出曲库索引，含 `onDisk`（文件是否真的还在） |
| GET | `/api/diag/log?n=120` | 排障：最近日志（容器里看不到 stdout 时的入口） |
| GET | `/audio/<文件名>` | 音频服务（支持 Range） |
| GET | `/api/cover?id=&source=` | 封面代理（同源，避免跨域） |

---

## 四、工作原理（关键设计）

1. **点歌 → 入队**：前端把歌曲信息 POST 进来，队列立即持久化到 JSON（重启不丢）。
2. **调度器**（默认 2s 一跳）：
   - 没有在播曲目 → 取队首 → **下载音频到 `/music`** → 推 `http://<publicBase>/audio/<file>` 给音箱。
   - 有在播曲目 → 轮询播放状态，检测到结束就切下一首。
3. **结束判定（只认正向证据）**：真机实测发现 songloft 插件对小米 Sound Pro 的
   `is_playing` **恒为 false**，而且刚推流时 `position` 还是**上一首的残留值** ——
   旧逻辑 `is_playing=false && position>0` 会在第一次轮询就成立，导致「刚点歌就切歌」。
   现在的规则：
   - **必须亲眼看到进度向前推进过**（`sawProgress`），否则这份状态视为残留/冻结，一律不采信；
   - **`minPlaySec`（默认 12s）内绝不自动切歌**；
   - 只有「进度走到接口时长的尾部」「进度到实测时长的尾部」「连续 4 次进度不动（清哑音）」
     「连续 3 次 idle（流已停）」才算结束；
   - 拿不到证据就不切，交给 **超时兜底**。
4. **真实时长**：不再用「字节数 ÷ 请求码率」估算，而是**解析音频文件头**（mp3 CBR / flac STREAMINFO / wav）
   量出真实时长 —— 请求码率（320）常与文件实际码率不符，会把兜底切歌时间算错。
5. **预热**：队列前 2 首提前下载，点歌到出声的等待显著缩短。
6. **NAS 曲库缓存（缓存优先）**：见下一节。

---

## 四·五、NAS 曲库缓存：播过的歌自动存 NAS，再播不联网

一句话：**第一遍播放时把音频下载进 `/music`（NAS 曲库），之后同一首歌永远优先用本地文件，
搜索时会标注「已在 NAS」并排在最前。**

### 数据落点

| 内容 | 位置 |
|---|---|
| 音频文件 | `musicDir`（默认 `/music`，容器里挂 NAS 的 `vol1/docker/xiaoai-dj/Music`） |
| 曲库索引 | `<dataDir>/library.json`（默认 `/data`），记 歌名/歌手/专辑/来源/时长/体积/播放次数 |

为什么要有索引：文件名约定是 `歌手 - 歌名.ext`，歌手名里带 `-` 就还原错，
而且反推拿不到专辑、来源、真实时长。所以**下载完当场把元信息写进 `library.json`**，
重启直接读回来；只有人工丢进目录、索引里没有的文件才走文件名兜底（标记 `origin:"scanned"`）。

### 缓存优先体现在四层

| 层 | 行为 |
|---|---|
| 下载 | `downloadToCache()` 第一步就查曲库；命中即用，**根本不发外网请求**（`preferCache:true`，默认开） |
| 搜索 | `/api/search` 把命中的结果打 `cached:true`；曲库里**在线源搜不到**的（下架/限流）也会列出来；排序：本地独有 → 已缓存 → 在线 |
| 点歌 | `/api/enqueue` 命中即回 `cached:true`；此时**无视音源冷却**立即开播 |
| 调度 | `tick()` 对"已缓存"的队首不设冷却/重试窗口；队首在等音源时，会**先把队列里已在 NAS 的那首播了**（顺序不变，只借道） |

### 副作用与边界

- 索引写入是**同步落盘**（每首一次，量极小），容器被 kill 也不会丢刚下载的歌。
- `/api/library/delete` 只能删**曲库目录内、且在索引里**的文件，路径做了包含校验，不会误删别处。
- 文件被外部删掉时：索引里会自动清掉并回落到在线下载；若这首歌标记为"纯本地"（从曲库面板点的），
  则**如实报错**，绝不偷偷回音源（错误信息含「找不到」→ 判定为永久失败，不做无意义重试）。
- 想关掉缓存优先（每次都重新下载）：`JB_PREFER_CACHE=0`。

### 前端

- 搜索结果行：`已在 NAS · 秒播`（绿）/ `NAS 曲库`（本地独有）/ 时长；
- 底部新增「💾 NAS 曲库」卡片：总数 + 占用 + 时长统计、本地搜索、**＋ 不联网播放**、
  **✕ 删除文件**（二次确认）、**🔄 重扫目录**；
- 队列条目显示 `已在 NAS`；点歌 toast 直接说「NAS 里已有，立即播放」。

---

### 自建 QQ 音源：用自己的会员 cookie，不占公共配额（`qq`）

**为什么做这个**：GD 公共接口 5 分钟只给 50 次请求，一家人点歌很容易撞线；撞了就 503 → 60 秒冷却，
体验上就是"点了没反应"。QQ 这条路没有公共配额——搜索接口免费且免登录，取链用自己账号的 cookie，
请求只算在自己头上。

**怎么配**（不用改文件、不用重启）：

1. 浏览器登录 `y.qq.com`
2. F12 → Application/存储 → Cookies → `https://y.qq.com` → 复制 **`qm_keyst`** 的值
3. 打开点歌台 → 右上锁形图标 🔒 → 输入管理员口令 → **🎵 QQ 会员音源** → 填 QQ 号 + `qm_keyst` → 保存
4. 保存时会自动**自测一遍**：搜一首 → 换直链 → 从 CDN 拉 1KB 验证，结果直接显示在弹层里

凭据落在 `<dataDir>/runtime-config.json`（跟着数据卷走），**不会**写进 `config.json` 模板，
接口响应里也只有脱敏后的 QQ 号（`732****74`），key 一个字都不回传、不进日志。

**接口形态**（2026-10-19 实测通过）

```
POST https://u.y.qq.com/cgi-bin/musics.fcg?format=json&sign=<QMWSign>
搜索  module=music.search.SearchCgiService  → mid / media_mid / 时长 / 歌手   （免费、免登录）
取链  module=vkey.GetVkeyServer             → purl 拼 sip 即完整直链          （要会员 cookie）
```

签名 `QMWSign` 是纯算法（md5(body) 大写 → 按固定位置取值 → 叠异或掩码 → 变体 base64 → 前缀 `zzb`），
没有密钥，源码就在 `server.js` 的 `qqSign()`。移植自 [Jusic](https://github.com/JumpAlang/Jusic-Serve-Houses) 的 `QMWSign.java`。

实测能力与坑：

| 档位 | 结果 |
|---|---|
| `128k` / `320k` / `flac` | ✅ 都能换到链；文件是**完整曲目**（320k 的 269s 歌 = 10.3MB，FLAC = 52.8MB），不是 11 秒试听 |
| `flac24bit` / `hires`（臻品母带） | ❌ 要更高等级会员，返回 JSON 错误体（代码会当普通失败降级） |
| CDN 直连 | ✅ 支持 Range、可裸拉；音箱直连外网也能拉，不需要音频代理 |
| 链接有效期 | 不靠它 —— 我们的流程是**先下载落 NAS 再本地推流**，直链只用一次 |

**降级链**：`qq` → `netease`。QQ 拿不到（没版权 / 会员掉了 / key 过期）就自动回落 GD，
歌不会丢；GD 那套"可恢复错误放回队首重试"的逻辑完全没变。

**搜不到时**：`searchSources` 是**顺序**试的，QQ 够 `searchEnough`（默认 3）条就不问 GD ——
这样一次点歌只花 0~1 次公共配额。QQ 返回不足 3 条时才补问 GD 并合并去重。

**排障**：

```bash
curl "http://192.168.1.100:58092/api/state" | grep -o '"qq":{[^}]*}'   # 配没配、最近成功、最近错误
curl "http://192.168.1.100:58092/api/diag"  | grep -o '"qq":{[^}]*}'   # 同上 + GD 冷却状态
curl -X POST .../api/admin/qq/test -d '{"pin":"你的口令"}'             # 只测不写（key 过期时先跑这个）
```

页面弹层里的「自测」按钮就是最后那条。

---

### 到底哪些源能用（2026-10-19 实测）

**别照抄任何文档，包括这份。** 聚合接口会随时下线源，配置里留着死源比没有降级更糟。

```bash
node tests/probe-sources.js              # 探默认几个源
node tests/probe-sources.js netease joox # 只探指定源
```

实测 GD Studio（`music-api.gdstudio.xyz`）当前只认三个 `source` 取值：

| source | 搜索 | 取直链 | 结论 |
|---|---|---|---|
| `netease` | ✅ | ✅ 返回真实 `audio/mpeg` | **唯一完整可用** |
| `joox` | ✅ | ❌ 返回 `{"url":"","br":-1}` | 能搜不能放，别放进 `sources` |
| `bilibili` | ✅ | ❌ 未返回有效直链 | 同上 |
| `kuwo` `kugou` `tencent` `migu` `qq` `tidal` `spotify` `qobuz` `deezer` `ytmusic` `apple` `ximalaya` | ❌ | ❌ | 直接 `400 Value of source is not supported` |

所以默认配置就是 `sources: ["netease"]`、`searchSources: ["netease"]`。

### 死源熔断（为什么不再"多留几个源当保险"）

旧配置写的是 `["netease","kugou","tencent","migu"]`。看起来是四层保险，实际是**每次失败白烧十几倍配额**：

```
netease 失败 → 重试 3 次
  → 降级 kugou：先搜索定位 1 次 + 取链 3 次 = 4 次（全部 400）
  → 降级 tencent：4 次（全部 400）
  → 降级 migu：4 次（全部 400）
  合计最坏 17 次请求换来"一次都没成功"
```

而公共实例的限额是**5 分钟 50 次**——点两首失败就能烧掉三分之一配额，反而把限流撞得更狠。

现在：

- `400 + "not supported"` 被识别为**永久错误**：不重试（`retry=3` 也只打 1 次）；
- 该源被记入熔断名单，**1 小时内直接跳过**（到期自动重试一次，接口恢复能自己回来）；
- 这类错误**不进重试队列空转**，history 里直接记「试 1 次」而不是「试 5 次」；
- `/api/state` 暴露 `sources` / `searchSources` / `deadSources`，部署后一眼能看出配置是不是真换过来了。

### 三条硬性约束（来自音源实测）

- 在线直链**只有约 25 分钟寿命** → 绝不复用直链，只复用**已下载的音频文件**。
- 取链成功率约 62.5% → **单源重试 3 次**（永久错误除外）；目前只有一个可用源，降级链主要是为将来加源预留。
- `HTTP 200 ≠ 可用` → 下载后必须用 **magic bytes** 校验（`ID3` / `0xFFFB` / `fLaC` / `ftyp`）。

### 音源限流防护

GD Studio 挂在 Cloudflare 后面，密集请求会触发 JS Challenge（`503`）。
已内置：**请求串行化 + 最小间隔 700ms**、**撞 503 后冷却 60 秒**、**搜索结果缓存 90 秒**。
正常点歌频率（几分钟一首）完全不会触发。

### 限流 ≠ 失败：曲目绝不凭空消失

冷却期内**任何**取链/下载都会立刻被门挡回。老实现把这当成"永久失败"，
于是曲目一入队就被取走 → 下载失败 → 直接从队列抹掉、只在 history 留一条记录，
界面上只剩一个空队列 —— 用户看到的现象就是「点了歌，队列还是空的」。

现在的规则：

| 错误类型 | 处理 |
|---|---|
| 限流 / 冷却 / 网络抖动 / 取链偶发失败（**可恢复**） | 曲目**放回队首**、保留点歌人与顺序、`tries+1`，设 `nextRetryAt`，**冷却一结束自动重试** |
| 下架 / 无版权 / 404（**永久性**） | 直接进 history 标失败 |
| 试满 `maxTries`（默认 5）次 | 进 history 标失败，并在页面顶部显示 ⛔ |

配套细节：

- 冷却期内 `tick()` **直接跳过**，不会每 2 秒空转去撞门；也不会重复消耗重试次数。
- `resolveUrl()` / `resolveWithFallback()` 一旦发现冷却就立即冒泡，不做无意义重试与换源。
- `prefetch()` 在冷却期不预热；预热失败**不占用**正式起播的重试预算。
- 状态里给出 `notice`（一句人话）/ `cooldownLeftSec` / `retryInSec`，
  前端据此在顶部横幅、队列空态、队列条目三处同时说明原因，队列条目显示
  「等待重试 · Ns（第 X/M 次）」。

---

## 四·六、管理员「停止播放」

「切歌」和「停止」是两件事：切歌 = 跳过这首接着播下一首；**停止 = 真的别放了**。
停止会掐断当前曲目并且**清空所有人的点歌**（不清队列就只是"两秒后换一首"，那不叫停止）。

### 谁能按

**所有人都能按**（2026-10-21 起）—— 「正在播放」卡片里，投票切歌右边的
「⏹ 到点了，停止播放吧」按钮，不需要管理员口令，
接口是 `POST /api/stop`（`{clientId}` 可选，带了就能认出是谁按的）。

- 按之前前端会 `confirm` 一次，明确告诉对方"会清空所有人的点歌"。
- 谁按的会**播报到聊天室**（"⏹ 小明 按了停止，全场静音"），避免"歌怎么没了"没人认账。
- `/api/state.stop` / `/api/diag.stop` 也会留最近一次 `{by, at, cleared}`，排障时能回答
  "明明没人点歌为什么安静"。
- `POST /api/admin/stop`（要口令）保留，语义完全一样 —— 给脚本和老页面用；
  **口令并没有因此被放开**：`/api/admin/*` 那批接口仍然一律验口令。

### 口令

- 首次点底栏的 🔒 → 引导现场设置（≥4 位），**只存 `sha256(salt::pin)` 到 `<dataDir>/admin.json`**，
  不留明文、不进日志、更不会通过 `/api/state` 下发。
- 也可以直接用环境变量 `JB_ADMIN_PIN` 指定 —— 此时页面上不允许改（以 env 为准）。
- 用 `timingSafeEqual` 比较，避免长度/前缀时序泄漏。
- 页面上解锁后口令存在浏览器本地（`localStorage`），下次打开自动解锁；点 🔓 可主动锁定。

### 停止是怎么生效的

引擎 `stop()` 是**逐级降级**的，插件不管支不支持都能停：

| 顺序 | 动作 | 说明 |
|---|---|---|
| ① | `POST /mina/stop` | 插件如果有这个端点，最干净、零延迟 |
| ② | `POST /mina/pause` | 退而求其次 |
| ③ | 推 `/audio/__silence.mp3` | **兜底**：1 秒静音（38 个 MP3 静音帧，运行时生成不落盘），音乐被顶掉、播完即静音 |

实际生效的方式会写进日志（`⏹ 停止播放…停声方式=…`），一眼就知道这版插件吃哪个端点。
同时清空队列 + 置 `state.stopping`（5 秒静默期）防止调度器把队列又续上；
**静默期内有人重新点歌会自动让位**（新点歌优先，不干等）。

---

## 四·六·一、队列里的「👍 往前挪」（2026-10-21 改版）

以前队列每行有两个按钮：`↑` 一键置顶、`✕` 删除。现在：

- **删除按钮下线**（用户要求）——页面上再没有"删别人的歌"的入口；`/api/remove` 只在带管理员口令时可用，
  留给排障/脚本。想清空整队还有队列卡右上角的「清空」（这是原有的公开功能）。
- **`↑` 改成 `👍 x/N`**：`queueTopNeed` 默认 **3**（= 「点赞超过 2 名」）。
  1 个人点不动，2 个人也不够，**凑够 3 个不同的人**才往前挪**一位**（不是飞到最前），挪完票数清零重新攒。
  同一个人再点 = 撤票；已经在第 1 位的照样计票但不挪。
- 只认服务端**认过昵称**的 `clientId`（`validNickOf`），一个人开多个标签页刷不了票。
- `POST /api/top` 返回 `{voted, votes, need, moved, index, first}`；`/api/state.queue[].tops = {votes, voters}`，
  页面顶层给 `queueTopNeed`（前端显示 `👍 2/3`）。

## 四·七、排行榜（QQ 榜单）

左栏「点歌」下面那张 **🏆 排行榜**（可折叠，默认收起）。数据来自 QQ 的
`musicToplist.ToplistInfoServer`（和搜索同一个 `musics.fcg`，不用新凭据）。

- **30 个榜**：飙升、热歌、新歌、流行指数、内地/香港/台湾/欧美/韩国/日本、MV…
  前端按 `group` 分 `<optgroup>`，默认停在**热歌榜(26)**，选择记在 `localStorage`。
- **曲目来源**：`GetDetail` 一次要 100 首（QQ 上限 100，榜单总量 300）。名次用数组下标 + 1。
- 🔑 曲目在 `req_1.data.songInfoList`；`req_1.data.data` 是**榜单元信息**（标题/`updateTime`/`totalNum`）——
  这两个位置搞反就会"榜单是空的"。
- **缓存**：内存 + `<dataDir>/toplist.json`，TTL `toplistTtlMin`（默认 30 分钟，榜单是日更）；
  命中缓存**不碰网络**，重启后直接从文件恢复。QQ 报错但有旧缓存 → 照常返回并标 `stale:true`。
- **点歌复用现有链路**：榜单曲目和搜索结果同构（`source:'qq'` + `id/urlId=mid` + `mediaMid`），
  直接丢给 `/api/enqueue` → `qqResolve` 取链 → 下载落 NAS → 推流。**不新增音源风险面**。
  已缓存的曲目会在接口里标 `cached:true`，前端显示「已在 NAS · 秒播」。
- **限制**：数字专辑（榜里约 1~3%）即使会员也拿不到直链，会和普通点歌一样降级/回落；
  未配 QQ（`/api/toplist` 回 503）时卡片只显示引导文案，不影响点歌。

## 四·八、聊天室 / 昵称唯一性 / 投票切歌

### 布局：三列 4 : 4 : 3

| 列 | 内容 |
|---|---|
| 左（4 份） | 🔍 点歌（搜索框 + 热词 + 结果、点歌、NAS 秒播标记）· 往下是 💾 NAS 曲库 |
| 中（4 份） | 🔊 **正在播放**（封面 / 进度 / **切歌投票条**）+ 📋 **待播放**（置顶 / 删除 / 清空） |
| 右（3 份） | 💬 聊天室（在线名单 + 消息流 + 输入框） |

- 列宽用 `grid-template-columns:minmax(0,4fr) minmax(0,4fr) minmax(260px,3fr)` —— 严格 4:4:3，
  但聊天室**不低于 260px**（≤1180px 时 220px），窄屏挤压时先让左边两列收。
  实测桌面 1416px：`495 : 495 : 371`；1000px：`345 : 345 : 259`。
- **三列顶部必须齐平**：列内间距一律交给 `.col` 的 `gap`，卡片自带的 `margin-top`
  在 `.card` 规则之后被 `.col > *{margin-top:0}` 清零（同权重，靠源码顺序取胜，**这两条不能调换位置**）。
  另外 `#banner:empty{display:none}` —— flex 的 gap 是插在所有参与布局的子元素之间的，
  空通知条哪怕高 0 也会多顶出一个 14px 的缝，左列首卡就会比中列低 14px。
  量测方式：`tests/preview-layout.js` 会把三列首卡的 top 打进 `<title>` 并用 `--dump-dom` 取回文字。
- **「正在播放」和「待播放」常驻，没歌也不隐藏**：前者切到 `#nowIdle` 占位（"现在没有在播放"），
  后者由 `#queue` 的 `.empty` 占位（"还没人点歌，搜一首吧"，垂直居中）。
  两者的空态都会顺带显示音源限流/重试原因，所以"卡住了"时看这里就知道为什么。
- ≤900px 自动堆成单列，顺序：点歌 → NAS 曲库 → 正在播放 → 待播放 → 聊天室；
  聊天室固定 46vh 高度，内部滚动（堆叠时 gap 失效，改由媒体查询把 `margin-top:14px` 还给各块）。
- 截图自检：`node tests/preview-layout.js` → `tests/.preview/shot-{idle,desktop,mid,narrow}.png`
  （`idle` 就是空态那张，专门用来确认占位没被隐藏）；同一脚本还会打印三列几何数据并检查是否齐平。
  想在图上看到那个黑色数据框：URL 加 `&debug=1`（默认不画，免得挡住页面）。

### 新进来先起昵称，且昵称唯一

- 每个浏览器首次打开 → 生成一个 `clientId` 存本地，然后**必须**起一个昵称才能进聊天室（全屏门，跳不过）。
- 昵称**全局唯一**：`nick → clientId` 一一对应，`<dataDir>/nicks.json` 落盘，重启不丢。
  别人用过的名字（哪怕他离线了）你也不能用；同一个人改名会自动释放原名。
- 输入时实时查重（`/api/nick/check`，380ms 去抖），提交时服务端再判一次（前端只是提示）。
- 昵称长度上限 `JB` 配置里的 `nickMaxLen`（默认 12）。

### 谁算"聊天室里的人"

靠**心跳**判定，不看 TCP 连接：

- 前端每 2 秒 `POST /api/live`，服务端刷新该 `clientId` 的 `lastSeen`；
- 超过 `onlineWindowMs`（默认 20 分钟为上限、代码里有 5 秒下限；测试用 5 秒）没心跳 = 已离开；
- **必须是"服务端认过的昵称"才算在线** —— 你光在心跳里自己填个名字不算数，
  否则"在线人数"和"票数"都能被灌水。
- 手机息屏 / 切后台 / 断网都会自然掉线，不需要额外处理；每分钟还会清一次僵尸客户端。

### 切歌要投票过半

- 门槛：`need = floor(在线人数 / 2) + 1` —— **严格超过半数**。
  | 在线人数 | 需要票数 |
  |---|---|
  | 1 | 1 |
  | 2 | 2 |
  | 3 | 2 |
  | 4 | 3 |
  | 5 | 3 |
- 每人一票（按 `clientId`），**再点一次 = 撤票**；底栏和"正在播放"卡片都会显示 `票数/门槛` 与投票人昵称。
- 票**只对"正在播的这一首"有效**：歌一换（播完/被切/新点），`qid` 对不上，旧票自动作废 ——
  不需要额外的清理定时器。
- **聊天室里一个人都没有时**（没人打开页面）→ 没有"半数"可言，直接切（也方便脚本调用）。
- **管理员例外**：解锁后点切歌 = 立即切，不用投票（和「停止」一样属于管理权限）。
- 想要回"点了就切"的老行为：`JB_SKIP_VOTE=0`。

### 聊天室还有什么

- 消息落盘 `<dataDir>/chat.json`（默认留最近 200 条），重启不丢；增量拉取（`since=<id>`），不重传历史。
- **点歌 / 切歌成功会自动在聊天室留一句系统消息**（"XX 点了一首《…》"、"《…》票数过半（2/2），已切歌"），
  这样聊天室里能看到"场上发生了什么"，不用盯着播放卡片。
- 防刷屏：同一个人两次发言最小间隔 `JB`/`chatMinGapMs`（默认 600ms），单条最长 `chatMaxLen`（默认 300 字）。

---

## 四·九、随机电台（队列播完自动续播）

**没人点歌时不该突然安静。** 待播队列播空后，调度器会从 NAS 曲库随机挑一首接着放。

| 设计点 | 做法 | 为什么 |
|---|---|---|
| 放什么 | **只放 NAS 里已经下载过的歌**（`LIB`） | 不碰音源 → 不烧公共配额、不怕限流；离线也能一直放 |
| 怎么挑 | 等概率随机，但排掉最近 `radioRecentMax` 首 + 刚播那一首 | 纯 `Math.random()` 会出现"两首来回换"，听感很差 |
| 池子排空 | 清空历史重来（保留刚播那首的排除） | 宁可有重复，也绝不返回 `null` 卡住 |
| 队列里有什么 | 电台曲目**不进队列**（直接 `current`） | 队列是"人点的歌"，不能让无人认领的条目混进去 |
| 起播失败 | 不重试、不进队列；拉黑这首 + 退避 `radioErrorPauseSec`（连续失败翻倍，最多 3 倍） | 本地文件失败基本是坏文件/被删，重试一万次也一样；退避是为了别把调度器刷爆 |
| 管理员「停止」 | 同时置 `radioPaused`，**5 秒静默期过了也不会自己接上** | 否则"停止"会变成"换一首" |
| 有人点歌 | `radioPaused` 自动解除 | 有人主动点歌 = 停止的意图已经过去了，播完继续兜底 |
| 关掉 | 管理员 → 🎲 随机电台 → 关闭（写 `runtime-config.json`，重启不丢） | 想安静就真的安静 |

开关与状态都走管理员口令（`POST /api/admin/radio`）：

```jsonc
{ "pin": "…", "on": false }        // 开关（持久化）
{ "pin": "…", "skip": true }       // 正在放电台曲目时，立刻换一首
{ "pin": "…", "clearBad": true }   // 清空"坏文件"黑名单，给它们一次重试机会
```

`/api/state.radio` 给出 `{ on, paused, available, libCount, badCount, recent, holdSec, lastKey }`。
**`available` 才是"现在真的会接上吗"** —— 关掉、被停止按住、曲库空、退避中都会是 `false`。
前端「正在播放」标签会显示 🎲 随机电台，队列空时会写明是"电台接手"还是"已关闭/暂停"。

> 一个隐藏收益：这条路径让点歌台在**断网 / 音源全挂**时依然能放歌（曲库有多少放多少）。

---

## 四·十、定时关闭（睡眠定时器）

**睡前不想爬起来关音箱。** 顶栏 ⏱ → 设一个时间，到点自动停声。

| 设计点 | 做法 | 为什么 |
|---|---|---|
| 到点做什么 | 立刻停声 + 把调度器**持久按住**（`state.sleepHold`） | 只是"停止"不够：`stopping` 只有 5 秒静默，一过调度器就把下一首推上去 → 变成"换一首接着放" |
| 队列怎么处理 | **保留，不清空** | 这是和「管理员停止」的核心区别：那几首是别人点的，明早还要听 |
| 谁按住它 | 有人点歌 / 点「继续播放」才解除 | 不解除的话点歌台就彻底哑了，还得记得回来关开关 |
| 两种设定 | `minutes=30`（30 分钟后）、`at=23:30`（到点，今天过了就明天） | "睡前 30 分钟"和"每天 23:30"是两种真实习惯 |
| 每天重复 | `at` + `repeat=true`，**关完自动把目标挪到明天同一时刻** | 不挪的话下一个 tick 又"到点"，会变成每 2 秒关一次 |
| 重启 | 「到点 / 每天」写进 `runtime-config.json`，容器重建后自动接回 | 一次性定时（N 分钟后）不恢复：重启后还剩几分钟没有意义 |
| 上限 | `sleepMaxMin`（默认 720 = 12 小时） | 纯防手抖（把 30 输成 3000） |
| 权限 | **不需要管理员口令** | 睡前谁都能顺手设一下；要停全场才需要口令 |

```jsonc
POST /api/sleep { "minutes": 30 }                  // 30 分钟后
POST /api/sleep { "at": "23:30", "repeat": true }  // 每天 23:30（仅一次就 repeat=false）
POST /api/sleep { "cancel": true }                 // 取消定时
POST /api/sleep { "resume": true }                 // 已经关过了，接着放
GET  /api/sleep                                    // 只查询
```

`/api/state.sleep` 给出
`{ active, until, leftSec, mode, minutes, at, repeat, setBy, setAt, hold, firedAt, firedFrom, queueLeft, maxMin }`。
`active` = 还真在倒计时；`hold` = 已经关过、正被按住（前端显示「继续播放」）。
倒计时由服务端给 `leftSec`、前端本地每秒递减并每 2 秒校准一次（手机息屏久了本地时钟会漂）。

到点停声也占了「停止」同一条路径（`ENGINE.stop()` → `/mina/stop` → pause → 推 1 秒静音），
所以音箱那边不管 API 怎么变都能停得住。

---

## 五、排障

| 现象 | 排查 |
|---|---|
| 手机打不开页面 | 容器是否运行；`docker logs xiaoai-jukebox`；端口是否被占 |
| 页面顶部红条「播放引擎未就绪」 | songloft 的账号密码是否填对；songloft 是否在跑 |
| 顶部黄条「音箱未启用」 | 到 songloft「智能音箱」插件页勾选设备 |
| **点了歌，队列里却没有** | 看顶部是否有 ⏳/⛔ 横幅。⏳ = 音源限流中，歌已排队、N 秒后自动开播（**不用重新点**）；⛔ = 试满 `maxTries` 次或该曲下架，去 history 看原因 |
| 队列里的歌显示「等待重试」 | 正常现象：取链失败过一次，正在等冷却结束自动重试 |
| 点了歌队列动但不响 | ① 音箱音量是否为 0；② `publicBase` 是否为 NAS 内网 IP；③ 音箱与 NAS 是否同一网段（关掉 AP 隔离） |
| 一直卡在「下载中」 | 音源限流或外网不通；看日志里 `搜索源 xx 失败` / `音源被限流` |
| 播完不自动切 | 看日志有没有 `曲目超时兜底切歌`（说明状态接口不可用，走了兜底） |
| **刚点歌就切歌 / 播一半被切** | 先看 `/api/diag` 的 `lastVerdict.reason`：<br>`连续 N 次进度不动` = 音箱那边确实停了（哑音，属正常清场）；<br>若 `reason` 为空却切了 → 说明状态接口行为变了，用 `/api/diag/probe` 采样确认后再调判定 |
| 搜不到歌 | 换关键词试；或调 `searchSources` 增加源 |

```bash
docker logs -f xiaoai-jukebox      # 实时日志
curl http://192.168.1.100:58092/api/health
curl http://192.168.1.100:58092/api/diag/log?n=80   # 没有 logs 命令时的日志入口
```

---

## 六、测试

```bash
# 端到端冒烟：mock 播放引擎 + 真实音源，跑通「搜索→点歌→下载→推流→自动续播」
node tests/smoke.js

# 单元测试：切歌判定（含真机抓到的原始状态序列）+ 状态解析 + 真实时长探测
node tests/unit-decide.js

# 进度条防跳（展示层平滑）：残留值不发布 / idle 闪烁不归零 / 不回退 / 换歌才重置（34 项）
# 含 10-17「时间不动了」的回归：**会动的**残留值不得把进度基准粘死
node tests/status-smooth.js

# 进度条防跳「端到端」：让 mock 引擎模拟真机脏数据，跑两个回合（19 项）
#   A 回 idle 闪烁 → 不回退、闪烁帧不归零；B 回"会动的残留值" → 假值不发布、进度不卡死
node tests/status-live.js

# 回归测试：音源限流时点的歌不能被丢掉（mock 音源注入 503 故障窗口）
node tests/rate-limit.js

# 音源死源处理：400「source not supported」只打 1 次、熔断后不再请求、永久错误不进重试队列（13 项）
node tests/source-guard.js

# 音源可用性实测（**打真实接口**，每源 2 次请求；改配置前先跑这个，别照抄文档）
node tests/probe-sources.js
node tests/probe-sources.js netease joox   # 只探指定源

# QQ 自建音源
node tests/probe-qq.js                     # 只测搜索 + 签名（不需要账号）
node tests/probe-qq.js --key <qm_keyst> --uin <QQ号>   # 加测会员取链 + CDN 可拉
node tests/probe-qq-deep.js --key <qm_keyst> --uin <QQ号>  # 遍历 128k/320k/flac/hires，整曲下载验真
node tests/verify-qq-real.js --key <qm_keyst> --uin <QQ号> # 走**上线代码**跑一遍（搜索→取链→下载→推流）
node tests/qq-source.js                    # 离线端到端（mock QQ 接口）：凭据热写入/QQ优先/降级/兜底/签名（31 项）

# NAS 曲库缓存 / 本地优先：下载落库、搜索置顶、冷却期绕过、删除、重启不清空
node tests/library.js

# 随机电台：队列播空自动放本地曲库（26 项）
#   没人点歌自己起播 / 只用本地文件（音源 mock 零请求）/ 连播不重样 /
#   管理员停止要停得住 / 点歌后恢复兜底 / 关掉就真安静 / 无口令改不了
node tests/radio.js

# 定时关闭：到点真停 / 停完不许自己续播 / 队列保留 / 继续播放接得上 /
#   每天模式挪到明天 / 非法参数 400 / 重启后设定还在（35 项，要等真实分钟边界，约 3 分钟）
node tests/sleep-timer.js
node tests/sleep-timer.js --skip-restart   # 不测重启恢复，省 10 秒

# 管理员「停止播放」：口令设置/校验/改口令 + 停止掐断清场 + 插件无 stop 时的静音兜底
node tests/admin-stop.js

# 聊天室 / 昵称唯一性 / 投票切歌：重名被拒、心跳判定在线、增量消息、过半才切、重启不丢
node tests/chat-vote.js

# 昵称占用 TTL：过期前抢不走 / 过期后可认领 / 心跳续期 / 兼容 v1 旧格式 / 管理员立刻释放
# （把 TTL 压到 3 秒来测，跑完全程约 40 秒）
node tests/nick-ttl.js

# 前端体检：内联 JS 语法 + $('id') 引用是否都存在（改前端后先跑这个）
node tests/ui-check.js

# 真机验收（对已部署的实例跑，会静音后再恢复音量；用完清理见 deploy-to-nas/cleanup-verify.cmd）
node tests/verify-nas.js                      # 默认 http://192.168.1.100:58092
node tests/verify-nas.js http://别的地址:端口  # 也可以指定

# 昵称 TTL 版上线后的「只读」验收：不占昵称 / 不改音量 / 不动队列（18 项）
# 最关键是看 /api/state 有没有 nickTtlSec —— 没有就说明 NAS 还在跑旧 server.js
node tests/verify-nas-ttl.js                  # 默认 http://192.168.1.100:58092

# 「进度条防跳」版上线后的「只读」验收：查 statusBlipHold / nowPosCache / lastRaw 指纹，
# 并顺手看一眼此刻在播的歌进度回不回退（有歌在播才跑最后一步）
node tests/verify-nas-blip.js                 # 默认 http://192.168.1.100:58092

# （不是测试）起一套假环境造数据，用 Edge headless 截桌面/窄屏两张图看布局
node tests/preview-layout.js      # → tests/.preview/shot-*.png
```

`smoke.js` 覆盖 22 项检查：服务启动、引擎握手、L17A 自动选中、真实音源搜索、
两首入队、首曲推流、引擎收到指令、推流地址正确、**音频 Range 可拉取且签名校验通过**、
自动切歌、队列消费完、统计计数、`/api/setup` 首次配置（含错误密码拒绝 + 不落盘）。

`unit-decide.js` 覆盖 25 项：真机残留进度不误切、正常播完才切、接口时长不可信时不采信、
单次状态抖动不切、`minPlaySec` 保护、手动暂停宽容 40 秒、真实时长探测（mp3/flac/wav）。

`rate-limit.js` 覆盖 12 项：限流期间点歌 → 曲目**留在队列**（不被秒杀）、给出 `notice`、
暴露冷却与重试倒计时、不往 history 写"失败"、冷却结束后**自动重试成功**。
mock 音源带故障注入开关：`POST /__fault {"url503Ms":6000}` 让后续取直链请求返回 503。

`library.js` 覆盖 32 项（NAS 缓存 / 本地优先）：首播下载落库 + `library.json` 落盘、
`/audio/<key>` 可拉流且字节数一致、再次搜索命中标记 + 置顶、`&local=1` 只搜本地、
**注入 503 限流后 —— 已缓存的歌仍能搜到、能点、绕过冷却直接播且队列里那首不丢**、
人工丢文件重扫入库、纯本地曲目在音源全挂时照常播放、删除（含重复删除报错 + 文件消失）、
本地文件被删后如实报错、**重启后索引完整保留**。

`admin-stop.js` 覆盖 39 项（停止 + 口令）：未设口令时**管理员接口**仍被拒（403 + `needSetup`）但**公开停止照常能停**、
口令长度校验、**`admin.json` 里只有 sha256 哈希查不到明文**、`/api/state` 不外泄口令/哈希/盐、
错口令与空口令都拒绝、停止能掐断当前曲目 + 清空待播 + **音箱确实收到停止指令**、
停止后等 6 个调度周期也不自动续播、**插件没有 `stop`/`pause` 时自动降级推 1 秒静音**
（`POST /__nostop {"on":true}` 模拟）、内置静音是合法 MP3 帧且可拉取、
停止后的静默期会让位于新点歌、改口令必须先验旧口令、
**公开停止（`/api/stop` 不带口令）同样掐声 + 清空队列 + 不自动续播**、
服务端按 `clientId` 认人（不信前端自报 nick）并在聊天室播报、`/api/state.stop` 留痕。

`chat-vote.js` 覆盖 38 项（聊天室 / 昵称 / 投票）：
**① 昵称唯一** —— 无 clientId / 空名 / 超长被拒、重名 409、本人可复用、改名后旧名被释放、查重接口三态；
**② 在线判定** —— 两人心跳 need=2、**自己在心跳里编个名字不算数**（不能灌水）、超窗口自动离开；
**③ 聊天室** —— 没昵称发言 403、空/超长 400、连发 429、增量拉取 `since`、`chat.json`+`nicks.json` 落盘；
**④ 点歌留痕** —— 聊天室出现"XX 点了一首《…》"系统消息；
**⑤ 投票切歌** —— 1 票不切 / 撤票 / 第 2 票过半才切、切歌有播报、**换歌后旧票清零**、
没设昵称的人不能投票、管理员带对的口令可直接切（错口令按普通投票处理）；
**⑥ 重启** —— 聊天记录与昵称占用完整恢复、别人依然抢不走、本人回来还是自己的名。

`nick-ttl.js` 覆盖 33 项（昵称占用 TTL，把 TTL 压到 **3 秒**来测）：
**① 过期语义** —— TTL 内别人抢 409、过期后查重 `taken:false` 且可被认领、原主人回来反而 409；
**② 续期** —— 持续心跳 7 秒（远超 TTL）别人始终抢不走，停心跳一个 TTL 后即可认领；
**③ 落盘** —— 文件为 `version:2` 且条目是 `{clientId,lastSeen}`（不是裸字符串）；
**④ 重启载入** —— 兼容读 v1 旧格式（当作"刚刚还在用"，不误抢）、启动时丢弃已过期条目并打日志、
落盘不会把过期条目写回去；
**⑤ 管理员释放** —— 未设口令/错口令被拒、列表带 `idleDays`/`releasesInSec` 且不含过期项、
释放不存在 404、释放后别人立刻能认领、**被释放的人下次心跳 `needNick=true`**；
**⑥ `nickTtlSec=0`** —— 永不过期，且查重不再显示释放倒计时。

`status-smooth.js` 覆盖 34 项（进度条防跳，纯函数层）：
**A 残留进度**不发布（接口报 92.37 时展示 0）、原始值仍留在诊断里；
**B 起播**看到推进后才发布真实进度并标 `live`；
**C 核心 bug** —— 单次 idle 闪烁**不归零**、不抹掉时长、标 `held` 且等于上一帧、反复闪不漂移、不干扰判定层；
**D 连续 3 次全零**才放行（真停了要认账）；
**E 同曲内只增不减**（回退帧被顶住）；
**F 换歌重置**（新歌残留值不继承、时长换成新的）；
**G `statusBlipHold=1`** 退回旧行为（不防抖）；
**H 端到端序列** —— 12 帧完整播放，展示进度单调不减且**始终贴着真实进度**，判定层仍在尾部正常判"播完"；
**I 「会动的」残留值**（10-17 的"时间不动了"）—— 190/202 一帧都不发布、切到真值（4→6→8）立刻跟上，**不粘死**；
**J 自愈兜底** —— 就算大幅回退真漏进了展示层，也只顶住 1 个轮询就认新基准，**绝不永久冻结**。

`status-live.js` 覆盖 19 项（进度条防跳，真链路 + 真机脏数据模拟，两个回合）：
让 mock 引擎 `POST /__statusMode` 复现真机的特征，走完整链路（搜索→点歌→下载→推流）密集采样。
- **A 回（idle 闪烁）**：接口任意值确实归零过（≥2 帧，排除"假绿"）、起播后没有 held 帧把进度打成 0、
  发布进度不回退、**发布值从未显著超前真实进度**、**铁证**：接口报 `position=0` 那一刻发布值仍非零；
  并等它自然播完进历史，证明判定层没被改坏；
- **B 回（会动的残留值，180s 起还在往前走）**：假进度一帧都不发布（发布值恒为 0）、
  **进度没被粘死**（末帧发布 12 / 真实 12）、进度确实在往前走、不回退、不超前，
  **铁证**：接口报 `raw=180` 那一刻发布值是 0。
  > mock 必须按 **1x** 跑（`MOCK_SPEED=1`）：挂钟校准假设"进度 1 秒/秒"，倍速播放会触发它的误拦。

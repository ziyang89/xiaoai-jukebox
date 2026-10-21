# 小爱点歌台 · 镜像定义
# 零 npm 依赖，直接跑 Node 内置模块
FROM node:22-alpine

LABEL org.opencontainers.image.title="xiaoai-jukebox"
LABEL org.opencontainers.image.description="局域网小爱音箱点歌台：搜索 / 队列 / 自动续播"

# tzdata 让日志时间正确
RUN apk add --no-cache tzdata curl && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app
COPY server.js ./
COPY public/ ./public/

# 默认配置（可被挂载的 /data/config.json 覆盖，或被 JB_* 环境变量覆盖）
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    JB_PORT=58092 \
    JB_MUSIC_DIR=/music \
    JB_DATA_DIR=/data

RUN mkdir -p /music /data

EXPOSE 58092

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:58092/api/health || exit 1

CMD ["node", "server.js"]

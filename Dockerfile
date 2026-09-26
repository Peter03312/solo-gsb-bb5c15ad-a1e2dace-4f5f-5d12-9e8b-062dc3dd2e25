FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_FILE=/app/data/db.json

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# 再拷贝业务代码与静态前端
COPY src ./src
COPY public ./public

# 数据目录（JSON 文件持久化），交由非 root 用户运行
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 3000

# 启动即完成初始化：数据目录/文件不存在时自动创建
CMD ["node", "src/server.js"]

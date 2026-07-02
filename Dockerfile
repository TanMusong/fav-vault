FROM node:22-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-wqy-zenhei \
    python3 \
    make \
    g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV PORT=5000
ENV DOWNLOAD_DIR=/app/downloads
ENV DB_PATH=/app/database
ENV MAX_CONCURRENT=2

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

RUN mkdir -p /app/downloads /app/database && chown -R 1000:1000 /app

EXPOSE 5000

USER 1000

CMD ["node", "dst/index.js"]

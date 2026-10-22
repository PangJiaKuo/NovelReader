FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=4173 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app

COPY package.json ./
COPY index.html manifest.webmanifest sw.js favicon.svg ./
COPY assets ./assets
COPY icons ./icons
COPY js ./js
COPY server ./server

RUN mkdir -p /data && chown -R node:node /app /data

USER node
VOLUME ["/data"]
EXPOSE 4173

CMD ["node", "server/server.js"]

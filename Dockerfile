FROM node:22-alpine

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080 \
    TORRENTIO_BASE=https://torrentio.strem.fun \
    TORRENTIO_PATH_PREFIX=qualityfilter=threed,480p,scr,cam,unknown

EXPOSE 8080

CMD ["node", "server.js"]

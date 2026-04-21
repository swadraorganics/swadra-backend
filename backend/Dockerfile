FROM ghcr.io/puppeteer/puppeteer:22.8.2

ENV NODE_ENV=production

WORKDIR /app

USER root
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN chown -R pptruser:pptruser /app

EXPOSE 8080
USER pptruser
CMD ["node", "server.js"]

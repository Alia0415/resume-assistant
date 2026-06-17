FROM node:20-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY . .

WORKDIR /app/server

EXPOSE 3000

CMD ["node", "server.js"]

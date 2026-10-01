FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production DB_PATH=/app/data/app.db
EXPOSE 3001
CMD ["npx", "tsx", "server/index.ts"]

FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PREVIEW_DIR=/app/public
EXPOSE 3001

CMD ["npx", "tsx", "src/index.ts"]

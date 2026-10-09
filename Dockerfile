FROM node:24-alpine
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY src ./src
EXPOSE 3000
CMD ["node", "src/server.js"]

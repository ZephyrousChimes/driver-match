FROM node:24-alpine
WORKDIR /app

# pnpm, at the version pinned in package.json's packageManager field
RUN corepack enable

# Install dependencies first, so this layer is cached until package.json or the lockfile changes.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY src ./src
EXPOSE 3000
CMD ["node", "src/server.js"]

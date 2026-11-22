# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /app
ENV npm_config_update_notifier=false

COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY services/api/tsconfig.json services/api/tsconfig.build.json ./
COPY services/api/src ./src
RUN npm run typecheck && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node services/api/migrations ./migrations
COPY --chown=node:node contracts/v2/content-package.schema.json /contracts/v2/content-package.schema.json

USER node
EXPOSE 4318
CMD ["node", "dist/server.js"]

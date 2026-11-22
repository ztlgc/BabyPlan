# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim

WORKDIR /app

COPY --chown=node:node apps/web/package.json ./
COPY --chown=node:node apps/web/server.mjs ./
COPY --chown=node:node apps/web/public ./public

USER node
ENV WEB_HOST=0.0.0.0
ENV WEB_PORT=4174
ENV BABYPLAN_API_TARGET=http://api:4318

EXPOSE 4174
CMD ["node", "server.mjs"]

FROM node:24.15.0-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm build:packages && pnpm --filter @outreachr/cloud typecheck

FROM node:24.15.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "--import", "./apps/cloud/node_modules/tsx/dist/loader.mjs", "apps/cloud/src/server.ts"]

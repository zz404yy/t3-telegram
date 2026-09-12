FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json tsconfig.build.json vitest.config.ts eslint.config.js .prettierrc.json ./
RUN pnpm install --frozen-lockfile=false && pnpm build

FROM node:24-bookworm-slim
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["pnpm", "start"]

ARG BUN_VERSION=1.3.14
FROM docker.io/oven/bun:${BUN_VERSION}-slim AS base
ARG ASSET_VERSION=dev
WORKDIR /app
ENV NODE_ENV=production
ENV ASSET_VERSION=${ASSET_VERSION}

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --ci

FROM deps AS verify
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends brotli gzip \
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN bun run db:types
RUN bun run typecheck
RUN bun run app:build
RUN find build/static -type f \( -name '*.css' -o -name '*.js' -o -name '*.svg' \) -exec gzip -k -9 {} + \
  && find build/static -type f \( -name '*.css' -o -name '*.js' -o -name '*.svg' \) -exec brotli -k -f -q 11 {} +

FROM base
COPY --from=verify --chown=bun:bun /app/build ./build
USER bun
EXPOSE 3000
CMD ["bun", "build/index.js"]

FROM node:22.13.1-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/product-contract/package.json ./packages/product-contract/package.json
COPY packages/product-db/package.json ./packages/product-db/package.json
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci \
    --no-audit \
    --no-fund \
    --foreground-scripts \
    --workspace @kodex/product-contract \
    --workspace @kodex/product-db \
    --workspace @kodex/product-api \
    --include-workspace-root=false
COPY packages/product-contract/tsconfig.json ./packages/product-contract/tsconfig.json
COPY packages/product-contract/src ./packages/product-contract/src
COPY packages/product-db/tsconfig.json ./packages/product-db/tsconfig.json
COPY packages/product-db/src ./packages/product-db/src
COPY packages/product-db/migrations ./packages/product-db/migrations
COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY apps/api/src ./apps/api/src
RUN npm run build --workspace @kodex/product-contract \
    && npm run build --workspace @kodex/product-db \
    && npm run build --workspace @kodex/product-api \
    && npm prune --omit=dev --no-audit --no-fund \
      --workspace @kodex/product-contract \
      --workspace @kodex/product-db \
      --workspace @kodex/product-api \
      --include-workspace-root=false

FROM node:22.13.1-bookworm-slim AS runtime

ARG KODEX_RELEASE_COMMIT=""
ENV NODE_ENV=production
ENV KODEX_RELEASE_COMMIT=$KODEX_RELEASE_COMMIT
LABEL org.opencontainers.image.title="Kodex Product API" \
      org.opencontainers.image.version="0.2.0" \
      org.opencontainers.image.revision=$KODEX_RELEASE_COMMIT
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/product-contract/package.json ./packages/product-contract/package.json
COPY --from=build /app/packages/product-contract/dist ./packages/product-contract/dist
COPY --from=build /app/packages/product-db/package.json ./packages/product-db/package.json
COPY --from=build /app/packages/product-db/dist ./packages/product-db/dist
COPY --from=build /app/packages/product-db/migrations ./packages/product-db/migrations
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist

USER node
EXPOSE 47832
CMD ["node", "apps/api/dist/main.js"]

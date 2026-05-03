# ---------- builder ----------
FROM node:20-slim AS builder

WORKDIR /app

# Install OpenSSL (needed by Prisma)
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy root workspace manifests (lockfile = fast deterministic install)
COPY package.json package-lock.json tsconfig.base.json ./

# Copy only the manifests for the packages we need — changes here bust the install cache
COPY packages/types/package.json ./packages/types/
COPY packages/types/tsconfig.json ./packages/types/
COPY apps/api/package.json ./apps/api/
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/nest-cli.json ./apps/api/

# Install ONLY api + types workspace deps (skips all Next.js/React deps — much faster)
# npm install (not ci) because ci is strict about missing workspace dirs in the build context
RUN npm install \
      --workspace=packages/types \
      --workspace=apps/api \
      --include-workspace-root \
      --ignore-scripts \
      --legacy-peer-deps

# Build shared types first
COPY packages/types/src/ ./packages/types/src/
RUN cd packages/types && npx tsc

# Copy API source and Prisma schema
COPY apps/api/src/ ./apps/api/src/
COPY apps/api/prisma/ ./apps/api/prisma/

# Generate Prisma client + build API
RUN cd apps/api && npx prisma generate
RUN cd apps/api && npx nest build

# Prune devDependencies for the runner stage
RUN npm prune --omit=dev --legacy-peer-deps

# ---------- runner ----------
FROM node:20-slim AS runner

WORKDIR /app

# Install OpenSSL (needed by Prisma at runtime)
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1001 printforge && \
    useradd -u 1001 -g printforge -m printforge

# Copy built output
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/package.json ./
COPY --from=builder /app/apps/api/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/types/dist ./node_modules/@printforge/types/dist
COPY --from=builder /app/packages/types/package.json ./node_modules/@printforge/types/package.json

RUN mkdir -p /app/uploads && chown -R printforge:printforge /app

USER printforge

EXPOSE 4000

CMD ["node", "dist/main.js"]

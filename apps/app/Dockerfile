# ---------- builder ----------
FROM node:20-slim AS builder

WORKDIR /app

# Copy root workspace manifests (lockfile = fast deterministic install)
COPY package.json package-lock.json tsconfig.base.json ./

# Copy only the manifests for the packages we need — changes here bust the install cache
COPY packages/types/package.json ./packages/types/
COPY packages/types/tsconfig.json ./packages/types/
COPY apps/app/package.json ./apps/app/
COPY apps/app/tsconfig.json ./apps/app/
COPY apps/app/next.config.js ./apps/app/
COPY apps/app/postcss.config.js ./apps/app/
COPY apps/app/tailwind.config.ts ./apps/app/

# Install ONLY app + types workspace deps (skips all NestJS/Prisma deps — much faster)
RUN npm ci \
      --workspace=packages/types \
      --workspace=apps/app \
      --include-workspace-root \
      --ignore-scripts \
      --legacy-peer-deps

# Build shared types first
COPY packages/types/src/ ./packages/types/src/
RUN cd packages/types && npx tsc

# Copy app source
COPY apps/app/src/ ./apps/app/src/
COPY apps/app/public/ ./apps/app/public/

# Build Next.js
RUN cd apps/app && npm run build

# ---------- runner ----------
FROM node:20-slim AS runner

WORKDIR /app

RUN groupadd -g 1001 printforge && \
    useradd -u 1001 -g printforge -m printforge

# Next.js standalone output
COPY --from=builder /app/apps/app/.next/standalone ./
COPY --from=builder /app/apps/app/.next/static ./apps/app/.next/static
COPY --from=builder /app/apps/app/public ./apps/app/public

RUN chown -R printforge:printforge /app

USER printforge

EXPOSE 3000

CMD ["node", "apps/app/server.js"]

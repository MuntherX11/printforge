# ---------- builder ----------
FROM node:20-slim AS builder

WORKDIR /app

# Install OpenSSL (needed by Prisma)
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy root workspace files
COPY package.json ./
COPY tsconfig.base.json ./

# Copy shared types package
COPY packages/types/package.json ./packages/types/
COPY packages/types/tsconfig.json ./packages/types/
COPY packages/types/src/ ./packages/types/src/

# Copy API package
COPY apps/api/package.json ./apps/api/
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/nest-cli.json ./apps/api/

# Install all workspace dependencies
RUN npm install --workspaces --include-workspace-root --ignore-scripts

# Build shared types first
RUN cd packages/types && npx tsc

# Copy API source and Prisma schema
COPY apps/api/src/ ./apps/api/src/
COPY apps/api/prisma/ ./apps/api/prisma/

# Generate Prisma client
RUN cd apps/api && npx prisma generate

# Build API
RUN cd apps/api && npx nest build

# Remove devDependencies to slim down the runner image
RUN npm prune --omit=dev --workspaces

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

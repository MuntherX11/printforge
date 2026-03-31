# ---------- builder ----------
FROM node:20-slim AS builder

WORKDIR /app

# Copy root workspace files
COPY package.json ./
COPY tsconfig.base.json ./

# Copy shared types package
COPY packages/types/package.json ./packages/types/
COPY packages/types/tsconfig.json ./packages/types/
COPY packages/types/src/ ./packages/types/src/

# Copy app package
COPY apps/app/package.json ./apps/app/
COPY apps/app/tsconfig.json ./apps/app/
COPY apps/app/next.config.js ./apps/app/
COPY apps/app/postcss.config.js ./apps/app/
COPY apps/app/tailwind.config.ts ./apps/app/

# Install all workspace dependencies
RUN npm install --workspaces --include-workspace-root --ignore-scripts

# Build shared types first
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

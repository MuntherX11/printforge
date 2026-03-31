# Contributing to PrintForge

Thanks for your interest in contributing to PrintForge. This guide covers the development workflow.

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- Git

### Local Development

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/printforge.git
cd printforge

# Install all workspace dependencies
npm install

# Start databases only
docker compose up db redis -d

# Create .env from example
cp .env.example .env

# Generate Prisma client and push schema
cd apps/api
npx prisma generate
npx prisma db push
cd ../..

# Build shared types (required before running either app)
cd packages/types && npx tsc && cd ../..

# Run API in watch mode
npm run dev --workspace=@printforge/api

# In another terminal: run frontend
npm run dev --workspace=@printforge/app
```

API: `http://localhost:4000/api`
Frontend: `http://localhost:3000`

### Seeding Test Data

```bash
cd apps/api
npx ts-node prisma/seed.ts
```

Or use the deploy script's seed logic manually.

## Project Structure

```
printforge/
├── apps/api/          # NestJS backend (REST API)
├── apps/app/          # Next.js frontend
├── packages/types/    # Shared TypeScript types
├── docker/            # Docker configs
├── scripts/           # Utility scripts
└── docs/              # Documentation
```

### Workspace Commands

```bash
# Run API dev server
npm run dev --workspace=@printforge/api

# Run frontend dev server
npm run dev --workspace=@printforge/app

# Build everything
npm run build --workspaces

# Lint API
npm run lint --workspace=@printforge/api
```

## Development Guidelines

### Code Style

- **TypeScript** everywhere -- no `any` unless interfacing with external untyped data
- **NestJS conventions** -- module/controller/service pattern for all API features
- **React server components** by default in Next.js -- use `'use client'` only when needed
- **Tailwind CSS** for styling -- no CSS modules or styled-components

### Adding a New API Module

1. Create a folder under `apps/api/src/your-module/`
2. Create files: `your-module.module.ts`, `your-module.controller.ts`, `your-module.service.ts`
3. Add DTOs to `packages/types/src/index.ts`
4. Register the module in `apps/api/src/app.module.ts`
5. Add Prisma models if needed in `apps/api/prisma/schema.prisma`

### Adding a New Frontend Page

1. Create `apps/app/src/app/(dashboard)/your-page/page.tsx`
2. Add navigation entry in `apps/app/src/components/sidebar.tsx`
3. Use existing UI components from `apps/app/src/components/ui/`

### Database Changes

```bash
# Edit the schema
# apps/api/prisma/schema.prisma

# Push changes (development)
cd apps/api && npx prisma db push

# Create a migration (production)
cd apps/api && npx prisma migrate dev --name describe_your_change
```

### Key Conventions

- **Authentication**: JWT in httpOnly cookie. All API routes use `@UseGuards(JwtAuthGuard)`
- **Authorization**: `@UseGuards(RolesGuard)` + `@Roles('ADMIN', 'OPERATOR')` decorators
- **Pagination**: Use `PaginationDto` from `common/dto/pagination.dto.ts`
- **Number generation**: Use `generateNumber()` for sequential IDs (QT-001, ORD-001, etc.)
- **Currency**: Always OMR (Omani Rial) -- displayed to 3 decimal places
- **Passwords**: `bcryptjs` only (not `bcrypt` -- native bindings break in Docker)
- **Docker base**: `node:20-slim` (not Alpine -- Prisma binary issues)

## Submitting Changes

### Branch Naming

- `feature/description` -- new features
- `fix/description` -- bug fixes
- `docs/description` -- documentation only

### Pull Request Process

1. Fork the repo and create your branch from `main`
2. Make your changes with clear, focused commits
3. Ensure Docker build succeeds: `docker compose build`
4. Open a PR with:
   - Clear title (under 70 characters)
   - Description of what changed and why
   - Test plan (how to verify)

### Commit Messages

Use clear, imperative-tense messages:

```
Add multi-color cost estimation endpoint
Fix spool weight deduction on job completion
Update invoice PDF layout with logo support
```

## Reporting Issues

Use GitHub Issues. Include:

- Steps to reproduce
- Expected vs actual behavior
- Docker logs if relevant (`docker compose logs api --tail 50`)
- Browser console errors for frontend issues

## Architecture Decisions

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reasoning behind key technical choices.

# PrintForge — Project Handoff Document

> Last updated: 2026-04-13 | Current version: **v2.9**

---

## What is PrintForge?

A Docker-based ERP system purpose-built for small B2C 3D print farms. Built by Munther, who runs a Creality-based print farm in Oman (OMR currency). Replaces a previous tool called FilaOps with a cleaner architecture, better operational tooling, and multicolor printing support.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Backend API | NestJS (TypeScript), Prisma ORM, PostgreSQL |
| Frontend | Next.js 14 (App Router), Tailwind CSS, shadcn/ui-style components |
| Shared Types | `@printforge/types` monorepo package at `packages/types/` |
| Auth | JWT dual-auth (staff + customer portal), role-based (ADMIN, OPERATOR, VIEWER) |
| Real-time | Socket.IO gateway at `/ws` (exists but frontend doesn't consume it yet) |
| Printer Bridge | Moonraker REST API polling every 10s, SSRF-protected |
| Deployment | Docker Compose (nginx reverse proxy + postgres + api + app), deployed on home Linux VPS |
| Tests | Jest + ts-jest, 44 tests across 3 suites |

## Monorepo Structure

```
apps/
  api/                    # NestJS backend
    prisma/schema.prisma  # THE source of truth for all models
    src/
      auth/               # JWT guards, staff + customer auth
      common/             # Prisma service, pagination, CSV export utils
      costing/            # Cost engine (material + machine + waste + markup)
      export/             # 6 CSV export endpoints
      file-parser/        # G-code parser (multi-slicer, multicolor)
      moonraker-bridge/   # Printer polling, status sync, auto-job-complete
      printers/           # CRUD + maintenance service
      production/         # Jobs CRUD + planning + auto-assign + fail/reprint
      products/           # Products, BOM, G-code onboarding, ComponentMaterial
      orders/             # Orders, material availability
      websocket/          # Socket.IO gateway (events.gateway.ts)
      settings/           # System settings + locale endpoint
      ...                 # customers, quotes, invoices, accounting, design, etc.
    jest.config.ts
  app/                    # Next.js frontend
    src/
      app/(dashboard)/    # All authenticated pages
      app/login/          # Customer login (default landing)
      app/staff-login/    # Staff login
      components/ui/      # Shared UI components (card, button, dialog, table, etc.)
      lib/                # api.ts (fetch wrapper), utils.ts, locale-context.tsx
    public/
      manifest.json       # PWA manifest (exists, basic)
      icons/icon.svg      # App icon
      sw.js               # Service worker (exists, minimal)
packages/
  types/src/index.ts      # All shared DTOs, enums, interfaces
```

## Key Architecture Decisions

1. **ComponentMaterial join table** — Multicolor products use 1 component with N sub-materials (not N components). This affects BOM display, G-code onboarding, production planning, and spool selection.

2. **NestJS route ordering** — Static-prefix routes (`stats/failures`, `queue`, `plan/:orderId`, `components/:id`) MUST be defined BEFORE parameterized `:id` routes in controllers, or they get shadowed.

3. **Spool selection** — Production planner picks the spool with lowest weight that has >= required + 50g buffer. Falls back to spool with most stock.

4. **G-code onboarding** — Uploading a G-code to a product auto-creates BOM components. Multicolor G-codes create 1 component with N ComponentMaterials matched by hex color to named materials via RGB Euclidean distance.

5. **Types package** — After editing `packages/types/src/index.ts`, you MUST run `cd packages/types && npm run build` before the API/app can see the changes.

6. **Prisma workflow** — After editing `schema.prisma`, run `cd apps/api && npx prisma generate` locally. On the server, run `npx prisma db push` to apply.

---

## Version History (Highlights)

### v1.0 — Core ERP
Dashboard, quotes, orders, inventory, printers (Moonraker), costing engine, quick quote, customers, settings, JWT auth, Docker deployment.

### v2.0 — Multi-tool + Design + Customer Portal
Quick Quote v2 (multi-tool G-code, URL scraping from 6 sites), Design Center (10-status workflow), Customer Portal (self-signup, dual JWT), email notifications.

### v2.5 — Dark Mode + QR + OCR
Dark mode, role-based sidebar, PrintForge ID + QR labels, OCR spool scanner (Tesseract.js), product media/gallery, paywall detection.

### v2.6 — Production Hybrid Module
Stock-aware production planning (plan preview + create from plan), ComponentMaterial multicolor BOM, default printer per product, stock on hand, spool selection logic. Fixed component delete route shadowing, G-code upload error handling.

### v2.7 — Competitive Gaps (vs FilaOps)
Security hardening (Helmet CSP/HSTS, 3-tier rate limiting, stricter auth throttles), CSV export (6 endpoints with formula injection prevention), internationalization (LocaleProvider, multi-currency settings), test coverage (44 tests: CSV, costing, G-code parser).

### v2.9 — Real-time WebSocket + PWA (current)
1. **WebSocket frontend** — `useWebSocket()` hook (shared `socket.io-client`), WsNotifications component, live printer status on detail page replaces `setInterval` polling, job complete/fail events broadcast toasts. Socket.IO path: `/api/socket.io/` (routes via nginx `/api/` location).
2. **PWA** — Rewritten service worker (versioned, stale-while-revalidate), `InstallPrompt` component (`beforeinstallprompt`), `OfflineIndicator` (amber top bar), PNG icons (192 + 512), updated manifest.

### v2.8 — Operational Resilience
1. **Failed Print Tracking** — `POST /jobs/:id/fail` with reason + waste grams (auto-deducts from spools proportionally), `POST /jobs/:id/reprint` (clones as new QUEUED job linked via `reprintOfId`), `GET /jobs/stats/failures` (failure rate, total waste). UI: Mark Failed dialog, failure info card, Reprint button, stats on production page.

2. **Machine Maintenance** — `MaintenanceLog` model (SCHEDULED/UNSCHEDULED/CALIBRATION), `POST /printers/:id/maintenance` (sets status to MAINTENANCE), complete workflow restores to IDLE + sets next due date. Printer tracks `totalPrintHours` (accumulated on job complete), `maintenanceIntervalHours`, `nextMaintenanceDue`. UI: start/complete buttons, interval settings, history table, overdue badges on printer list.

3. **Job Scheduling / Auto-distribution** — `POST /jobs/auto-assign` distributes unassigned QUEUED jobs: prefers product's default printer, load-balances by fewest active jobs, excludes MAINTENANCE/ERROR/OFFLINE printers. `GET /jobs/queue` returns per-printer queue + unassigned bucket. UI: Auto-Assign button, List/Queue view toggle.

---

## What's Left To Do

### Medium-term (v3.0+) — PrintForge-specific Gaps vs FilaOps

These were identified in a detailed comparison. The 4 quick wins (security, CSV, i18n, tests) and 3 joint weaknesses (failed prints, maintenance, scheduling) are done. Remaining PrintForge gaps:

| Priority | Feature | Notes |
|----------|---------|-------|
| **High** | Purchasing / Vendor Management | Vendor model, purchase orders (DRAFT->ORDERED->RECEIVED), quick reorder from low stock |
| **High** | MRP / Auto-reorder | On order confirm, calculate material demand vs stock, generate suggested purchase orders |
| **Medium** | Product Variants | Variant matrix to bulk-create color/material variants from a base product |
| **Medium** | Tax Management | Named tax rates table, auto-applied per customer/region |
| **Medium** | Accounting (basic COGS) | COGS tracking on job completion, expense categories, basic journal entries |
| **Low-Med** | Close-Short / Partial Fulfillment | Mark orders partially fulfilled |
| **Low** | Packing Slips | PDF generation from order |

### Also mentioned by user for future
- Creality Cloud LAN WebSocket integration (from v2 comments)
- WhatsApp invoice sharing improvements
- Email/WhatsApp notifications expansion

---

## Development Notes

- **Don't ask permission to read/write files** — user has granted full file privileges
- **Currency is OMR** (Omani Rial) — 3 decimal places, locale en-GB
- **Trust root-cause fixes** — don't reject heavyweight fixes when lightweight patches only treat symptoms
- **Maintain CHANGELOG.md** — suggest version bumps on major changes
- **bcryptjs** not bcrypt (no native deps), **node-slim** not Alpine for Docker
- **Forward-slash paths in zip files** — Windows backslashes break extraction
- **Nginx proxy rules** — all routes go through nginx on :80
- **`--legacy-peer-deps`** may be needed for npm install due to @nestjs/testing peer conflicts

---

## How to Run

```bash
# Install
npm install --legacy-peer-deps

# Build types (required after editing packages/types)
cd packages/types && npm run build && cd ../..

# Generate Prisma client (required after schema changes)
cd apps/api && npx prisma generate

# Run API (dev)
cd apps/api && npm run start:dev

# Run Frontend (dev)
cd apps/app && npm run dev

# Run tests
cd apps/api && npx jest --no-coverage

# Docker (production)
docker compose up -d

# Apply schema changes to production DB
cd apps/api && npx prisma db push
```

---

## Key Files Quick Reference

| What | Path |
|------|------|
| Prisma schema | `apps/api/prisma/schema.prisma` |
| Shared types | `packages/types/src/index.ts` |
| API entry | `apps/api/src/main.ts` |
| Module registry | `apps/api/src/app.module.ts` |
| Production jobs | `apps/api/src/production/jobs.service.ts` |
| G-code parser | `apps/api/src/file-parser/gcode-parser.service.ts` |
| Products/BOM | `apps/api/src/products/products.service.ts` |
| Costing engine | `apps/api/src/costing/costing.service.ts` |
| Maintenance | `apps/api/src/printers/maintenance.service.ts` |
| WebSocket gateway | `apps/api/src/websocket/events.gateway.ts` |
| Moonraker bridge | `apps/api/src/moonraker-bridge/moonraker.service.ts` |
| Frontend API wrapper | `apps/app/src/lib/api.ts` |
| Locale context | `apps/app/src/lib/locale-context.tsx` |
| App layout | `apps/app/src/app/layout.tsx` |
| Dashboard | `apps/app/src/app/(dashboard)/page.tsx` |
| PWA manifest | `apps/app/public/manifest.json` |
| Changelog | `CHANGELOG.md` |

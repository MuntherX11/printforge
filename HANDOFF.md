# PrintForge — Project Handoff Document

> Last updated: 2026-04-14 | Current version: **v3.1**

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
| Real-time | Socket.IO gateway at `/ws`, path `/api/socket.io/`, shared hook `useWebSocket()` |
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
      accounting/         # Reports service (monthly trend, product margins, expenses)
      settings/           # System settings + locale endpoint
      ...                 # customers, quotes, invoices, design, etc.
    jest.config.ts
  app/                    # Next.js frontend
    src/
      app/(dashboard)/    # All authenticated pages
      app/login/          # Customer login (default landing)
      app/staff-login/    # Staff login
      components/ui/      # Shared UI components (card, button, dialog, table, etc.)
      lib/                # api.ts (fetch wrapper), utils.ts, locale-context.tsx
    public/
      manifest.json       # PWA manifest (192 + 512 PNG icons, maskable)
      icons/icon.svg      # App icon
      sw.js               # Service worker (versioned, stale-while-revalidate)
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

7. **calculateCost for multicolor** — Multicolor components have `materialId = null`. Do NOT call `estimateFromParams()` on them (crashes). Instead call `calculateJobCost()` directly with averaged `costPerGram` from sub-materials.

8. **Production job creation** — Backend requires at least one of `orderId` or `productId`. Frontend shows a mode-selector screen (For Order / Build Stock) before the form fields.

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

### v2.8 — Operational Resilience
1. **Failed Print Tracking** — `POST /jobs/:id/fail` with reason + waste grams (auto-deducts from spools proportionally), `POST /jobs/:id/reprint` (clones as new QUEUED job linked via `reprintOfId`), `GET /jobs/stats/failures`. UI: Mark Failed dialog, failure info card, Reprint button, stats on production page.
2. **Machine Maintenance** — `MaintenanceLog` model, maintenance workflow (start → complete), printer tracks `totalPrintHours`, `nextMaintenanceDue`. UI: start/complete buttons, interval settings, history table, overdue badges.
3. **Job Scheduling / Auto-distribution** — `POST /jobs/auto-assign` + `GET /jobs/queue`. UI: Auto-Assign button, List/Queue view toggle.

### v2.9 — Real-time WebSocket + PWA
1. **WebSocket frontend** — `useWebSocket()` hook (shared `socket.io-client` singleton), `WsNotifications` component, live printer status replaces polling. Socket.IO path: `/api/socket.io/`.
2. **PWA** — Rewritten service worker (versioned, stale-while-revalidate), `InstallPrompt` (`beforeinstallprompt`), `OfflineIndicator` (amber top bar), PNG icons, updated manifest.

### v3.0 — COGS + Accounting
1. **COGS auto-tracking** — `completeJob()` auto-calls `calculateCost()` so every completed job records material/machine/waste/overhead costs.
2. **Accounting page** — 6 KPI cards, 6-month recharts BarChart (revenue/COGS/grossProfit), P&L summary, product margins table with color-coded badges.
3. **Expenses** — Category pills, add/delete expenses, total row.
4. **Reports endpoints** — `GET /reports/monthly-trend?months=N`, `GET /reports/product-margins`.
5. **Quote expiry scheduler** — `@Cron(EVERY_DAY_AT_MIDNIGHT)` auto-expires old quotes; `convertToOrder()` blocks on expired quotes.
6. **Invoice PAID flow** — Auto-sets `paidAt`, increments `order.paidAmount`, guards on null `orderId`.

### v3.1 — UX Audit + Logic Fixes (current)
1. **calculateCost multicolor fix** — Products with multicolor components (null `materialId`) no longer crash; uses `calculateJobCost` with averaged sub-material costPerGram.
2. **Production job cancel** — "Cancel Job" button on job detail page with confirmation Dialog; Reprint `confirm()` replaced with Dialog.
3. **New job form redesign** — Mode selector (For Order / Build Stock) forces linking to an order or product; backend enforces this too.
4. **Empty states** — Orders page and Quotes page show icon + message when list is empty (filter-aware on Orders).
5. **Reject customer Dialog** — Replaced `confirm()` with Dialog showing customer name; Approve/Reject buttons have per-row loading states.
6. **Loading states** — Mark Failed and Create Reprint buttons show loading text + disabled during submission.
7. **New quote validation** — Blocks submit if no item has a description.
8. **Global toast cleanup** — All 13 frontend pages had `alert()` replaced with `toast()`.
9. **expenses/page.tsx** — Fixed TypeScript build error: shadcn `TableCell` doesn't forward `colSpan`; replaced with native `<td>`.

---

## Pending Issues (from last audit — not yet fixed)

### Frontend
| File | Issue |
|------|-------|
| `accounting/expenses/page.tsx:70` | `confirm()` on expense delete — replace with Dialog |
| `products/[id]/page.tsx` (×3 places) | `confirm()` on delete product + remove component — replace with Dialog |
| `printers/[id]/page.tsx` | `confirm()` on printer delete — replace with Dialog |
| `quotes/[id]/page.tsx` | `updateStatus()` has no try/catch; "Convert to Order" button has no loading/disabled state |
| `accounting/page.tsx` | Load failure swallowed with `console.error` only — show user toast |
| `orders/[id]/page.tsx` | `order.productionJobs` accessed without null guard; "Create Invoice" has no loading state |
| `accounting/page.tsx` | `report.expensesByCategory` accessed without null check before `Object.entries()` |
| `inventory/page.tsx` | `m.spools.reduce()` — no null guard on `spools` array |

### Backend
| File | Issue |
|------|-------|
| `expenses.service.ts` | `update()` has no existence check — throws Prisma 500 instead of 404 |
| `jobs.service.ts` + `orders.service.ts` | Status filter uses `as any` cast — invalid enum values reach DB silently |
| `jobs.service.ts create()` | Validates orderId/productId are provided but doesn't verify they exist in DB |

---

## Development Notes

- **Don't ask permission to read/write files** — user has granted full file privileges
- **Currency is OMR** (Omani Rial) — 3 decimal places, locale en-GB
- **Trust root-cause fixes** — don't reject heavyweight fixes when lightweight patches only treat symptoms
- **Maintain CHANGELOG.md** — suggest version bumps on major changes
- **bcryptjs** not bcrypt (no native deps), **node-slim** not Alpine for Docker
- **Forward-slash paths in zip files** — Windows backslashes break extraction
- **Nginx proxy rules** — all routes go through nginx on :80
- **`--legacy-peer-deps`** required for npm install (`@nestjs/testing` peer conflict)
- **shadcn TableCell** does not forward `colSpan` — use native `<td>` for colspan rows

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
| Accounting reports | `apps/api/src/accounting/reports.service.ts` |
| Frontend API wrapper | `apps/app/src/lib/api.ts` |
| WebSocket hook | `apps/app/src/lib/use-websocket.ts` |
| Locale context | `apps/app/src/lib/locale-context.tsx` |
| App layout | `apps/app/src/app/layout.tsx` |
| Dashboard | `apps/app/src/app/(dashboard)/page.tsx` |
| PWA manifest | `apps/app/public/manifest.json` |
| Service worker | `apps/app/public/sw.js` |
| Changelog | `CHANGELOG.md` |

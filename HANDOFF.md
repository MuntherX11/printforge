# PrintForge — Project Handoff Document

> Last updated: 2026-04-16 | Current version: **v2.10.3**

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
| Printer Bridge | Moonraker REST API polling every 10s, SSRF-protected (local IPs + Tailscale CGNAT) |
| Deployment | Docker Compose (nginx reverse proxy + postgres + api + app), deployed on home Linux VPS |
| Tests | Jest + ts-jest, 44 tests across 3 suites |
| Code Review | Gemini CLI v0.37.2 as second reviewer (daily limit resets 2am Asia/Dubai) |

## Monorepo Structure

```
apps/
  api/                    # NestJS backend
    prisma/schema.prisma  # THE source of truth for all models
    src/
      auth/               # JWT guards, staff + customer auth
      common/             # Prisma service, pagination, CSV export utils
      costing/            # Cost engine (material + machine + waste + markup)
                          #   estimatePlates() — 3MF per-plate costing
      export/             # 6 CSV export endpoints
      file-parser/        # G-code parser (multi-slicer, multicolor)
                          #   ThreeMfParserService — unzips .3mf, parses plates + thumbnails
      moonraker-bridge/   # Printer polling, status sync, auto-job-complete
                          #   validateMoonrakerUrl() — SSRF guard, allows Tailscale CGNAT
      printers/           # CRUD + maintenance service
      production/         # Jobs CRUD + planning + auto-assign + fail/reprint
      products/           # Products, BOM, G-code onboarding, ComponentMaterial
                          #   onboardFromThreeMf() — creates components from selected plates
      orders/             # Orders, material availability
      websocket/          # Socket.IO gateway (events.gateway.ts)
      accounting/         # Reports service (monthly trend, product margins, expenses)
      settings/           # System settings + locale endpoint
      ...                 # customers, quotes, invoices, design, etc.
    jest.config.ts
  app/                    # Next.js frontend
    src/
      app/(dashboard)/    # All authenticated staff pages
        quick-quote/      # Staff quick quote — accepts .gcode/.stl/.3mf
        products/[id]/
          PlatePreviewCard.tsx      # Reusable plate card (export default)
          ThreeMfImportWizard.tsx   # 3MF import wizard for products (named export)
      app/(customer)/     # Customer portal pages
        dashboard/quick-quote/  # Customer quick quote — accepts .gcode/.stl/.3mf
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

9. **Tailscale CGNAT** — `validateMoonrakerUrl()` in `moonraker.service.ts` allows `100.64.0.0/10` (100.64.x.x–100.127.x.x) alongside local IPs and `.local` hostnames. Local IPs still work — Tailscale support is purely additive.

10. **3MF plate costing** — `POST /costing/estimate-plates` accepts an array of `PlateEstimateInput` objects. Per-plate material cost is resolved by `materialType` from inventory (cheapest match in one pre-fetched query), falling back to `defaultMaterialId`. All plates costed in parallel with `Promise.all`. Both staff and customer JWTs pass `JwtAuthGuard`.

11. **PlatePreviewCard import path** — `PlatePreviewCard` lives at `products/[id]/PlatePreviewCard.tsx` and uses `export default`. Importing it from `quick-quote/page.tsx` via `'../products/[id]/PlatePreviewCard'` is valid — Next.js App Router and TypeScript both treat bracket directory names as filesystem literals.

12. **api.ts upload errors** — `api.upload()` reads the backend JSON error body on failure (same pattern as `request()`). This means 3MF parser errors, gcode parse errors, and any other upload failures surface the actual backend message to the user.

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

### v2.10 — COGS + Accounting
1. **COGS auto-tracking** — `completeJob()` auto-calls `calculateCost()` so every completed job records material/machine/waste/overhead costs.
2. **Accounting page** — 6 KPI cards, 6-month recharts BarChart (revenue/COGS/grossProfit), P&L summary, product margins table with color-coded badges.
3. **Expenses** — Category pills, add/delete expenses, total row.
4. **Reports endpoints** — `GET /reports/monthly-trend?months=N`, `GET /reports/product-margins`.
5. **Quote expiry scheduler** — `@Cron(EVERY_DAY_AT_MIDNIGHT)` auto-expires old quotes; `convertToOrder()` blocks on expired quotes.
6. **Invoice PAID flow** — Auto-sets `paidAt`, increments `order.paidAmount`, guards on null `orderId`.

### v2.10.1 — UX Audit + Logic Fixes
1. **calculateCost multicolor fix** — Products with multicolor components (null `materialId`) no longer crash; uses `calculateJobCost` with averaged sub-material costPerGram.
2. **Production job cancel** — "Cancel Job" button on job detail page with confirmation Dialog.
3. **New job form redesign** — Mode selector (For Order / Build Stock) forces linking to an order or product.
4. **Empty states** — Orders and Quotes pages show icon + message when list is empty.
5. **Global toast cleanup** — All 13 frontend pages had `alert()` replaced with `toast()`.

### v2.10.2 — Backend Stability + UX Hardening
1. **Existence checks** — `ExpensesService` and `JobsService` now return 404 instead of Prisma 500 for missing records.
2. **Strict enum validation** — Status filters in `QuotesService`, `OrdersService`, `JobsService` — removed `as any` casts.
3. **Linked entity verification** — `orderId`/`productId` are verified to exist in DB during job creation.
4. **Dialog replacements** — Native `confirm()` replaced with shadcn Dialog across 6 pages (Expenses, Products, Printers, Inventory, Locations, Customer Quotes).
5. **Loading/disabled states** — All critical action buttons (Convert to Order, Create Invoice, Delete) prevent double-submissions.
6. **Null guards** — `productionJobs`, `invoices`, `expensesByCategory` array accesses guarded throughout dashboard.

### v2.9.10 — Targeted Fixes + Tailscale
1. **calculateCost crash** — Null-materialId + empty sub-materials components no longer crash Prisma; machine cost is still calculated.
2. **purgeWasteGrams fix** — `calculateJobCost()` now respects recorded `purgeWasteGrams` from job data (priority: gcode-parsed volume → job-recorded waste → settings × color changes).
3. **Tailscale CGNAT** — `validateMoonrakerUrl()` allows `100.64.0.0/10` for remote printers over Tailscale. Printer detail form shows URL format hint.

### v2.10.3 — 3MF → Quick Quote Integration (current)
1. **`POST /costing/estimate-plates`** — New endpoint + `estimatePlates()` in `CostingService`. Resolves material cost by `materialType` from inventory (cheapest match), falls back to `defaultMaterialId`. All plates costed in parallel.
2. **Staff Quick Quote** — Accepts `.3mf`; auto-parses on select; shows `PlatePreviewCard` grid with thumbnails + stats; per-plate cost breakdown + grand total; saves as multi-item quote (one item per plate).
3. **Customer Quick Quote** — Accepts `.3mf`; simple plate checklist; shows total price; "Request This Quote" CTA → confirmation banner (added to gcode/stl flow too).
4. **`api.ts` upload error fix** — `api.upload()` now reads backend JSON error body on failure; callers see the actual message instead of generic "Upload failed".
5. **Gemini review fixes** — Single-tool plates now resolve `materialType` correctly (was falling back to default always); `file?.name` guarded with `?? 'project.3mf'` fallback; duplicate `formatTimeSec` removed from customer page.

---

## Known Gaps / Deferred (as of v2.10.3)

| Area | Gap | Notes |
|------|-----|-------|
| `estimate-plates` | No rate limiting | A customer could send a large plate array. Add NestJS `ThrottlerGuard` to costing endpoints. |
| `estimate-plates` | Luminance-aware purge not used | `calculateTransitionPurge` from `estimateMultiColor` isn't applied for 3MF plates — uses simple average purge instead. Minor accuracy gap for high-contrast multicolor plates. |
| Customer Quick Quote | "Request Quote" is UI-only | Button shows a green banner but does NOT write to DB or notify staff. Needs a `POST /quote-requests` endpoint and staff notification. |
| Products service | God file (774 lines) | Mixing costing, BOM, inventory, 3MF onboarding. Consider splitting into `ProductCostingService` + `ProductInventoryService`. |
| Jobs service | God file (617 lines) | Similar concern — depends on `CostingService`. |
| `PrismaService` | No resilience layer | 37 services share one Prisma instance with no retry, timeout override, or slow-query logging. |

---

## Development Notes

- **Don't ask permission to read/write files** — user has granted full file privileges
- **Currency is OMR** (Omani Rial) — 3 decimal places, locale en-GB
- **Trust root-cause fixes** — don't reject heavyweight fixes when lightweight patches only treat symptoms
- **Maintain CHANGELOG.md** — suggest version bumps on major changes
- **Gemini CLI** — used as second reviewer post-implementation. Run with `cat files... | gemini -p "review prompt"`. Daily limit resets 2am Asia/Dubai. Test availability with `echo "ping" | gemini`.
- **bcryptjs** not bcrypt (no native deps), **node-slim** not Alpine for Docker
- **Forward-slash paths in zip files** — Windows backslashes break extraction
- **Nginx proxy rules** — all routes go through nginx on :80
- **`--legacy-peer-deps`** required for npm install (`@nestjs/testing` peer conflict)
- **shadcn TableCell** does not forward `colSpan` — use native `<td>` for colspan rows
- **`useToast()` signature** is `toast(type, message)` — NOT shadcn standard. 57 files import it.

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
| 3MF parser | `apps/api/src/file-parser/threemf-parser.service.ts` |
| File parser controller | `apps/api/src/file-parser/file-parser.controller.ts` |
| Products/BOM | `apps/api/src/products/products.service.ts` |
| Costing engine | `apps/api/src/costing/costing.service.ts` |
| Maintenance | `apps/api/src/printers/maintenance.service.ts` |
| Moonraker bridge | `apps/api/src/moonraker-bridge/moonraker.service.ts` |
| WebSocket gateway | `apps/api/src/websocket/events.gateway.ts` |
| Accounting reports | `apps/api/src/accounting/reports.service.ts` |
| Frontend API wrapper | `apps/app/src/lib/api.ts` |
| WebSocket hook | `apps/app/src/lib/use-websocket.ts` |
| Locale context | `apps/app/src/lib/locale-context.tsx` |
| App layout | `apps/app/src/app/layout.tsx` |
| Dashboard | `apps/app/src/app/(dashboard)/page.tsx` |
| Staff Quick Quote | `apps/app/src/app/(dashboard)/quick-quote/page.tsx` |
| Customer Quick Quote | `apps/app/src/app/(customer)/dashboard/quick-quote/page.tsx` |
| Plate preview card | `apps/app/src/app/(dashboard)/products/[id]/PlatePreviewCard.tsx` |
| 3MF import wizard | `apps/app/src/app/(dashboard)/products/[id]/ThreeMfImportWizard.tsx` |
| PWA manifest | `apps/app/public/manifest.json` |
| Service worker | `apps/app/public/sw.js` |
| Changelog | `CHANGELOG.md` |

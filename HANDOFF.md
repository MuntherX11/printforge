# PrintForge — Project Handoff Document

> Last updated: 2026-04-18 | Current version: **v2.11.0**

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
| Auth | JWT dual-auth (staff + customer portal), role-based (ADMIN, ACCOUNTING, OPERATOR, VIEWER) |
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

10. **3MF plate costing** — `POST /costing/estimate-plates` accepts an array of `PlateEstimateInput` objects. Per-plate material cost is resolved by `materialType` from inventory (cheapest match in one pre-fetched query), falling back to `defaultMaterialId`. All plates costed in parallel with `Promise.all`. Both staff and customer JWTs pass `JwtAuthGuard`. Now utilizes luminance-aware purge averages for multicolor plates.

11. **Settings Cache** — `CostingService` implements a 30-second memory cache for `systemSetting` lookups. This prevents N+1 query bottlenecks when calculating costs for many items or plates in a single request.

12. **PlatePreviewCard import path** — `PlatePreviewCard` lives at `products/[id]/PlatePreviewCard.tsx` and uses `export default`. Importing it from `quick-quote/page.tsx` via `'../products/[id]/PlatePreviewCard'` is valid — Next.js App Router and TypeScript both treat bracket directory names as filesystem literals.

13. **Customer quote request security** — `POST /quotes/customer/request` accepts client-side price estimates (which the costing engine already calculated server-side and sent to the customer). Quotes are created as DRAFT status and require staff to change status to SENT before the customer can accept/redeem. Staff review is the guard against manipulated prices.

14. **api.upload() error handling** — `api.upload()` reads the backend JSON error body on failure. This means 3MF parser errors, G-code parse errors, and any other upload failures surface the actual backend message to the user instead of a generic "Upload failed".

15. **Products service split** — `ProductsService` delegates costing to `ProductCostingService` and onboarding to `ProductOnboardingService`. Neither new service injects `ProductsService` (no circular deps). `ProductCostingService` queries product data with a targeted Prisma query (excludes stock enrichment that only `findOne` needs for UI). All three registered in `ProductsModule`.

16. **Jobs service split** — `JobsService` delegates planning to `JobPlanningService` and scheduling to `JobSchedulingService`. `SPOOL_BUFFER_GRAMS = 50` lives in `job-planning.service.ts`. `JobsService` retains gateway injection for `completeJob`/`failJob` notifications. All four registered in `ProductionModule`.

17. **Creality LAN WebSocket** — `CrealityWsService` opens a persistent `ws://IP:9999` per `CREALITY_WS` printer on module init. Protocol is push-based (no polling); service sends a heartbeat every 10s and parses the pushed JSON. Reconnects with exponential backoff (2s → 120s, 1.8×). The printer's IP is stored in the existing `moonrakerUrl` field. `MoonrakerScheduler` merges snapshots from both bridges every 10s before broadcasting. `controlPrint` routes `pause/resume/cancel` to the correct bridge via `connectionType`. Reference implementation: [`ha_creality_ws`](https://github.com/3dg1luk43/ha_creality_ws).

18. **ACCOUNTING role** — Added to `Role` enum. Sidebar nav: Dashboard + Orders + Quotes + Customers + Accounting. No access to Quick Quote, Production, Design, Filaments, Products, Printers, Settings.

19. **Currency context** — `LocaleProvider` wraps the entire `(dashboard)` layout.

20. **Customer communications** — `CommunicationsModule` exports `EmailService`, `EmailNotificationService`, `WhatsAppService`. All three are injected with `@Optional()` into `QuotesService`, `OrdersService`, and `JobsService` to avoid circular dependencies. Notifications only fire when the relevant `notify_*` system setting is not `'false'`. SMTP config lives in `smtp_*` settings; WhatsApp in `whatsapp_token`, `whatsapp_phone_id`, `whatsapp_enabled`. Test endpoints at `POST /communications/test-email` and `POST /communications/test-whatsapp` (ADMIN only). `useFormatCurrency()` from `locale-context.tsx` replaces hardcoded `formatCurrency(amount)` calls on the dashboard — currency setting now propagates live.

---

## Version History (Highlights)

### v2.11.0 — Customer Notifications (Email + WhatsApp) (current)
1. **`WhatsAppService`** — Meta Cloud API, `ws://phone_id/messages`, silent fallback when not configured.
2. **Lifecycle hooks** — Quote SENT, Order CONFIRMED/IN_PRODUCTION/READY, all-jobs-completed all fire email + WhatsApp.
3. **4 new email templates** — quote sent, order confirmed, order ready, all built off existing `EmailNotificationService` base.
4. **Notification toggles** — Per-event checkboxes in Settings, default all on. Services read the toggle before firing.
5. **Test endpoints** — `POST /communications/test-email` + `POST /communications/test-whatsapp` with inline test buttons in settings UI.
6. **Creality IP hot-reload** — `POST /moonraker/reconnect/:id` endpoint + auto-called from printer detail save.
7. **Settings native select sweep** — Locale and Date Format fields use `Select` component.

### v2.10.8 — Creality LAN + ACCOUNTING Role + Currency Fix
1. **Creality LAN WS bridge** — `CrealityWsService` with persistent WS, heartbeat, exponential backoff reconnect. Both printer types broadcast through the same scheduler. Control endpoint routes by `connectionType`.
2. **`CREALITY_WS` enum value** — Printer form shows "Printer IP Address" field for this type. Live Status card works for both Moonraker and Creality.
3. **`ACCOUNTING` role** — New schema role. Sidebar shows Quotes + Customers + Accounting only (no ops pages).
4. **Currency context** — `LocaleProvider` in dashboard layout. Dashboard KPIs use `useFormatCurrency()` — no more hardcoded OMR.
5. **404 fix** — `controlPrint` now throws proper `NotFoundException` for unknown printer IDs.

### v2.10.7 — God File Splits + Resilience
1. **Products service split** — `ProductCostingService` + `ProductOnboardingService` extracted. No circular deps. `ProductsService` now ~220 lines.
2. **Jobs service split** — `JobPlanningService` + `JobSchedulingService` extracted. `JobsService` now delegates plan/schedule and retains gateway calls.
3. **Staff notification on quote request** — WebSocket `info` push to staff when customer submits a quote request.
4. **`use-line-items` hook** — Shared hook eliminates ~80 lines of duplication between `orders/new` and `quotes/new`.
5. **Native selects replaced** — `orders/new` and `quotes/new` use `Select` component with dark mode support.
6. **Customer dashboard Design Requests** — Wired to `GET /design-projects/customer/my-projects?limit=3`. Shows title and status.
7. **`createFromAnalysis` tax fix** — Now fetches `tax_rate` from system settings (was `0`).
8. **PrismaService resilience** — Query timeout (10s → 503), slow-query logging (>500ms), retry-connect (3× with 1s delay).

### v2.10.6 — UI Consistency + Customer Quote Request
1. **`POST /quotes/customer/request`** — New customer endpoint persists quick-quote results as DRAFT. Handles non-3MF (single item) and 3MF (one item per plate). Tax from system settings. DTO validated with `class-validator`.
2. **Customer Quick Quote real DB write** — "Request This Quote" button calls the endpoint, shows loading/error, surfaces backend failures.
3. **Customer dashboard real data** — My Quotes card shows 3 most recent quotes (number, status, total) from `GET /quotes/customer/my-quotes`.
4. **Dark mode h1 sweep** — Added `dark:text-gray-100` to 5 staff pages (orders/[id], customers, quotes, design, printers) and customer dashboard.
5. **EmptyState consistency** — Replaced raw div empty states on inventory, products, and printers pages with `<EmptyState>` (printers also gets an "Add Printer" action).

### v2.10.5 — UI Polish & Redesign Trial
1. **Sidebar skeleton** — `useState<string | null>(null)` sentinel: sidebar shows 7 animated placeholder bars while `/auth/me` resolves instead of flashing empty.
2. **Orders stale data fix** — `setData(null)` + `setLoading(true)` moved into the `useEffect`; filter changes now clear stale rows immediately before new data arrives.
3. **Production empty state** — List view renders `EmptyState` with context-aware description when a filter returns zero jobs (was silently showing an empty table with headers).
4. **h1 dark mode** — Added `dark:text-gray-100` to the Orders page h1 (was missing; Production already had it).
5. **Gemini component review (post-hoc)** — Verified all 8 Gemini-written files from the dark mode + accessibility pass: `dialog.tsx`, `input.tsx`, `select.tsx`, `toast.tsx`, `button.tsx`, `table.tsx`, `utils.ts`, `empty-state.tsx` — all confirmed correct.
6. **Redesign trial branch** — `worktree-agent-add3e32e` contains a full "Warm Precision" visual redesign (orange brand, Syne display font, DM Mono for numbers, dark navy sidebar, warm-50 page background, left-border status badges). Run on port 3001 to preview without touching main.

### v2.10.4 — Costing Performance & Accuracy
1. **Settings Cache** — Added 30s TTL cache for system settings in `CostingService` to eliminate N+1 queries during parallel plate/component costing.
2. **3MF Luminance-Aware Purge** — `estimatePlates` now calculates the average transition purge between all used tools on a plate (dark→light vs light→dark), significantly improving 3MF cost accuracy.
3. **Regression Tests** — New test suite for `estimatePlates` verifying multicolor waste logic and cache efficiency.

### v2.10.3 — 3MF → Quick Quote Integration
1. **`POST /costing/estimate-plates`** — New endpoint + `estimatePlates()` in `CostingService`. Resolves material cost by `materialType` from inventory (cheapest match), falls back to `defaultMaterialId`. All plates costed in parallel.
2. **Staff Quick Quote** — Accepts `.3mf`; auto-parses on select; shows `PlatePreviewCard` grid with thumbnails + stats; per-plate cost breakdown + grand total; saves as multi-item quote (one item per plate).
3. **Customer Quick Quote** — Accepts `.3mf`; simple plate checklist; shows total price; "Request This Quote" CTA → confirmation banner (added to gcode/stl flow too).
4. **`api.ts` upload error fix** — `api.upload()` now reads backend JSON error body on failure; callers see the actual message instead of generic "Upload failed".
5. **Gemini review fixes** — Single-tool plates now resolve `materialType` correctly (was falling back to default always); `file?.name` guarded with `?? 'project.3mf'` fallback; duplicate `formatTimeSec` removed from customer page.

### v1.0 — Core ERP
Dashboard, quotes, orders, inventory, printers (Moonraker), costing engine, quick quote, customers, settings, JWT auth, Docker deployment.

... [rest of previous versions truncated for brevity, same as before] ...

---

## Known Gaps / Deferred (as of v2.11.0)

| Area | Gap | Notes |
|------|-----|-------|
| WhatsApp templates | Free-form messages only work within 24h customer service window | For proactive outbound notifications, create Message Templates in Meta Business Manager and switch the payload `type` to `template` in `WhatsAppService.sendMessage()`. |
| UI audit | Customer quick-quote page may still have native `<select>` | Check `apps/app/src/app/(customer)/dashboard/quick-quote/page.tsx` — settings page is resolved. |
| Redesign trial | Not merged | `worktree-agent-add3e32e` branch has full Warm Precision theme. Merge when approved: `git merge worktree-agent-add3e32e`. |

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
- **Redesign trial** — branch `worktree-agent-add3e32e` at `.claude/worktrees/agent-add3e32e/`. Run `npm run dev -- --port 3001` from that directory to preview. Merge with `git merge worktree-agent-add3e32e` when approved, or delete with `git worktree remove` + `git branch -d`.
- **Cross-review rule** — when Gemini writes code, Claude reviews before writing to disk (and vice versa). Never skip this step.

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

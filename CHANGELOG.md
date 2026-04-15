# Changelog

All notable changes to PrintForge are documented here.

## [v2.10.3] — 2026-04-16 (current)

### Added
- **3MF → Quick Quote integration** — Staff and customer Quick Quote pages now accept `.3mf` files (OrcaSlicer project files). Uploading a `.3mf` auto-parses it, shows all plates with thumbnails/stats for selection, then estimates cost per plate via the new `POST /costing/estimate-plates` endpoint. Staff get full per-plate breakdown cards + grand total + save as multi-item quote (one item per plate). Customers get a simpler plate checklist + total price view.
- **`POST /costing/estimate-plates`** — New backend endpoint that costs one or more 3MF plates in a single call. Single-color plates use the default material; multicolor plates auto-resolve `costPerGram` by `materialType` from the inventory DB (cheapest match), falling back to the default material. All plates priced in parallel with `Promise.all`.
- **`EstimatePlatesDto / EstimatePlatesResult / PlateCostResult`** — New types in `@printforge/types` for the plate costing API.

---

## [v2.9.10] — 2026-04-15

### Fixed
- **calculateCost crash for materialless components** — Components with `materialId = null` and no sub-materials (e.g. unassigned gcode imports) no longer crash Prisma. Machine time cost is still calculated; material cost is zero.
- **purgeWasteGrams ignored in cost calculation** — `calculateJobCost()` now respects recorded `purgeWasteGrams` from job data as a middle-priority fallback (gcode-parsed volume → job-recorded waste → settings × color changes).

### Added
- **Tailscale support for remote printers** — `validateMoonrakerUrl()` now allows Tailscale CGNAT range `100.64.0.0/10` (`100.64.x.x`–`100.127.x.x`), enabling printers at other locations to connect via a Tailscale overlay network. Printer detail form shows a hint about supported URL formats including Tailscale IPs.

---

## [v2.10.2] — 2026-04-14 (previous)

### Added
- **Backend Stability & Validation**
  - Existence checks (404) added to `ExpensesService` and `JobsService` to prevent Prisma internal errors.
  - Strict enum validation for status filters in `QuotesService`, `OrdersService`, and `JobsService`, removing unsafe `as any` casts.
  - Linked entity verification (`orderId`, `productId`) in production job creation.
- **UX Hardening (Frontend)**
  - Replaced all native `confirm()` and `prompt()` calls with shadcn `Dialog` components across 6 major pages (Expenses, Products, Printers, Inventory, Locations, Customer Quotes).
  - Added loading/disabled states to all critical action buttons (Convert to Order, Create Invoice, Delete actions) to prevent double-submissions.
  - Implemented `try/catch` error handling with `toast` notifications for all async operations.
- **Crash Prevention**
  - Added null-guards for array mappings (`productionJobs`, `invoices`, `expensesByCategory`) across the dashboard and detail pages.

## [v2.9] — 2026-04-13

### Added
- **Real-time WebSocket frontend** (Step 4)
  - `apps/app/src/lib/use-websocket.ts` — `useWebSocket()` hook backed by a shared `socket.io-client` instance; auto-reconnects, exposes `printerStatuses`, `jobProgress`, `lastNotification`, `connected`
  - Socket.IO server path set to `/api/socket.io/` so it routes through the existing nginx `/api/` proxy (no nginx changes needed)
  - Printer detail page now receives live Moonraker status via WebSocket events instead of `setInterval` polling every 10 s
  - `WsNotifications` component (mounted in root layout) surfaces `notification` WebSocket events as toasts
  - `completeJob` and `failJob` in `JobsService` now broadcast `notification` events to all connected clients (job name + reason in message)
  - `ProductionModule` imports `WebSocketModule` so `EventsGateway` can be injected into `JobsService`

- **PWA enhancements** (Step 5)
  - Service worker (`public/sw.js`) rewritten with versioned caches, stale-while-revalidate for static assets, proper offline fallback for API calls, font caching, and explicit Socket.IO bypass
  - `InstallPrompt` component — captures `beforeinstallprompt`, shows a fixed bottom install bar; dismissal persisted in localStorage
  - `OfflineIndicator` component — shows amber top bar whenever `navigator.onLine` is false
  - PNG icons generated (`public/icons/icon-192x192.png`, `public/icons/icon-512x512.png`) — blue circle with white inner block, RGBA with anti-aliased edges
  - `manifest.json` updated with all four PNG icon entries (192 + 512, `any` + `maskable` purpose)
  - `InstallPrompt`, `OfflineIndicator`, `WsNotifications` all mounted in root layout

### Changed
- `EventsGateway` path changed from default `/socket.io` to `/api/socket.io/` (aligns with NestJS global prefix so nginx routes correctly)
- `JobsService` constructor now accepts `@Optional() EventsGateway` — won't break if WebSocketModule is not in scope

## [v2.8] — 2026-04-11

### Added
- **Failed Print Tracking** — Full failure lifecycle for production jobs
  - `POST /jobs/:id/fail` — Mark job as failed with reason + waste grams, auto-deducts waste proportionally from assigned spools
  - `POST /jobs/:id/reprint` ��� Clone failed job into new QUEUED job linked via `reprintOfId`
  - `GET /jobs/stats/failures` — Failure rate, total waste grams, reprint count
  - Job detail page: "Mark Failed" button with reason + waste input, failure info card (red), "Reprint" button on failed jobs, reprint chain display
  - Production list page: failure stats summary cards (total jobs, failed, failure rate, wasted filament)

- **Job Scheduling / Auto-distribution** — Automated printer assignment for queued jobs
  - `POST /jobs/auto-assign` — Auto-assign all unassigned QUEUED jobs: prefers product's default printer, load-balances by fewest active jobs, excludes MAINTENANCE/ERROR/OFFLINE printers
  - `GET /jobs/queue` — Queue view grouped by printer with ordered job lists + unassigned bucket
  - Production page: "Auto-Assign" button, List/Queue view toggle, per-printer queue cards with job order, unassigned jobs highlighted in amber

- **Machine Maintenance** — Maintenance scheduling and tracking per printer
  - `POST /printers/:id/maintenance` — Start maintenance (sets printer to MAINTENANCE status), logs type/description/cost
  - `PATCH /printers/:id/maintenance/:logId/complete` — Complete maintenance, restore to IDLE, set next due date
  - `GET /printers/:id/maintenance` — Maintenance history
  - `GET /printers/maintenance/overdue` — List all printers with overdue maintenance
  - `PATCH /printers/:id/maintenance-settings` — Set maintenance interval in hours
  - Printer detail page: maintenance due warning banner, start/complete buttons, interval settings, history table, print hours stat
  - Printer list page: "Overdue" and "In Maintenance" badges, print hours display

### Changed
- Job completion now accumulates print hours on the printer (`totalPrintHours`)
- Job `findOne` now includes `reprintOf` and `reprints` relations
- Printer `findOne` now includes `maintenanceLogs` and maintenance count
- Printer `findAll` includes `maintenanceLogs` count for badge rendering

### Schema Changes (requires `prisma db push`)
- `ProductionJob`: added `failureReason String?`, `failedAt DateTime?`, `wasteGrams Float @default(0)`, `reprintOfId String?` (self-relation via "Reprints")
- `Printer`: added `totalPrintHours Float @default(0)`, `maintenanceIntervalHours Float?`, `nextMaintenanceDue DateTime?`
- `MaintenanceLog`: new model — `printerId`, `type` (SCHEDULED/UNSCHEDULED/CALIBRATION), `description`, `scheduledDate`, `completedDate`, `downtimeMinutes`, `cost`, `performedById`, `notes`
- `NotificationType`: added `MAINTENANCE_DUE`

---

## [v2.7] — 2026-04-11

### Added
- **Security Hardening** — Helmet middleware with CSP directives, X-Frame-Options, HSTS; 3-tier rate limiting (short/medium/long) via @nestjs/throttler; stricter auth limits (5 login/min, 3 signup/min); CORS origin from env var
- **CSV Export** — 6 export endpoints (materials, spools, products, orders, jobs, customers) with formula injection prevention (prefixes `=`, `+`, `-`, `@`, `\t`, `\r` sanitized with `'`), date range filters on orders/jobs, admin-only customer export
- **Internationalization** — `LocaleProvider` React context for multi-currency/locale, public `/api/settings/locale` endpoint, settings UI for currency code, decimal places, locale, date format; defaults to OMR/en-GB/3 decimals
- **Test Coverage** — 44 unit tests across 3 suites:
  - `csv-export.spec.ts` (11 tests) — headers, custom labels, null handling, comma/quote escaping, formula injection (4 prefix types), empty rows, numerics, booleans
  - `costing.service.spec.ts` (10 tests) — single/multi-material cost, waste from color changes, purgeVolumeGrams override, global hourly rate fallback, zero materials, hexToLuminance, transition purge calculations
  - `gcode-parser.service.spec.ts` (23 tests) — slicer detection (PrusaSlicer/OrcaSlicer/Cura), time parsing (PrusaSlicer/Cura), filament grams/mm, layer height, filament type, nozzle/bed temp, filament colors, tool changes, multi-tool grams, color-to-tool mapping, single-tool, Buffer input, empty input, parseHeader

### Changed
- `apps/api/src/main.ts` — Added helmet + CORS configuration
- `apps/api/src/app.module.ts` — Added ThrottlerModule (3-tier) + global ThrottlerGuard + ExportModule
- `apps/api/src/auth/auth.controller.ts` — Added @Throttle decorators on login/signup
- `apps/app/src/app/layout.tsx` — Wrapped in LocaleProvider
- `apps/app/src/app/(dashboard)/settings/page.tsx` — Added locale/currency settings section

### New Files
- `apps/api/src/common/utils/csv-export.ts` — CSV generator with injection prevention
- `apps/api/src/common/utils/csv-export.spec.ts` — CSV export tests
- `apps/api/src/costing/costing.service.spec.ts` — Costing engine tests
- `apps/api/src/file-parser/gcode-parser.service.spec.ts` — G-code parser tests
- `apps/api/src/export/export.module.ts` — Export NestJS module
- `apps/api/src/export/export.controller.ts` — 6 CSV export endpoints
- `apps/api/src/export/export.service.ts` — Export queries
- `apps/api/jest.config.ts` — Jest configuration for API
- `apps/app/src/lib/locale-context.tsx` — React locale/currency context provider

---

## [v2.6] — 2026-04-11

### Added
- **Production Hybrid Module** — Stock-aware production planning linked to products and orders
  - `GET /jobs/plan/:orderId` — Preview production plan with deficit calculation per component
  - `POST /jobs/plan/:orderId` — Create production jobs from plan with optional overrides
  - `POST /jobs/:id/complete` — Complete job, increment stockOnHand, deduct spool weight
  - Plan preview dialog on order detail page with editable quantities, printer, and spool selection
- **ComponentMaterial join table** — Multicolor products store 1 component with N sub-materials instead of N separate components (e.g. Draco bust = 1 component, 4 filament colors)
- **Default Printer per Product** — `defaultPrinterId` on Product, auto-assigned during G-code onboarding (HI for multicolor, Ender for single-color), editable dropdown on product detail page
- **Stock on Hand** — `stockOnHand` field on ProductComponent tracks pre-printed finished units, editable inline in BOM table
- **Spool Selection Logic** — Production planner picks spool with lowest weight that has ≥ required + 50g buffer, falls back to spool with most stock
- **Multicolor BOM Display** — Product detail page shows sub-material badges with per-material stock status for multicolor components
- **Production Plan UI** — Order detail "Plan Production" button (for CONFIRMED/PENDING orders) with preview dialog showing sub-materials, spool suggestions, editable quantities and printer per component

### Changed
- G-code BOM onboarding now uses `filament_colour` hex as source of truth for material matching via RGB Euclidean distance to 19 named colors, auto-creates materials if type+color not found (`a3951a1`)
- `ProductComponent.materialId` is now nullable (multicolor components use ComponentMaterial entries instead)
- Order material availability check skips multicolor components (handled via ComponentMaterial)
- Product controller: static-prefix routes (`components/:id`, `active`) moved before parameterized `:id` route to prevent shadowing (`718e7b3`)

### Fixed
- **Component delete "not found"** — `DELETE /products/components/:componentId` was shadowed by `DELETE /products/:id` due to NestJS route ordering (`718e7b3`)
- **G-code upload "Upload failed" popup** — Frontend now reloads data even if response fails (nginx proxy timeout), shows HTTP status in error message (`925818b`)
- **G-code BOM all same material** — Was matching by type only (first PLA wins), now matches by type+color using hex-to-name mapping (`a3951a1`)

### OCR Scanner Improvements (v2.5.1–v2.5.4)
- **QR Code Brand Detection** — jsqr decodes spool QR → domain mapped to brand (esun3d→eSUN, bambulab→Bambu, etc.) (`f5888f2`)
- **Fuzzy Label Matching** — Levenshtein distance with 50% tolerance for OCR-mangled labels (`f3d6d88`, `2adfe86`)
- **Weight Digit Normalization** — `T/t/I/i/l→1`, `O→0`, accepts `hg` as fuzzy `kg` (`2adfe86`)
- **Editable Scan Review** — All 6 fields editable before saving, brand datalist with known brands (`12ebea8`)
- **Otsu Binarization** — Pure B/W preprocessing for better OCR accuracy (`8d47bc3`)
- **Color Cleanup** — Strips non-alpha suffixes, drops trailing 1-2 letter words, title-cases (`8d47bc3`)

### Schema Changes (requires `prisma db push`)
- `Product`: added `defaultPrinterId` (nullable FK to Printer)
- `ProductComponent`: added `stockOnHand` (Int, default 0), `isMultiColor` (Boolean, default false), `materialId` now nullable
- `ProductionJob`: added `productId`, `componentId` (nullable FKs), `quantityToProduce` (Int, default 1)
- `ComponentMaterial`: new model — `componentId`, `materialId`, `gramsUsed`, `colorIndex`, `sortOrder`, unique on `[componentId, colorIndex]`
- `Printer`: added `defaultProducts` relation

### Commits
- `4faeb6f` — Fix v2.5 feedback: QR labels, OCR flow, products, remove watch folder
- `1301956` — Security audit fixes: auth guards, sensitive field stripping, seed hardening
- `22d09a9` — Fix filament delete: add spool delete endpoint, cascade material delete
- `618d838` — Fix material/spool delete failing due to foreign key constraints
- `6636853` — Fix OCR scanner: pin CDN paths for tesseract.js, improve error messages
- `d5eda9b` — Add filament availability, public PFID access, Moonraker fix
- `d58d7be` — Self-host tesseract.js OCR assets to fix CORS error
- `4d16f5f` — Improve OCR scanner: image preprocessing + line-based parser
- `8d47bc3` — Optimize OCR scanner: Otsu, Levenshtein brand match, debug view
- `af8512e` — Make customer login the default landing page
- `12ebea8` — Editable scan review + collapsible mobile sidebar
- `f3d6d88` — Parser: fuzzy label matching + broader diameter/weight patterns
- `f5888f2` — Brand detection: decode QR code + map domain to brand
- `2adfe86` — Parser: loosen fuzzy label match + handle k→h unit misread
- `a3951a1` — G-code BOM: match material by type+color, auto-create if missing
- `1bed792` — Production hybrid module: ComponentMaterial, stock-aware planning, spool selection
- `925818b` — Fix G-code upload: reload data even if response fails
- `718e7b3` — Fix component delete: move static routes before parameterized :id route

## [v2.5] — 2026-04-04

### Added
- **Dark Mode** — Class-based toggle with CSS variables, localStorage persistence, anti-flash inline script
- **Role-Based Sidebar** — ADMIN sees all, OPERATOR sees production subset, VIEWER sees accounting subset
- **PrintForge ID & QR Labels** — Auto-generated PF-XXXX spool IDs, A4 QR label PDF (4x8 grid), spool detail page via QR scan
- **OCR Spool Scanner** — Client-side label scanning (tesseract.js) with camera/photo support, auto-extracts brand, material, color, weight, temp
- **Customer Portal Enhancements** — Order tracking page, simplified quick quote (no cost breakdowns), privacy-safe quote display
- **Product Media** — Image gallery with upload/delete, thumbnail in product list, batch gcode onboarding (auto-creates components)
- **Paywall Detection** — Detects paid models on Cults3D/MyMiniFactory, shows warning and hides action buttons
- **Excel Template** — Downloadable material import template with example row

### Changed
- Login swap: customer login at `/login` (main entry), staff login at `/staff-login`
- Renamed Inventory → Filaments throughout UI
- Markup precision increased to 0.01 step
- Quick quote: material + printer now mandatory, infill hidden for non-STL, state resets on file/mode change
- Costing engine accepts direct `purgeVolumeGrams` from gcode, separating actual waste from settings-based fallback
- UI components (card, button, badge, input, select, textarea, dialog) updated with dark mode variants

### Fixed
- Product image upload using wrong Prisma field names (filename/sizeBytes/storagePath)
- Spool/material CRUD: added edit dialogs, current weight field, delete material, deactivate spool
- Scraper: Printables/Thangs title fallbacks, Thingiverse numeric HTML entity decoding
- Quick quote state persistence bug between file uploads and mode switches

## [v2.0] — 2026-04-03

### Added
- **Quick Quote v2** — Multi-tool/CFS gcode detection with per-tool color breakdown, URL-based quoting from 6 model-sharing sites (MakerWorld, Thangs, Thingiverse, Printables, MyMiniFactory, Cults3D), save quotes with 3-day validity, 3-tab UI (File Upload, Multi-Color, Link Quote)
- **Design Center** — Full design request workflow (REQUESTED → ASSIGNED → IN_PROGRESS → REVIEW → REVISION → APPROVED → QUOTED → IN_PRODUCTION → COMPLETED), operator assignment queue, chat-style comments, design fee support (flat/hourly), quote linking
- **Customer Portal** — Self-signup with admin approval, dual JWT auth (staff vs customer), customer dashboard with quotes, design requests, and profile management
- **Email Notifications** — Branded HTML templates via Gmail/Nodemailer, fire-and-forget delivery for design events, order status updates, and customer approval
- **Badge variants** — success, warning, error, info styling for status badges
- **Deploy seeds** — admin_email, design_fee_default, quote_validity_days system settings

### Changed
- Schema: Customer model extended with auth fields (passwordHash, isApproved, isActive)
- Schema: Quote model extended with source tracking, gcode/stl metadata, cost breakdown JSON
- Schema: DesignProject model extended with assignment, fee config, quote relation
- Gcode parser now detects OrcaSlicer multi-tool footer metadata and T-command tool changes

## [v1.0] — 2026-03-28

### Added
- **Dashboard** — Overview with key metrics and recent activity
- **Quotes** — Create, edit, send quotes with line items, tax, and validity dates
- **Orders** — Order management with status tracking (PENDING → IN_PRODUCTION → COMPLETED → DELIVERED)
- **Inventory** — Material management with cost-per-gram, density, stock tracking
- **Printers** — Printer registry with Moonraker integration for live status, edit and delete support
- **Costing Engine** — Material cost + machine hourly rate + electricity + markup multiplier
- **Quick Quote** — Upload gcode/STL for instant cost estimates
- **Customers** — Customer database with contact info
- **Settings** — System settings for company info, currency, costing parameters, SMTP config
- **Auth** — JWT-based staff authentication with role-based access (ADMIN, OPERATOR)
- **Docker deployment** — Full Docker Compose stack with Nginx reverse proxy, PostgreSQL, API, and frontend

### Fixed
- Large gcode file uploads (148MB+) with increased memory limits
- Gcode parser scanning all header/footer lines for metadata
- Upload response unwrapping for API wrapper format

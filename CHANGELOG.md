# Changelog

All notable changes to PrintForge are documented here.

## [v2.11.0] — 2026-04-18 (current)

### Added
- **`WhatsAppService`** — Meta WhatsApp Business Cloud API integration. Sends free-form text messages to customer phone numbers via `https://graph.facebook.com/v18.0/{phoneId}/messages`. Configured via `whatsapp_token` + `whatsapp_phone_id` + `whatsapp_enabled` system settings. Falls back silently when not configured. Methods: `sendQuoteSent`, `sendOrderConfirmed`, `sendOrderInProduction`, `sendOrderReady`, `sendOrderCompleted`.
- **Email + WhatsApp lifecycle hooks** — Notifications fire automatically on status transitions:
  - Quote → `SENT`: emails customer quote summary + total; WhatsApp quote notification
  - Order → `CONFIRMED`: email + WhatsApp confirmation
  - Order → `IN_PRODUCTION`: email + WhatsApp production start notice
  - Order → `READY`: email + WhatsApp ready-for-pickup notice
  - All production jobs complete: email + WhatsApp order completion notice
- **4 new email templates** — `notifyCustomerQuoteSent`, `notifyCustomerOrderConfirmed`, `notifyCustomerOrderReady` added to `EmailNotificationService`. Quote template includes formatted total with currency and decimals from system settings.
- **Notification toggles** — Settings page "Notification Events" card with per-event enable/disable checkboxes (`notify_quote_sent`, `notify_order_confirmed`, `notify_order_production`, `notify_order_ready`, `notify_order_completed`). Default on; each hook reads the toggle before firing.
- **`POST /communications/test-email`** — Send a test email to any address to verify SMTP config. Admin only.
- **`POST /communications/test-whatsapp`** — Send a test WhatsApp message to verify Cloud API config. Admin only.
- **Settings UI — Communications overhaul** — WhatsApp card now has Phone Number ID + Access Token fields + enabled toggle + test button. Email card adds Admin Email field + test button with inline address input. Both test buttons are outside the Save form so settings don't need to be saved first.
- **Creality IP hot-reload** — `POST /moonraker/reconnect/:printerId` endpoint. Printer Details save now calls it automatically when `connectionType === CREALITY_WS`. No API restart needed after changing printer IP.
- **Native `<select>` sweep (Settings)** — Locale and Date Format selects replaced with the `Select` component. Dark mode consistent.

### Fixed
- `OrderStatus.READY_FOR_PICKUP` typo — enum value is `READY` (matches schema).

---

## [v2.10.8] — 2026-04-18

### Added
- **`CrealityWsService`** — Persistent `ws://IP:9999` WebSocket client per Creality printer. Push-based state (no polling), 10s heartbeat, exponential backoff reconnect (2s base → 120s cap, 1.8× multiplier). Maps `deviceState`, `printProgress`, temps, and `boxsInfo` to internal `PrinterStatus` shape. Auto-completes matching production jobs on print finish, deducts spool weight, fires notifications on error and completion.
- **`CREALITY_WS` connection type** — Added to `PrinterConnectionType` enum. Printer detail form shows "Printer IP Address" field (instead of "Moonraker URL") when this type is selected. Live Status card and pause/resume/cancel controls now work for both Moonraker and Creality printers.
- **Unified printer broadcast** — `MoonrakerScheduler` now merges Moonraker HTTP poll results with Creality WS cached snapshots every 10s. Creality snapshots are normalised to the same shape the frontend already expects (`progress` as 0.0–1.0, `printStats`, `heaterBed`, `extruder`).
- **`ACCOUNTING` role** — Added to `Role` enum. Sidebar visibility: Accounting users see Dashboard, Orders, Quotes, Customers, Accounting — no Quick Quote, Production, Design, Filaments, Products, Printers, or Settings.
- **Currency context** — `LocaleProvider` (already had `currency` + `useFormatCurrency()`) wired into `(dashboard)/layout.tsx`. Dashboard KPI cards now call `useFormatCurrency()` instead of hardcoding OMR — currency changes in Settings propagate immediately.

### Fixed
- **`controlPrint` missing 404** — `POST /moonraker/control/:printerId/:action` previously threw "No Moonraker URL" for unknown printer IDs. Now correctly throws `NotFoundException` before checking connection type.

---

## [v2.10.7] — 2026-04-18

### Added
- **`ProductCostingService`** — Extracted `calculateCost()` and `recalculateAggregates()` from `ProductsService` into a dedicated service. Queries Prisma directly (no circular dependency). Registered in `ProductsModule`.
- **`ProductOnboardingService`** — Extracted `onboardFromGcode()`, `onboardFromThreeMf()`, `hexToColorName()`, `findOrCreateMaterial()`, and `savePlateThumbnail()` into a dedicated service. Delegates aggregate recalc to `ProductCostingService`. `ProductsService` now thin (~220 lines).
- **`JobPlanningService`** — Extracted `previewPlan()`, `createFromPlan()`, and `selectSpool()` from `JobsService` into a dedicated planning service. Registered in `ProductionModule`.
- **`JobSchedulingService`** — Extracted `autoAssign()` and `getQueue()` from `JobsService`. `JobsService` now delegates to both new services.
- **Staff notification on customer quote request** — `QuotesService.customerRequestQuote()` broadcasts a WebSocket `info` notification to staff after the DRAFT quote is created. Uses `@Optional()` injection to avoid module coupling.
- **`use-line-items` hook** — Shared React hook at `apps/app/src/hooks/use-line-items.ts` eliminating ~80 lines of duplicated item management logic between `orders/new` and `quotes/new`.
- **Customer dashboard Design Requests real data** — Fetches from `GET /design-projects/customer/my-projects?limit=3` in parallel with quotes. Shows title and status badge for each project.

### Fixed
- **`createFromAnalysis` tax** — Was hardcoded to `0`. Now fetches `tax_rate` from system settings, same as `create()` and `customerRequestQuote()`.
- **`PrismaService` resilience** — Added 10s query timeout middleware (throws `503` on breach), slow-query logging for queries >500ms, and retry-connect with 3 attempts and 1s delay.
- **Native `<select>` replaced** — `orders/new` and `quotes/new` now use the `Select` component with a `productOptions` array. Dark mode classes added.

---

## [v2.10.6] — 2026-04-18

### Added
- **`POST /quotes/customer/request`** — New customer-facing endpoint that persists quick-quote results as a DRAFT quote. Handles both non-3MF (single item from file analysis + cost estimate) and 3MF (one item per selected plate). Tax is calculated from the `tax_rate` system setting. DTO fully validated with `class-validator`.
- **Customer Quick Quote → real DB write** — "Request This Quote" button now calls the new endpoint instead of just toggling UI state. Shows loading state and surfaces backend error messages on failure.
- **Customer dashboard real data** — My Quotes card fetches the 3 most recent quotes via `GET /quotes/customer/my-quotes` and shows quote number, status badge, and total. Falls back to a descriptive empty state.

### Fixed
- **Dark mode h1** — Added `dark:text-gray-100` to h1 tags on orders/[id], customers, quotes, design, and printers pages (5 pages were missing it).
- **EmptyState consistency** — Replaced raw `<div>` empty states with the `<EmptyState>` component on inventory, products, and printers pages. Printers empty state now includes an "Add Printer" action button.
- **Customer dashboard dark mode** — Added `dark:text-gray-100` and `dark:text-gray-400` to h1 and subtitle.

---

## [v2.10.5] — 2026-04-18

### Fixed
- **Sidebar skeleton** — `useState<string | null>(null)` sentinel: sidebar shows 7 animated placeholder bars while `/auth/me` resolves instead of flashing empty.
- **Orders stale data** — `setData(null)` + `setLoading(true)` moved into the `useEffect`; filter changes now clear stale rows immediately.
- **Production empty state** — List view renders `EmptyState` with context-aware description when a filter returns zero jobs.
- **h1 dark mode** — Added `dark:text-gray-100` to the Orders page h1.

---

## [v2.10.4] — 2026-04-16

### Added
- **Settings Cache in `CostingService`** — Implemented a 30-second TTL memory cache for system settings to eliminate N+1 database queries when costing multiple 3MF plates or product components in parallel.
- **Luminance-aware purge for 3MF** — `estimatePlates()` now utilizes `calculateTransitionPurge` logic by averaging transitions between all tools on a plate. This significantly improves the accuracy of purge waste cost estimation for multicolor 3MF files.
- **Costing Tests** — Added a new test suite to `costing.service.spec.ts` that specifically validates `estimatePlates` behavior and cache efficiency.

---

## [v2.10.3] — 2026-04-16

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

## [v2.10.2] — 2026-04-14

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

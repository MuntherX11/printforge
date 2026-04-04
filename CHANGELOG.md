# Changelog

All notable changes to PrintForge are documented here.

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

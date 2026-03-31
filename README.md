# PrintForge

**Open-source ERP for 3D print farms.** Manage quotes, orders, production jobs, inventory, costing, and printers from a single dashboard.

Built for small-to-medium 3D printing businesses that need real cost tracking, not spreadsheets.

---

## Features

### Core Business
- **Quotes & Orders** -- Create quotes with per-item cost estimates, convert accepted quotes to orders with one click, auto-generate production jobs
- **Production Tracking** -- Queue jobs, assign printers and operators, track status from QUEUED through COMPLETED
- **Invoice Generation** -- PDF invoices with company logo, bank details, and configurable notes. Email invoices directly to customers
- **Customer Management** -- Contact details, order history, WhatsApp quick-link, email integration

### Inventory & Costing
- **Spool Tracking** -- Track every spool by material, color, weight, lot number, and storage location
- **Bill of Materials** -- Define products with multi-component BOMs, auto-calculate costs
- **Smart Costing Engine** -- Material + machine + electricity + purge waste + overhead costs. Per-color breakdowns for multi-color prints with luminance-aware purge waste modeling
- **Low-Stock Alerts** -- Hourly automated checks with configurable reorder points
- **Bulk Import** -- Upload materials via Excel/CSV

### Smart Features
- **G-code Parser** -- Supports 9 slicers (Cura, PrusaSlicer, OrcaSlicer, BambuStudio, Creality Print, SuperSlicer, Simplify3D, ideaMaker, Slic3r). Extracts print time, filament usage, layer height, temperatures
- **STL Volume Estimator** -- Binary mesh analysis with signed tetrahedron volume method, infill-aware weight estimation
- **Quick Quote** -- Upload a G-code or STL file, get an instant cost estimate and suggested price
- **Watch Folder** -- Drop files into a monitored folder, auto-parse and import as products with BOM
- **Moonraker Bridge** -- Live printer status polling (10s intervals), auto-sync completed jobs, auto-deduct spool weight, pause/resume/cancel controls
- **WebSocket Updates** -- Real-time printer status and job progress pushed to all connected clients
- **Electricity Costing** -- Per-printer wattage tracking with configurable OMR/kWh rates

### Platform
- **PWA** -- Installable on mobile devices as a native-feeling app
- **Role-Based Access** -- Admin, Operator, and Viewer roles
- **Audit Logging** -- Every action tracked with user, timestamp, and details
- **Expense Tracking** -- Categorized expenses with P&L reporting
- **Design Module** -- Track design projects, revisions, and customer feedback (groundwork)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | NestJS 10, TypeScript, Prisma ORM |
| Frontend | Next.js 14, React 18, Tailwind CSS |
| Database | PostgreSQL 16 |
| Cache/Queue | Redis 7, BullMQ |
| Infra | Docker Compose, Nginx reverse proxy |
| PDF | PDFKit |
| Email | Nodemailer (Gmail SMTP) |

---

## Quick Start

### Prerequisites
- Docker and Docker Compose
- Linux server (tested on Debian/Ubuntu) or any Docker-capable host

### One-Command Deploy

```bash
git clone https://github.com/YOUR_USERNAME/printforge.git
cd printforge
sudo bash deploy.sh
```

This will:
1. Generate a secure `.env` with random passwords and JWT secret
2. Build all Docker images (~5 minutes first time)
3. Start PostgreSQL, Redis, API, Frontend, Worker, Moonraker Bridge, Nginx
4. Run database migrations and seed default data

**Access:** `http://YOUR_SERVER_IP:4032`
**Login:** `admin@printforge.local` / `admin123`

> Change the admin password immediately after first login.

### Development Setup

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your database credentials

# Generate Prisma client
cd apps/api && npx prisma generate && cd ../..

# Start databases
docker compose up db redis -d

# Run migrations
cd apps/api && npx prisma db push && cd ../..

# Start dev servers (in separate terminals)
npm run dev --workspace=@printforge/api
npm run dev --workspace=@printforge/app
```

API runs on `http://localhost:4000`, frontend on `http://localhost:3000`.

---

## Project Structure

```
printforge/
├── apps/
│   ├── api/                    # NestJS backend
│   │   ├── prisma/
│   │   │   └── schema.prisma   # Database schema
│   │   └── src/
│   │       ├── auth/           # JWT authentication
│   │       ├── costing/        # Cost calculation engine
│   │       ├── communications/ # Email service
│   │       ├── customers/
│   │       ├── file-parser/    # G-code & STL analysis
│   │       ├── health/         # Health check endpoint
│   │       ├── inventory/      # Materials, spools, locations
│   │       ├── invoices/       # Invoice generation & PDF
│   │       ├── moonraker-bridge/ # Klipper printer integration
│   │       ├── notifications/
│   │       ├── orders/
│   │       ├── printers/
│   │       ├── production/     # Job management
│   │       ├── products/       # Products & BOM
│   │       ├── quotes/
│   │       ├── settings/
│   │       ├── websocket/      # Real-time updates
│   │       └── worker/         # Background jobs
│   └── app/                    # Next.js frontend
│       ├── public/
│       │   ├── manifest.json   # PWA manifest
│       │   └── sw.js           # Service worker
│       └── src/
│           ├── app/
│           │   ├── (auth)/     # Login page
│           │   └── (dashboard)/ # All dashboard pages
│           ├── components/     # Reusable UI components
│           └── lib/            # API client, utilities
├── packages/
│   └── types/                  # Shared TypeScript types & DTOs
├── docker/
│   ├── nginx/                  # Reverse proxy config
│   └── db-backup/              # Automated backup scripts
├── scripts/                    # Setup & initialization
├── docker-compose.yml
├── deploy.sh                   # One-command deployment
└── package.json                # Workspace root
```

---

## Configuration

All settings are manageable from the **Settings** page in the UI. Key settings:

| Setting | Default | Description |
|---|---|---|
| `currency` | OMR | Display currency |
| `tax_rate` | 0 | Tax percentage applied to quotes/orders |
| `overhead_percent` | 15 | Overhead markup on cost calculations |
| `default_margin_percent` | 40 | Default profit margin for suggested prices |
| `electricity_rate_kwh` | 0.025 | Electricity cost per kWh |
| `purge_waste_grams` | 5 | Base purge waste per color change (grams) |

### Printer Integration

For Klipper/Moonraker printers:
1. Go to **Printers** > **Add Printer**
2. Set connection type to **Moonraker**
3. Enter the Moonraker URL (e.g., `http://192.168.1.50:7125`)
4. PrintForge will poll every 10 seconds for live status

### Watch Folder

Place `.gcode` or `.stl` files in the watch volume. In Docker, this maps to `pf-watch`. Files are auto-detected and appear in **Watch Folder** for one-click import as products.

To access the watch folder from the host:
```bash
# Find the volume mount path
docker volume inspect printforge_pf-watch

# Copy files into it
docker cp myfile.gcode printforge-api-1:/app/uploads/watch/
```

---

## Docker Services

| Service | Port | Purpose | Resources |
|---|---|---|---|
| nginx | 4032 | Reverse proxy | 0.5 CPU, 128MB |
| api | 4000 (internal) | REST API + WebSocket | 1.5 CPU, 768MB |
| app | 3000 (internal) | Next.js frontend | 1.0 CPU, 512MB |
| worker | -- | Background job processor | 0.5 CPU, 256MB |
| moonraker-bridge | -- | Printer status polling | 0.5 CPU, 256MB |
| db | 5432 (internal) | PostgreSQL | 1.0 CPU, 512MB |
| redis | 6379 (internal) | Cache & job queue | 0.5 CPU, 128MB |
| db-backup | -- | Daily database backups | 0.25 CPU, 128MB |

---

## API Overview

Full API documentation: [docs/API.md](docs/API.md)

Base URL: `http://localhost:4032/api`

| Module | Endpoints | Description |
|---|---|---|
| Auth | 3 | Login, logout, current user |
| Customers | 5 | CRUD operations |
| Materials | 6 | Materials + bulk upload |
| Spools | 5 | Spool tracking + weight adjustment |
| Products | 7 | Products + BOM components |
| Printers | 4 | Printer management |
| Jobs | 6 | Production job lifecycle |
| Quotes | 5 | Quote management + convert to order |
| Orders | 4 | Order management |
| Invoices | 6 | Invoice lifecycle + PDF + email |
| Costing | 2 | Single + multi-color cost estimation |
| File Parser | 3 | G-code/STL analysis |
| Watch Folder | 4 | Auto-import management |
| Moonraker | 4 | Live printer control |
| Settings | 4 | System configuration |
| Notifications | 4 | Alert management |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

---

## License

[MIT](LICENSE)

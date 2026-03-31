# Architecture

## Overview

PrintForge is a monorepo with three workspaces:

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Next.js    │────>│   Nginx      │<────│  Browser     │
│  Frontend   │     │   :4032      │     │  (PWA)       │
│  :3000      │     └──────────────┘     └──────────────┘
└─────────────┘            │
                           │ /api/*
                    ┌──────▼──────┐
                    │  NestJS     │──── WebSocket (/ws)
                    │  API :4000  │
                    └─────┬───┬──┘
                          │   │
              ┌───────────┘   └───────────┐
              ▼                           ▼
       ┌──────────┐               ┌──────────┐
       │PostgreSQL│               │  Redis   │
       │  :5432   │               │  :6379   │
       └──────────┘               └──────────┘
              ▲                         ▲
              │                         │
       ┌──────┴──────┐          ┌──────┴──────┐
       │   Worker    │          │  Moonraker  │
       │  (BullMQ)   │          │   Bridge    │
       └─────────────┘          └─────────────┘
```

## Design Decisions

### Why NestJS + Next.js (not a single framework)?

The API and frontend have different deployment characteristics. The API is a long-running process that maintains WebSocket connections, runs background schedules, and needs direct Prisma access. The frontend is a static-optimizable React app. Separating them allows:

- Independent scaling (API is heavier than frontend)
- The API can serve mobile apps or third-party integrations in the future
- Frontend can be CDN-cached in standalone mode

### Why PostgreSQL (not SQLite)?

SQLite would simplify deployment to a single file, but:
- Concurrent writes from API + Worker + Bridge would cause locking issues
- Full-text search, JSON columns, and array operations are needed
- pg_dump provides reliable backup/restore
- PostgreSQL runs fine on low-spec hardware (512MB RAM allocation)

### Why Prisma (not TypeORM or raw SQL)?

- Type-safe queries generated from the schema
- Schema-as-code with migration support
- Relation handling is cleaner than TypeORM for nested includes
- Trade-off: Prisma client binary adds ~30MB to the Docker image

### Why separate Worker and Bridge containers?

Both use `NestFactory.createApplicationContext()` (no HTTP server) with scheduled tasks:

- **Worker**: Runs BullMQ processors and scheduled checks (low-stock alerts hourly). Isolated so a crash doesn't affect the API.
- **Bridge**: Polls Moonraker printers every 10 seconds. Network timeouts to unreachable printers shouldn't impact the main API's response times.

Both share the same Docker image as the API (just different entrypoints), so there's no extra build cost.

### Why cookie-based JWT (not Bearer tokens)?

- httpOnly cookies prevent XSS token theft
- SameSite=Lax prevents CSRF for state-changing requests
- No client-side token storage or management needed
- Works transparently with `fetch({ credentials: 'include' })`

### Why `bcryptjs` (not `bcrypt`)?

The native `bcrypt` package requires Python and build tools to compile. In `node:20-slim` Docker images, this frequently fails. `bcryptjs` is a pure JavaScript implementation -- slower for hashing, but password hashing isn't a hot path.

### Why `node:20-slim` (not Alpine)?

Prisma's query engine is a pre-compiled binary. The `musl` libc in Alpine Linux causes compatibility issues. `node:20-slim` uses `glibc` and works reliably. The image size difference (~50MB) isn't worth the debugging overhead.

## Costing Engine

The costing engine calculates job costs with this formula:

```
Total Cost = Material + Machine + Electricity + Waste + Overhead

Material    = sum(grams_used * cost_per_gram) for each material
Machine     = (print_hours) * printer_hourly_rate
Electricity = (printer_wattage / 1000) * print_hours * electricity_rate_kwh
Waste       = sum(purge_grams * material_cost) for each color transition
Overhead    = (Material + Machine + Electricity + Waste) * overhead_percent

Suggested Price = Total Cost * (1 + margin_percent)
```

### Multi-Color Purge Waste Model

For multi-color prints (Bambu AMS, Palette, etc.), the purge waste varies by color transition. Dark-to-light transitions need significantly more purging than light-to-dark:

```
Luminance = 0.2126*R + 0.7152*G + 0.0722*B  (sRGB relative luminance)
LuminanceDiff = toLuminance - fromLuminance

Multiplier:
  dark→light (positive diff): 1 + diff * 1.5  (up to 2.5x base purge)
  light→dark (negative diff): 1 + diff * 0.3  (down to 0.7x base purge)

PurgeGrams = basePurgeGrams * multiplier
```

The "to" color's material cost is used for purge waste (that's what gets wasted in the nozzle during the transition).

## File Parsing

### G-code Parser

Reads the first and last 8KB of a G-code file (headers and footers contain slicer metadata). Supports regex-based extraction for 9 slicers:

| Slicer | Time Pattern | Filament Pattern |
|---|---|---|
| Cura | `;TIME:` | `;Filament used:` |
| PrusaSlicer | `; estimated printing time` | `; filament used [mm]` / `[g]` |
| OrcaSlicer | Same as PrusaSlicer | Same as PrusaSlicer |
| BambuStudio | Same as PrusaSlicer | Same as PrusaSlicer |
| Creality Print | `; Estimated Print Time:` | `; Filament Usage:` |

### STL Estimator

Uses the signed tetrahedron volume method for mesh volume calculation:

1. Parse binary STL header (80 bytes) and triangle count (4 bytes)
2. For each triangle (50 bytes): extract 3 vertices and compute signed volume contribution
3. Sum absolute volume, convert to cm^3
4. Estimate weight: shell volume (1.2mm walls) + infill volume at specified percentage
5. Rough print time: ~5 cm^3/hour for FDM

## WebSocket Architecture

The API runs a Socket.io server on the `/ws` namespace. The Moonraker scheduler broadcasts printer status after each 10-second poll cycle:

```
MoonrakerScheduler.pollPrinters()
  → MoonrakerService.pollAllPrinters()
    → fetch each printer's Moonraker API
    → update Printer status in DB
    → detect job completions → auto-deduct spools
  → EventsGateway.broadcastPrinterStatus()
    → socket.emit('printerStatus', [...])
```

Clients subscribe to events:
- `printerStatus` -- array of printer snapshots (state, temps, progress)
- `jobProgress` -- individual job progress updates
- `notification` -- system notifications (low stock, job complete)

## Authentication Flow

```
POST /api/auth/login {email, password}
  → validate credentials (bcryptjs.compare)
  → generate JWT (sub: userId, email, role)
  → set httpOnly cookie 'token' (SameSite=Lax, Secure based on env)
  → return {id, email, name, role}

Subsequent requests:
  → cookie-parser extracts token
  → PassportJWT strategy validates
  → JwtAuthGuard rejects if invalid
  → RolesGuard checks role if @Roles() decorator present
```

# API Reference

Base URL: `/api`

All endpoints require JWT authentication (cookie-based) unless noted. Responses are wrapped in `{ data: ... }` by the transform interceptor.

## Authentication

### POST /auth/login
Login and receive JWT cookie.

**Body:**
```json
{ "email": "admin@printforge.local", "password": "admin123" }
```
**Response:** `{ id, email, name, role }`

### POST /auth/logout
Clear authentication cookie.

### GET /auth/me
Get current authenticated user.

**Response:** `{ id, email, name, role }`

---

## Health

### GET /health
Check API and database connectivity. No auth required.

**Response:** `{ status: "ok", timestamp: "2026-03-30T12:00:00.000Z" }`

---

## Customers

### POST /customers
**Roles:** ADMIN, OPERATOR
```json
{ "name": "Acme Corp", "email": "info@acme.com", "phone": "+968-1234-5678" }
```

### GET /customers
Query: `?page=1&limit=20&sortBy=name&sortOrder=asc`

### GET /customers/:id

### PATCH /customers/:id
```json
{ "name": "Updated Name", "notes": "VIP client" }
```

### DELETE /customers/:id
**Roles:** ADMIN

---

## Inventory

### Materials

#### POST /materials
**Roles:** ADMIN, OPERATOR
```json
{
  "name": "PLA Red",
  "type": "PLA",
  "color": "Red",
  "brand": "eSUN",
  "costPerGram": 0.025,
  "density": 1.24,
  "reorderPoint": 500
}
```

#### GET /materials
Returns paginated list. Query: `?page=1&limit=20`

#### GET /materials/:id
Includes related spools with location info.

#### PATCH /materials/:id

#### POST /materials/bulk-upload
Upload an XLSX/CSV file. Columns: name, type, color, brand, costPerGram, density, reorderPoint.

**Content-Type:** `multipart/form-data` (field: `file`)

#### POST /materials/:id/merge
**Roles:** ADMIN. Body (allowlisted): `{ "targetMaterialId": "…", "confirm": true }`.
Moves every reference of this filament (part filaments, multicolour slots, colour option
filaments, job lines, job plate snapshots, printed-stock colour keys and their history,
retired spools) to the target, then deletes this filament. Without `confirm` it is a dry run
returning `{ merged: false, source, target, counts, warnings }`. 409 for a different material
type or an active spool on this filament. Writes its own audit row; reprices the touched products.

### Spools

#### POST /spools
```json
{
  "materialId": "clxx...",
  "initialWeight": 1000,
  "spoolWeight": 200,
  "lotNumber": "LOT-2024-001",
  "purchasePrice": 25.00,
  "locationId": "clxx..."
}
```

#### GET /spools
Query: `?materialId=xxx`

#### PATCH /spools/:id
```json
{ "currentWeight": 750, "locationId": "clxx..." }
```

#### POST /spools/:id/adjust
Adjust weight by delta (positive or negative).
```json
{ "adjustment": -50, "reason": "Test print" }
```

### Storage Locations

#### POST /locations
```json
{ "name": "Shelf A", "description": "Top shelf, dry storage" }
```

#### GET /locations
#### GET /locations/:id
#### PATCH /locations/:id
#### DELETE /locations/:id
Fails if spools are assigned to this location.

---

## Products

### POST /products
```json
{ "name": "Phone Stand", "sku": "PS-001", "colorChanges": 0 }
```

### GET /products
### GET /products/active
Only products where `isActive = true`.

### GET /products/:id
Includes components with material info.

### PATCH /products/:id
```json
{ "name": "Updated Name", "isActive": false }
```

### POST /products/:id/calculate
Calculate total cost based on BOM components. Returns cost breakdown with suggested price.

### POST /products/:id/components
Add a BOM component.
```json
{
  "materialId": "clxx...",
  "description": "Main body",
  "gramsUsed": 45.5,
  "printMinutes": 120,
  "quantity": 1,
  "sortOrder": 0
}
```

### DELETE /products/components/:componentId

---

## Printers

### POST /printers
**Roles:** ADMIN
```json
{
  "name": "Ender 3 V3 SE #1",
  "model": "Creality Ender 3 V3 SE",
  "connectionType": "MOONRAKER",
  "moonrakerUrl": "http://192.168.1.50:7125",
  "hourlyRate": 0.5,
  "wattage": 200
}
```
Connection types: `MOONRAKER`, `CREALITY_CLOUD`, `MANUAL`

### GET /printers
### GET /printers/:id
Includes recent production jobs.

### PATCH /printers/:id

---

## Production Jobs

### POST /jobs
```json
{
  "name": "Phone Stand - Order #5",
  "printerId": "clxx...",
  "assignedToId": "clxx...",
  "orderId": "clxx...",
  "gcodeFilename": "phone_stand.gcode",
  "colorChanges": 2
}
```

### GET /jobs
Query: `?status=IN_PROGRESS&page=1&limit=20`

### GET /jobs/:id
Full details with materials, printer, order info.

### PATCH /jobs/:id
```json
{ "status": "COMPLETED", "printDuration": 7200 }
```
Status options: `QUEUED`, `IN_PROGRESS`, `PAUSED`, `COMPLETED`, `FAILED`, `CANCELLED`

### POST /jobs/:id/materials
Add material consumption record.
```json
{
  "materialId": "clxx...",
  "spoolId": "clxx...",
  "gramsUsed": 45.5,
  "colorIndex": 0
}
```

### POST /jobs/:id/calculate-cost
Recalculate costs from materials and printer data.

---

## Quotes

### POST /quotes
```json
{
  "customerId": "clxx...",
  "notes": "Valid for 30 days",
  "validUntil": "2026-04-30",
  "items": [
    {
      "productId": "clxx...",
      "description": "Phone Stand",
      "quantity": 10,
      "unitPrice": 5.000
    }
  ]
}
```

### GET /quotes
Query: `?status=DRAFT&page=1&limit=20`

### GET /quotes/:id

### PATCH /quotes/:id
```json
{ "status": "SENT" }
```
Status options: `DRAFT`, `SENT`, `ACCEPTED`, `REJECTED`, `EXPIRED`

### POST /quotes/:id/convert
Convert an ACCEPTED or SENT quote to an order. Auto-creates production jobs.
```json
{ "autoCreateJobs": true }
```

---

## Orders

### POST /orders
```json
{
  "customerId": "clxx...",
  "notes": "Rush order",
  "dueDate": "2026-04-15",
  "items": [
    { "description": "Phone Stand", "quantity": 10, "unitPrice": 5.000 }
  ]
}
```

### GET /orders
Query: `?status=PENDING&page=1&limit=20`

### GET /orders/:id

### PATCH /orders/:id
```json
{ "status": "IN_PRODUCTION" }
```

---

## Invoices

### POST /invoices
```json
{ "orderId": "clxx...", "dueDate": "2026-04-30" }
```

### GET /invoices
### GET /invoices/:id

### PATCH /invoices/:id
**Roles:** ADMIN, ACCOUNTING (ACCOUNTING may only send `status: "PAID"`; anything else is a 403)
```json
{ "status": "PAID", "paidAt": "2026-03-30" }
```
Only `status` and `paidAt` are accepted; any other key (including `paidAmount`) is a 400. Marking an invoice PAID always sets `paidAmount` to the invoice total, and `paidAt` (default: now) is accepted only with `status: "PAID"`. CANCELLED invoices can't be changed, and a PAID invoice leaves PAID only through `POST /invoices/:id/unpay`.

### POST /invoices/:id/unpay
**Roles:** ADMIN, ACCOUNTING. Body `{ "reason": "…" }` (required, at most 200 characters). Moves a PAID invoice back to ISSUED in one transaction: clears `paidAmount`/`paidAt`, takes the amount off the order's `paidAmount`, posts an `ADJUSTMENT` reversing the invoice's ledger entries in the account they sit in (history is never edited) and writes an `Invoice.payment_undone` audit row. Returns `{ invoice, reversed: { amount, orderPaidAmount, entries } }`. 400 when the invoice isn't PAID or the reason is missing or too long; 409 `PAYMENT_MISMATCH`, `ORDER_PAID_TOO_LOW` or `LEDGER_MISMATCH` when older figures don't add up (nothing is changed).

### GET /invoices/:id/pdf
Downloads invoice as PDF. Includes company logo, payment details, and notes.

### POST /invoices/:id/send-email
Email invoice PDF to the order's customer. Uses configured SMTP settings.

---

## Costing

### POST /costing/estimate
Single-material cost estimate.
```json
{
  "gramsUsed": 50,
  "printMinutes": 120,
  "materialId": "clxx...",
  "printerId": "clxx...",
  "colorChanges": 0
}
```
**Response:**
```json
{
  "materialCost": 1.250,
  "machineCost": 1.000,
  "electricityCost": 0.100,
  "wasteCost": 0.000,
  "overheadCost": 0.353,
  "totalCost": 2.703,
  "suggestedPrice": 3.784,
  "marginPercent": 40
}
```

### POST /costing/estimate-multicolor
Per-color breakdowns with luminance-aware purge waste.
```json
{
  "colors": [
    { "colorIndex": 0, "materialId": "clxx...", "gramsUsed": 30, "colorHex": "#FFFFFF", "colorName": "White" },
    { "colorIndex": 1, "materialId": "clxx...", "gramsUsed": 20, "colorHex": "#000000", "colorName": "Black" }
  ],
  "printMinutes": 180,
  "printerId": "clxx..."
}
```
**Response** includes `colorDetails[]` and `purgeTransitions[]` with per-transition waste.

---

## File Parser

### POST /file-parser/analyze
Upload G-code or STL for analysis + optional cost estimate.

**Content-Type:** `multipart/form-data` (field: `file`)
**Query:** `?materialId=xxx&printerId=xxx&colorChanges=0&infill=20`

**Response:**
```json
{
  "filename": "model.gcode",
  "fileSize": 1048576,
  "analysis": {
    "type": "gcode",
    "slicer": "PrusaSlicer",
    "estimatedTimeSeconds": 7200,
    "filamentUsedGrams": 45.5,
    "layerHeight": 0.2,
    "filamentType": "PLA"
  },
  "costEstimate": { ... }
}
```

### POST /file-parser/parse-gcode
G-code only. Returns slicer metadata.

### POST /file-parser/analyze-stl
STL only. Query: `?density=1.24&infill=20`

Returns volume, surface area, bounding box, estimated weight and print time.

---

## Watch Folder

### GET /watch-folder/pending
Files detected in the watch folder awaiting import.

### GET /watch-folder
All imports (pending, imported, dismissed).

### POST /watch-folder/:id/dismiss
**Roles:** ADMIN, OPERATOR
Remove from pending list.

### POST /watch-folder/:id/import
**Roles:** ADMIN, OPERATOR
Import as a new product with auto-generated BOM. Only `name`, `sku` and `materialId` are accepted.
```json
{
  "name": "Imported Model",
  "sku": "IM-001",
  "materialId": "clxx..."
}
```

---

## Moonraker

### GET /moonraker/status/:printerId
Live status from Moonraker API. Returns temperatures, progress, print state.

### POST /moonraker/poll
**Roles:** ADMIN, OPERATOR
Manually trigger a poll of all Moonraker printers.

### POST /moonraker/reconnect/:printerId
**Roles:** ADMIN, OPERATOR
Reconnect a Creality printer's LAN WebSocket.

### POST /moonraker/gcode/:printerId
Send raw G-code command.
```json
{ "gcode": "G28" }
```

### POST /moonraker/control/:printerId/:action
Control active print. Action: `pause`, `resume`, `cancel`.

---

## Settings

### GET /settings
Returns all system settings as `{ key: value, ... }`.

### PUT /settings
**Roles:** ADMIN
```json
{
  "settings": [
    { "key": "currency", "value": "OMR" },
    { "key": "electricity_rate_kwh", "value": "0.025" }
  ]
}
```

### POST /settings/logo
Upload company logo image. **Content-Type:** `multipart/form-data`

### GET /settings/logo
Download company logo.

---

## Notifications

### GET /notifications
Query: `?unread=true`

### GET /notifications/count
Returns unread count.

### PATCH /notifications/:id/read

### PATCH /notifications/read-all

---

## Low Stock

### POST /low-stock/check
**Roles:** ADMIN, OPERATOR
Manually trigger low-stock check. Returns `{ checked, alerts }`.

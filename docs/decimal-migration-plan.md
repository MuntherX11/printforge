# Decimal Migration Plan

This repo still uses `Float` widely for money, grams, rates, and estimated production values. That is workable short term, but it will keep introducing rounding drift in costing and financial summaries.

## Why this should be a dedicated migration

A safe float-to-decimal migration touches:
- Prisma schema field types
- generated Prisma client types
- DTOs in `packages/types`
- API validation/parsing
- frontend form inputs that currently assume plain JS floats
- reporting and formatting logic
- existing database data and indexes

The inventory/OCR changes do not attempt a partial live migration because a half-converted financial model is riskier than waiting and doing it cleanly.

## Recommended phases

### Phase 1: Inventory and policy

Decide which fields must become exact decimals and which can remain floats.

Good decimal candidates:
- money: `costPerGram`, `basePrice`, `subtotal`, `tax`, `total`, `paidAmount`, `amount`, `quotedPrice`, `designFeeAmount`, `totalDesignFee`
- material/costing rates where exact arithmetic matters: `estimatedCost`, `marginPercent`, `materialCost`, `machineCost`, `wasteCost`, `overheadCost`, `totalCost`
- grams if they drive billing or cost rollups

Likely safe to keep as float:
- physical approximations such as density, wattage, estimated minutes, print duration, and filament used in mm

### Phase 2: Schema slice by slice

Migrate one domain at a time instead of the whole schema at once.

Suggested order:
1. Accounting and quotes/orders/invoices
2. Materials and product costing
3. Design/project fees
4. Remaining production summary fields

### Phase 3: DTO and service updates

For each converted field:
- accept strings or numbers at the API boundary
- convert using a single helper
- return strings or normalized decimal-safe values consistently

### Phase 4: Data migration

For each schema slice:
- create Prisma migration
- back up data
- run the migration on staging first
- verify totals before and after

### Phase 5: UI formatting and tests

Add focused tests for:
- quote totals
- invoice totals
- product/material costing
- waste calculations
- reorder/cost calculations that aggregate spool usage

## High-risk models to review first

From `apps/api/prisma/schema.prisma`, these models contain many float fields and should be treated carefully:
- `Material`
- `Spool`
- `Product`
- `ProductComponent`
- `ProductionJob`
- `Quote`
- `QuoteItem`
- `Order`
- `OrderItem`
- `Invoice`
- `InvoiceItem`
- `Expense`
- `DesignProject`

## Practical next step

If we want to start this safely, the best first implementation is:
1. convert accounting totals and line-item money fields to Decimal
2. add one shared decimal parsing/formatting helper
3. validate old vs new totals on a staging snapshot

That gives the biggest business-value improvement with the least blast radius.

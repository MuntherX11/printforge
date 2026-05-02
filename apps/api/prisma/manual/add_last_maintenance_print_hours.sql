-- Manual migration: add lastMaintenancePrintHours column to Printer table
-- Run this once on the production database if you cannot run `npx prisma db push`.
-- Safe to run multiple times (IF NOT EXISTS guard).

ALTER TABLE "Printer"
  ADD COLUMN IF NOT EXISTS "lastMaintenancePrintHours" DOUBLE PRECISION NOT NULL DEFAULT 0;

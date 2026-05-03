-- Manual migration: add ProductVariant model and variant FK columns
-- Run once on the production database after deploying the code.
-- Equivalent to: npx prisma db push
-- Safe to run multiple times (IF NOT EXISTS guards).

-- 1. Create ProductVariant table
CREATE TABLE IF NOT EXISTS "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "basePrice" DOUBLE PRECISION,
    "estimatedMinutes" DOUBLE PRECISION,
    "estimatedGrams" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- 2. Unique index on sku
CREATE UNIQUE INDEX IF NOT EXISTS "ProductVariant_sku_key" ON "ProductVariant"("sku");

-- 3. Index on productId
CREATE INDEX IF NOT EXISTS "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- 4. FK: ProductVariant -> Product (cascade delete)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProductVariant_productId_fkey'
  ) THEN
    ALTER TABLE "ProductVariant"
      ADD CONSTRAINT "ProductVariant_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 5. Add variantId to OrderItem
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "variantId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OrderItem_variantId_fkey'
  ) THEN
    ALTER TABLE "OrderItem"
      ADD CONSTRAINT "OrderItem_variantId_fkey"
      FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 6. Add variantId to ProductionJob
ALTER TABLE "ProductionJob" ADD COLUMN IF NOT EXISTS "variantId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProductionJob_variantId_fkey'
  ) THEN
    ALTER TABLE "ProductionJob"
      ADD CONSTRAINT "ProductionJob_variantId_fkey"
      FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

#!/bin/bash
# PrintForge — Full automated setup script
# Run this after extracting the zip on your server
set -e

echo "========================================="
echo "  PrintForge — Automated Setup"
echo "========================================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ---- Step 1: Generate .env if not exists ----
if [ ! -f ".env" ]; then
  echo "[1/5] Generating .env with secure secrets..."
  DB_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
  SECRET_KEY=$(openssl rand -base64 48 | tr -d '/+=' | head -c 64)

  cat > .env <<EOF
# PrintForge — Auto-generated $(date -u +"%Y-%m-%dT%H:%M:%SZ")
DATABASE_URL=postgresql://printforge:${DB_PASSWORD}@db:5432/printforge
DB_PASSWORD=${DB_PASSWORD}
SECRET_KEY=${SECRET_KEY}
JWT_EXPIRY=7d
REDIS_URL=redis://redis:6379
NODE_ENV=production
API_PORT=4000
APP_PORT=3000
COMPANY_NAME=My Print Farm
CURRENCY=OMR
TAX_RATE=0
MOONRAKER_URLS=
UPLOAD_DIR=/app/uploads
COOKIE_SECURE=false
EOF
  echo "  .env created."
else
  echo "[1/5] .env already exists, skipping."
fi

# ---- Step 2: Build and start containers ----
echo "[2/5] Building Docker images (this takes a few minutes)..."
docker compose build --no-cache

echo "[3/5] Starting containers..."
docker compose up -d

# ---- Step 3: Wait for database ----
echo "[4/5] Waiting for database to be ready..."
RETRIES=30
until docker compose exec -T db pg_isready -U printforge > /dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ $RETRIES -le 0 ]; then
    echo "  ERROR: Database did not become ready in time."
    exit 1
  fi
  sleep 2
done
echo "  Database ready."

# ---- Step 4: Run migrations and seed ----
echo "[5/5] Running database migrations and seed..."
docker compose exec -T api npx prisma migrate deploy 2>/dev/null || \
  docker compose exec -T api npx prisma db push --accept-data-loss
docker compose exec -T api node -e "
  const { PrismaClient } = require('@prisma/client');
  const bcrypt = require('bcryptjs');
  const prisma = new PrismaClient();
  async function main() {
    // Create admin user
    const exists = await prisma.user.findUnique({ where: { email: 'admin@printforge.local' } });
    if (!exists) {
      await prisma.user.create({ data: { email: 'admin@printforge.local', passwordHash: await bcrypt.hash('admin123', 10), name: 'Admin', role: 'ADMIN' } });
      console.log('Created admin user');
    }
    // Default settings
    const settings = [
      { key: 'currency', value: 'OMR' }, { key: 'tax_rate', value: '0' },
      { key: 'overhead_percent', value: '15' }, { key: 'purge_waste_grams', value: '5' },
      { key: 'default_infill_percent', value: '20' }, { key: 'company_name', value: 'My Print Farm' },
      { key: 'company_address', value: '' }, { key: 'company_logo_path', value: '' },
      { key: 'default_margin_percent', value: '40' },
    ];
    for (const s of settings) {
      await prisma.systemSetting.upsert({ where: { key: s.key }, update: {}, create: s });
    }
    console.log('Settings configured');
    // Default materials
    const matCount = await prisma.material.count();
    if (matCount === 0) {
      await prisma.material.createMany({ data: [
        { name: 'PLA White', type: 'PLA', color: 'White', brand: 'eSUN', costPerGram: 0.025, density: 1.24 },
        { name: 'PLA Black', type: 'PLA', color: 'Black', brand: 'eSUN', costPerGram: 0.025, density: 1.24 },
        { name: 'PETG White', type: 'PETG', color: 'White', brand: 'eSUN', costPerGram: 0.030, density: 1.27 },
        { name: 'PETG Black', type: 'PETG', color: 'Black', brand: 'eSUN', costPerGram: 0.030, density: 1.27 },
        { name: 'TPU Black', type: 'TPU', color: 'Black', brand: 'eSUN', costPerGram: 0.045, density: 1.21 },
      ]});
      console.log('Default materials created');
    }
    // Expense categories
    const cats = ['Filament', 'Equipment', 'Electricity', 'Rent', 'Software', 'Shipping', 'Marketing', 'Other'];
    for (const name of cats) {
      await prisma.expenseCategory.upsert({ where: { name }, update: {}, create: { name } });
    }
    console.log('Expense categories created');
  }
  main().then(() => prisma.\$disconnect()).catch(e => { console.error(e); process.exit(1); });
"

echo ""
echo "========================================="
echo "  PrintForge is running!"
echo "========================================="
echo ""
echo "  URL:      http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost')"
echo "  Login:    admin@printforge.local"
echo "  Password: admin123"
echo ""
echo "  IMPORTANT: Change the admin password after first login!"
echo ""
echo "  Useful commands:"
echo "    docker compose logs -f        # View logs"
echo "    docker compose ps             # Check status"
echo "    docker compose down            # Stop"
echo "    docker compose up -d           # Start"
echo "========================================="

#!/bin/bash
# PrintForge — Single-command deploy script
# Usage: sudo bash deploy.sh
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

echo "========================================="
echo "  PrintForge — Deploy"
echo "========================================="

# ---- Step 1: Generate .env ----
if [ ! -f ".env" ]; then
  echo "[1/6] Generating .env..."
  DB_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
  SECRET_KEY=$(openssl rand -base64 48 | tr -d '/+=' | head -c 64)
  ADMIN_PASSWORD=$(openssl rand -base64 16 | tr -d '/+=' | head -c 16)

  cat > .env <<ENVEOF
DATABASE_URL=postgresql://printforge:${DB_PASSWORD}@db:5432/printforge
DB_PASSWORD=${DB_PASSWORD}
SECRET_KEY=${SECRET_KEY}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
JWT_EXPIRY=7d
COOKIE_SECURE=false
REDIS_URL=redis://redis:6379
NODE_ENV=production
API_PORT=4000
APP_PORT=3000
COMPANY_NAME=My Print Farm
CURRENCY=OMR
TAX_RATE=0
MOONRAKER_URLS=
UPLOAD_DIR=/app/uploads
ENVEOF
  echo "  .env created."
else
  echo "[1/6] .env exists, skipping."
  # Source existing .env to get ADMIN_PASSWORD
  export $(grep -E '^ADMIN_PASSWORD=' .env | xargs) 2>/dev/null || true
  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD=$(openssl rand -base64 16 | tr -d '/+=' | head -c 16)
    echo "ADMIN_PASSWORD=${ADMIN_PASSWORD}" >> .env
    echo "  Added ADMIN_PASSWORD to .env"
  fi
fi

# ---- Step 2: Fix permissions ----
echo "[2/6] Fixing file permissions..."
chmod +x scripts/*.sh 2>/dev/null || true
chmod +x docker/db-backup/backup.sh 2>/dev/null || true

# ---- Step 3: Build Docker images ----
echo "[3/6] Building Docker images (this takes a few minutes)..."
docker compose build --no-cache

# ---- Step 4: Start containers ----
echo "[4/6] Starting containers..."
docker compose up -d

# ---- Step 5: Wait for DB + API ----
echo "[5/6] Waiting for database..."
RETRIES=30
until docker compose exec -T db pg_isready -U printforge > /dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ $RETRIES -le 0 ]; then
    echo "  ERROR: Database not ready after 60s"
    docker compose logs db
    exit 1
  fi
  sleep 2
done
echo "  Database ready."

echo "  Waiting for API to start..."
RETRIES=30
until docker compose exec -T api node -e "console.log('ok')" > /dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ $RETRIES -le 0 ]; then
    echo "  ERROR: API container not running. Logs:"
    docker compose logs api --tail 30
    exit 1
  fi
  sleep 2
done
echo "  API container ready."

# ---- Step 6: Migrate and seed ----
echo "[6/6] Setting up database..."

# Push schema (creates all tables)
docker compose exec -T api npx prisma db push --accept-data-loss

# Write seed script to a temp file to avoid bash interpretation issues
cat > /tmp/printforge_seed.js << 'SEEDEOF'
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  // Admin user
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) {
    console.error('  ERROR: ADMIN_PASSWORD not set');
    process.exit(1);
  }
  const exists = await prisma.user.findUnique({ where: { email: 'admin@printforge.local' } });
  if (!exists) {
    await prisma.user.create({
      data: {
        email: 'admin@printforge.local',
        passwordHash: await bcrypt.hash(adminPass, 10),
        name: 'Admin',
        role: 'ADMIN'
      }
    });
    console.log('  Created admin user');
  } else {
    console.log('  Admin user exists');
  }

  // System settings
  const settings = [
    { key: 'currency', value: 'OMR' },
    { key: 'tax_rate', value: '0' },
    { key: 'overhead_percent', value: '15' },
    { key: 'purge_waste_grams', value: '5' },
    { key: 'default_infill_percent', value: '20' },
    { key: 'company_name', value: 'My Print Farm' },
    { key: 'company_address', value: '' },
    { key: 'company_phone', value: '' },
    { key: 'company_email', value: '' },
    { key: 'default_margin_percent', value: '40' },  // legacy — kept for existing quotes
    { key: 'bank_details', value: '' },
    { key: 'invoice_notes', value: '' },
    { key: 'smtp_host', value: 'smtp.gmail.com' },
    { key: 'smtp_port', value: '587' },
    { key: 'smtp_user', value: '' },
    { key: 'smtp_pass', value: '' },
    { key: 'whatsapp_template', value: 'Hello {name}, this is {company}. ' },
    { key: 'electricity_rate_kwh', value: '0.025' },
    { key: 'markup_multiplier', value: '2.5' },
    { key: 'machine_hourly_rate', value: '0.400' },
    { key: 'admin_email', value: '' },
    { key: 'design_fee_default', value: '5.000' },
    { key: 'quote_validity_days', value: '3' }
  ];
  for (const s of settings) {
    await prisma.systemSetting.upsert({ where: { key: s.key }, update: {}, create: s });
  }
  console.log('  Settings configured');

  // Default materials
  const matCount = await prisma.material.count();
  if (matCount === 0) {
    await prisma.material.createMany({ data: [
      { name: 'PLA White', type: 'PLA', color: 'White', brand: 'eSUN', costPerGram: 0.009, density: 1.24 },
      { name: 'PLA Black', type: 'PLA', color: 'Black', brand: 'eSUN', costPerGram: 0.009, density: 1.24 },
      { name: 'PETG White', type: 'PETG', color: 'White', brand: 'eSUN', costPerGram: 0.012, density: 1.27 },
      { name: 'PETG Black', type: 'PETG', color: 'Black', brand: 'eSUN', costPerGram: 0.012, density: 1.27 },
      { name: 'TPU Black', type: 'TPU', color: 'Black', brand: 'eSUN', costPerGram: 0.018, density: 1.21 }
    ]});
    console.log('  Default materials created');
  }

  // Expense categories
  const cats = ['Filament', 'Equipment', 'Electricity', 'Rent', 'Software', 'Shipping', 'Marketing', 'Other'];
  for (const n of cats) {
    await prisma.expenseCategory.upsert({ where: { name: n }, update: {}, create: { name: n } });
  }
  console.log('  Expense categories created');
}

main()
  .then(() => prisma.$disconnect())
  .catch(e => { console.error(e); process.exit(1); });
SEEDEOF

# Copy seed script into the container and run it
docker compose cp /tmp/printforge_seed.js api:/app/seed.js
docker compose exec -T -e ADMIN_PASSWORD="${ADMIN_PASSWORD}" api node /app/seed.js
rm -f /tmp/printforge_seed.js

echo ""
echo "========================================="
echo "  PrintForge is running!"
echo "========================================="
echo ""
echo "  URL:      http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost')"
echo "  Login:    admin@printforge.local"
echo "  Password: ${ADMIN_PASSWORD}"
echo ""
echo "  IMPORTANT: Save this password! Change it after first login."
echo ""
echo "  Commands:"
echo "    docker compose logs -f        # View logs"
echo "    docker compose ps             # Status"
echo "    docker compose down           # Stop"
echo "    docker compose up -d          # Start"
echo "========================================="

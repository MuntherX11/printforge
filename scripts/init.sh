#!/bin/bash
# PrintForge — First-run initialization script
# Generates secure secrets and creates .env file

set -e

ENV_FILE=".env"

echo "========================================="
echo "  PrintForge — First Run Setup"
echo "========================================="

if [ -f "$ENV_FILE" ]; then
  echo ""
  echo "WARNING: .env file already exists."
  read -p "Overwrite? (y/N): " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Aborted."
    exit 0
  fi
fi

# Generate secure random values
DB_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
SECRET_KEY=$(openssl rand -base64 48 | tr -d '/+=' | head -c 64)

# Refuse to proceed with weak secrets
if [ ${#DB_PASSWORD} -lt 16 ]; then
  echo "ERROR: Failed to generate secure DB password. Is openssl installed?"
  exit 1
fi
if [ ${#SECRET_KEY} -lt 32 ]; then
  echo "ERROR: Failed to generate secure secret key. Is openssl installed?"
  exit 1
fi

cat > "$ENV_FILE" <<EOF
# PrintForge Environment — Auto-generated $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# DO NOT commit this file to version control

# Database
DATABASE_URL=postgresql://printforge:${DB_PASSWORD}@db:5432/printforge
DB_PASSWORD=${DB_PASSWORD}

# Auth
SECRET_KEY=${SECRET_KEY}
JWT_EXPIRY=7d

# Redis
REDIS_URL=redis://redis:6379

# App
NODE_ENV=production
API_PORT=4000
APP_PORT=3000

# Company defaults
COMPANY_NAME=My Print Farm
CURRENCY=OMR
TAX_RATE=0

# Moonraker printer URLs (comma-separated, leave empty to disable)
MOONRAKER_URLS=

# Upload directory (inside container)
UPLOAD_DIR=/app/uploads
EOF

echo ""
echo "  .env file created with secure random secrets."
echo ""
echo "  Next steps:"
echo "    1. Edit .env to set COMPANY_NAME and other defaults"
echo "    2. Run: docker compose up --build -d"
echo "    3. Run: docker compose exec api npx prisma migrate deploy"
echo "    4. Run: docker compose exec api npx ts-node prisma/seed.ts"
echo "    5. Open http://localhost in your browser"
echo "    6. Login with: admin@printforge.local / admin123"
echo "    7. CHANGE THE ADMIN PASSWORD IMMEDIATELY"
echo ""
echo "========================================="

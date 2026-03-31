# Deployment Guide

## Requirements

- Linux server (Debian/Ubuntu recommended) or any Docker-capable host
- Docker Engine 24+ and Docker Compose v2+
- 2GB+ RAM (4GB recommended)
- 10GB+ disk space

## Quick Deploy

```bash
git clone https://github.com/YOUR_USERNAME/printforge.git
cd printforge
sudo bash deploy.sh
```

The script handles everything: environment generation, Docker build, database setup, and seeding.

**Default access:**
- URL: `http://YOUR_SERVER_IP:4032`
- Email: `admin@printforge.local`
- Password: `admin123`

## Manual Deploy

### 1. Environment Setup

```bash
cp .env.example .env
```

Edit `.env` with secure values:

```env
DATABASE_URL=postgresql://printforge:YOUR_SECURE_PASSWORD@db:5432/printforge
DB_PASSWORD=YOUR_SECURE_PASSWORD
SECRET_KEY=YOUR_64_CHAR_RANDOM_STRING
JWT_EXPIRY=7d
COOKIE_SECURE=false
REDIS_URL=redis://redis:6379
NODE_ENV=production
API_PORT=4000
APP_PORT=3000
COMPANY_NAME=Your Business Name
CURRENCY=OMR
TAX_RATE=0
UPLOAD_DIR=/app/uploads
```

Generate secure values:
```bash
# Database password
openssl rand -base64 32 | tr -d '/+=' | head -c 32

# JWT secret
openssl rand -base64 48 | tr -d '/+=' | head -c 64
```

### 2. Build and Start

```bash
docker compose build
docker compose up -d
```

### 3. Database Setup

Wait for PostgreSQL to be ready, then:

```bash
# Push schema
docker compose exec -T api npx prisma db push

# Seed default data (admin user, materials, settings)
docker compose exec -T api node /app/seed.js
```

## Changing the Port

The default external port is **4032**. To change it, edit `docker-compose.yml`:

```yaml
services:
  nginx:
    ports:
      - "YOUR_PORT:80"
```

Then restart: `docker compose up -d nginx`

## HTTPS Setup

### Option A: Reverse Proxy (recommended)

Use an external Nginx/Caddy reverse proxy with Let's Encrypt:

```nginx
server {
    listen 443 ssl;
    server_name printforge.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/printforge.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/printforge.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4032;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set `COOKIE_SECURE=true` in `.env` when using HTTPS.

### Option B: Caddy (automatic HTTPS)

```
printforge.yourdomain.com {
    reverse_proxy localhost:4032
}
```

## Backups

### Automatic Backups

The `db-backup` container runs daily PostgreSQL dumps to the `pf-backups` volume.

### Manual Backup

```bash
# Dump database
docker compose exec -T db pg_dump -U printforge printforge > backup_$(date +%Y%m%d).sql

# Backup uploads
docker cp $(docker compose ps -q api):/app/uploads ./uploads_backup
```

### Restore

```bash
# Restore database
cat backup_20260330.sql | docker compose exec -T db psql -U printforge printforge

# Restore uploads
docker cp ./uploads_backup/. $(docker compose ps -q api):/app/uploads/
```

## Updating

```bash
cd printforge
git pull origin main
docker compose build --no-cache
docker compose up -d

# Run any new migrations
docker compose exec -T api npx prisma db push
```

## Monitoring

### Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f api
docker compose logs -f worker
docker compose logs -f moonraker-bridge

# Last 50 lines
docker compose logs --tail 50 api
```

### Health Check

```bash
curl http://localhost:4032/api/health
# {"status":"ok","timestamp":"2026-03-30T12:00:00.000Z"}
```

### Service Status

```bash
docker compose ps
```

All services should show `Up` or `Up (healthy)`.

### Common Issues

**API unhealthy / restarting:**
```bash
docker compose logs api --tail 30
# Check for database connection errors or missing env vars
```

**Worker exiting:**
```bash
docker compose logs worker --tail 30
# Should show "PrintForge Worker started" and stay running
```

**Moonraker bridge errors:**
Warnings about unreachable printers are normal if no Moonraker printers are configured. The bridge will mark them as OFFLINE and retry.

**Database connection refused:**
```bash
docker compose exec db pg_isready -U printforge
# Should return: accepting connections
```

## Resource Tuning

Default resource limits in `docker-compose.yml`:

| Service | CPU | Memory | Adjust if... |
|---|---|---|---|
| api | 1.5 | 768MB | Many concurrent users or large file uploads |
| app | 1.0 | 512MB | Rarely needs adjustment |
| db | 1.0 | 512MB | Large dataset or complex queries |
| worker | 0.5 | 256MB | Many background jobs |
| bridge | 0.5 | 256MB | Many Moonraker printers |
| redis | 0.5 | 128MB | Rarely needs adjustment |
| nginx | 0.5 | 128MB | Rarely needs adjustment |

For a server with 4GB RAM total, these defaults leave ~1GB for the OS.

## Watch Folder Setup

To enable auto-import of G-code/STL files:

```bash
# Find the watch volume path
docker volume inspect printforge_pf-watch

# Or copy files directly into the container
docker cp mymodel.gcode $(docker compose ps -q api):/app/uploads/watch/
```

Files placed in the watch folder are automatically detected and parsed. They appear in the **Watch Folder** page for review and one-click import as products.

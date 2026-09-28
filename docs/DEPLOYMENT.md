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

This builds the images on the machine it runs on, which is fine for a single-box install.
**Production (docker-vm) does not build on the host** — see
[Production: build on Vault, run on docker-vm](#production-build-on-vault-run-on-docker-vm).

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

## Production: build on Vault, run on docker-vm

| Host | Address | Role |
|---|---|---|
| **Vault** | 192.168.100.22 | Canonical git clone. Builds the images (`scripts/build-and-ship.sh`). |
| **docker-vm** | 192.168.100.241 | Production. Loads the shipped images, pushes the Prisma schema, runs the containers (`deploy.sh --prebuilt`). |
| **ALBERT** | — | Proxmox host. Runs no Docker. |

**Rule: never build images on docker-vm.** `docker compose build` there (npm install plus the
Next.js build) pushed the VM to ~80% iowait and took production down twice. Images are built on
Vault and streamed across with `docker save | ssh docker-vm docker load`; docker-vm only runs
containers and the schema push. Plain `sudo bash deploy.sh` (no flag) still builds on the host it
runs on, so on docker-vm always use `--prebuilt`.

### One-time setup

On **Vault**:

- Docker Engine with the buildx plugin (`docker buildx version` must work). On first use the
  script creates a dedicated BuildKit builder, `printforge-builder` (docker-container driver);
  builds run inside it, which is what makes them cancellable (see below).
- Passwordless ssh from Vault to docker-vm. The default target is the ssh name `docker-vm`; use
  `--host user@192.168.100.241` (or `DEPLOY_HOST=...`) if that alias is not configured, and
  `SSH_OPTS="-p 2222 -i /path/to/key"` for extra ssh arguments.
- The remote user must be able to run `docker load`: be in the `docker` group, or set
  `REMOTE_DOCKER="sudo -n docker"`.
- Optional: `pv`, for `--rate`.

On **docker-vm** nothing changes: the PrintForge checkout and its `.env` stay where they are.

### Deploying a release

**1. On Vault**, in the canonical clone:

```bash
bash scripts/build-and-ship.sh origin/master
```

The script:

- checks it can reach Docker on docker-vm over ssh *before* building, and refuses to build if it
  is run on docker-vm itself (or if the target turns out to be the machine it runs on);
- fetches origin and resolves the ref to one commit (and warns if a local branch differs from
  `origin/<branch>`, e.g. an unpushed Vault hotfix);
- exports that commit with `git archive` — uncommitted edits and stray `node_modules` in the
  working tree are never built;
- builds `printforge/api`, `printforge/app`, `printforge/nginx` and `printforge/db-backup` for the
  target's platform, tagged with the first 12 characters of the commit sha (or `--tag v2.16.0`),
  each labelled `org.opencontainers.image.revision=<sha>`;
- streams all four in one `docker save | ssh docker-vm docker load`, then checks every image on
  docker-vm carries the right commit label;
- prints the exact commands to run on docker-vm.

nginx and db-backup are shipped too because compose builds them from `docker/`; shipping them
keeps `nginx.conf` in step with the release and means docker-vm builds nothing at all.

**2. On docker-vm**, in the PrintForge checkout:

```bash
git fetch origin && git checkout --detach <sha>   # or git pull, if <sha> is the branch tip
sudo bash deploy.sh --prebuilt <tag>
```

The checkout still matters: `docker-compose.yml`, `deploy.sh` and `docker/go2rtc/go2rtc.yaml`
come from it (the Prisma schema and all application code come from the images). `deploy.sh`
warns when the checkout and the images are on different commits.
`sudo PREBUILT_TAG=<tag> bash deploy.sh` is the same as `--prebuilt <tag>`.

> **Never check out, on docker-vm, a commit whose `deploy.sh` predates `--prebuilt`.** The old
> script ignores its arguments (even `--help`) and runs a full on-host build. Check first with
> `grep -q PREBUILT_TAG deploy.sh`. `build-and-ship.sh` warns when the commit it built is one of
> these; its images can still be shipped and deployed from a newer checkout.

With `--prebuilt`, `deploy.sh`:

1. checks that all four `printforge/*:<tag>` images are on the host, built for its architecture,
   and from the same commit — otherwise it stops before touching anything;
2. points compose at them by retagging them to the names compose itself uses for each service
   (`<project>-api`, `<project>-worker`, `<project>-moonraker-bridge`, `<project>-app`,
   `<project>-nginx`, `<project>-db-backup`). The worker and the moonraker printer bridge run the
   api image. Because the names are compose's own, a later manual `docker compose up -d` or
   `restart` keeps running the deployed images instead of reverting to an older local build;
3. refuses to continue if compose would still build any other service on the host (for example a
   new bridge added to `docker-compose.yml`) — add it to `PREBUILT_SERVICE_MAP`, e.g.
   `PREBUILT_SERVICE_MAP="api=api worker=api moonraker-bridge=api printer-bridge=api app=app nginx=nginx db-backup=db-backup"`;
4. runs the existing schema guard and `prisma@5 db push` unchanged (`SKIP_DB_PUSH=1` and
   `ALLOW_SCHEMA_DROP=1` behave exactly as before);
5. recreates every service that runs a shipped image
   (`docker compose up -d --no-build --force-recreate ...`), starts anything else with
   `--no-build`, waits for the API and seeds defaults as before.

If the deploy stops before the containers are switched — say the schema guard refuses a
destructive change — the previous compose tags are put back, so the host is left as it was.

`--prebuilt` needs a Docker Compose plugin that supports `docker compose config --images`; if it
does not, the deploy refuses (it cannot otherwise prove that nothing will be built on the host).

### Rolling back

Every shipped tag stays on docker-vm until it is removed, so rolling back needs no build and no
checkout change (leave the checkout where it is):

```bash
docker image ls printforge/api                     # the tags available on docker-vm
sudo SKIP_DB_PUSH=1 bash deploy.sh --prebuilt <previous-tag>
```

`SKIP_DB_PUSH=1` leaves the newer schema in place (schema changes are additive, so older code runs
against it); without it the schema guard would refuse to drop the columns the older code lacks.

### Cancelling a runaway build

Builds run inside the `printforge-builder` BuildKit container on Vault, not inside the script, so
they are stopped daemon-side, by stopping the builder — every build step running in it (npm
install, next build) dies with it:

```bash
bash scripts/build-and-ship.sh --cancel             # = docker buildx stop printforge-builder
docker rm -f buildx_buildkit_printforge-builder0    # if buildx itself hangs: kill the builder container
docker buildx rm printforge-builder                 # drop the builder and its cache entirely
```

The next build starts the builder again. There is deliberately no CLI timeout: killing the client
(Ctrl-C, `timeout`, a dropped ssh session) is not a reliable way to stop a build, because the
daemon can keep going. To cap how much of Vault a build may use, recreate the builder with limits
(recent buildx only):

```bash
docker buildx rm printforge-builder
BUILDER_DRIVER_OPTS="cpu-quota=200000,memory=6g" bash scripts/build-and-ship.sh origin/master
```

A build started on docker-vm by the old default mode runs inside dockerd's embedded BuildKit (the
`docker` driver) and has no builder of its own to stop; the only daemon-side stop there is
`sudo systemctl restart docker`, which also restarts every container (they come back through
`restart: unless-stopped`). One more reason not to build on docker-vm.

### Housekeeping

- **docker-vm:** shipped tags accumulate. Keep the last two or three for rollback and remove older
  ones with `docker image rm printforge/api:<tag> printforge/app:<tag> printforge/nginx:<tag> printforge/db-backup:<tag>`.
- **Vault:** `docker buildx du --builder printforge-builder` shows the build cache,
  `docker buildx prune --builder printforge-builder` trims it, and old `printforge/*` tags can be
  removed with `docker image rm`.

### Options

`bash scripts/build-and-ship.sh --help` and `bash deploy.sh --help` list everything. The ones you
are likely to need:

| Where | Option | Effect |
|---|---|---|
| Vault | `--tag TAG` | tag to build and ship (default: 12-character commit sha) |
| Vault | `--host HOST` / `DEPLOY_HOST` | ssh destination (default `docker-vm`) |
| Vault | `--no-ship`, then `--ship-only` | build now, ship later (same `--tag` and ref) |
| Vault | `--no-cache`, `--pull` | cold build / refresh base images |
| Vault | `--rate 30m` | throttle the stream if `docker load` makes docker-vm's disk busy |
| Vault | `--compress` | gzip the stream (only helps on slow links) |
| Vault | `REMOTE_DOCKER`, `SSH_OPTS` | how to reach Docker on the target |
| docker-vm | `--prebuilt TAG` / `PREBUILT_TAG` | deploy shipped images, build nothing |
| docker-vm | `PREBUILT_SERVICE_MAP` | which compose service runs which shipped image |
| docker-vm | `SKIP_DB_PUSH=1`, `ALLOW_SCHEMA_DROP=1` | schema guard switches, unchanged |

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

**Production (docker-vm):** build and ship from Vault, then `sudo bash deploy.sh --prebuilt <tag>`
— see [Production: build on Vault, run on docker-vm](#production-build-on-vault-run-on-docker-vm).

**Single-box install:**

```bash
cd printforge
git pull
sudo bash deploy.sh
```

`deploy.sh` rebuilds the images, refuses a schema push that would drop or alter existing
columns (`SKIP_DB_PUSH=1` / `ALLOW_SCHEMA_DROP=1` to override, see `deploy.sh --help`), pushes the
schema with the pinned Prisma 5 CLI before the API starts, and restarts the containers.

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

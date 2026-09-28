#!/bin/bash
# PrintForge — Single-command deploy script
# Usage: sudo bash deploy.sh                    build the images on this host, then deploy
#        sudo bash deploy.sh --prebuilt <tag>   deploy images built on Vault and shipped here
#                                               by scripts/build-and-ship.sh (no build here)
# PREBUILT_TAG=<tag> in the environment is the same as --prebuilt <tag>. See --help.
set -e

usage() {
  cat <<'USAGEEOF'
Usage: sudo bash deploy.sh [--prebuilt <tag>]

  (no flag)         Build the images on this host (docker compose build --no-cache),
                    push the schema, start everything and seed defaults. Fine for a
                    single-box install. NOT for docker-vm: building there starves it.
  --prebuilt <tag>  Deploy the images that scripts/build-and-ship.sh built on Vault
                    and loaded here: printforge/{api,app,nginx,db-backup}:<tag>.
                    Nothing is built on this host. The compose services are retagged
                    to those images (api, worker and moonraker-bridge all run the api
                    image), the schema guard and prisma push run exactly as in the
                    default mode, and every service running a shipped image is
                    recreated. If the deploy stops before containers are switched,
                    the previous compose image tags are put back.

Environment:
  PREBUILT_TAG=<tag>     same as --prebuilt <tag>
  PREBUILT_REPO=<name>   image name prefix (default: printforge)
  PREBUILT_SERVICE_MAP   compose service=image pairs (default: api=api worker=api
                         moonraker-bridge=api app=app nginx=nginx db-backup=db-backup)
  SKIP_DB_PUSH=1         leave the database schema untouched (code-only rollback)
  ALLOW_SCHEMA_DROP=1    allow a schema push that drops or alters columns/tables,
                         after reviewing the printed SQL

Roll back to an earlier shipped tag (code only):
  sudo SKIP_DB_PUSH=1 bash deploy.sh --prebuilt <previous-tag>
USAGEEOF
}

PREBUILT_TAG="${PREBUILT_TAG:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --prebuilt)
      if [ -z "$2" ]; then echo "ERROR: --prebuilt needs an image tag (see --help)" >&2; exit 2; fi
      PREBUILT_TAG="$2"; shift 2 ;;
    --prebuilt=*) PREBUILT_TAG="${1#--prebuilt=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# ---- Prebuilt-image mode (--prebuilt / PREBUILT_TAG) ----
# Images are built on Vault by scripts/build-and-ship.sh and loaded here with
# `docker save | ssh docker-vm docker load`. This host only runs containers and
# pushes the schema: building on docker-vm starved it (80% iowait) and took
# production down twice.
PREBUILT_REPO="${PREBUILT_REPO:-printforge}"
# Compose service -> shipped image it runs. Every service compose would otherwise
# build must be listed, or the prebuilt deploy refuses to start.
PREBUILT_SERVICE_MAP="${PREBUILT_SERVICE_MAP:-api=api worker=api moonraker-bridge=api app=app nginx=nginx db-backup=db-backup}"
PREBUILT_SERVICES=()   # compose services switched to the shipped images
PREBUILT_RESTORE=()    # "compose-image|previous-image-id", put back if we stop early
PREBUILT_SWITCHED=0    # 1 once containers start moving to the new images

prebuilt_fail() {
  echo "  ERROR: $*" >&2
  exit 1
}

# Check the shipped images, then point compose at them by retagging them to the
# names compose uses for each service (<project>-<service>). Retagging rather than
# a compose override keeps later manual `docker compose up -d` runs on the same
# images instead of silently reverting to an older local build.
use_prebuilt_images() {
  local component img info platform label rev="" host_platform checkout
  local project services compose_images entry svc target targets="" prev pairs=()

  if ! [[ "$PREBUILT_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
    prebuilt_fail "invalid image tag '$PREBUILT_TAG'"
  fi

  # 1. All four images are here, built for this machine, from one commit.
  host_platform=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}') \
    || prebuilt_fail "cannot talk to the Docker daemon"
  for component in api app nginx db-backup; do
    img="$PREBUILT_REPO/$component:$PREBUILT_TAG"
    info=$(docker image inspect --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$img" 2>/dev/null) \
      || prebuilt_fail "image $img is not on this host. Build and ship it from Vault: scripts/build-and-ship.sh --tag $PREBUILT_TAG <git-ref>"
    platform="${info%% *}"
    label="${info#* }"
    [ "$label" != "<no value>" ] || label=""
    if [ "$platform" != "$host_platform" ]; then
      prebuilt_fail "$img is built for $platform but this host is $host_platform"
    fi
    if [ "$component" = "api" ]; then
      rev="$label"
    elif [ "$label" != "$rev" ]; then
      prebuilt_fail "images tagged $PREBUILT_TAG come from different commits (${rev:-unknown} vs ${label:-unknown}); ship them again"
    fi
  done
  echo "  Images: $PREBUILT_REPO/{api,app,nginx,db-backup}:$PREBUILT_TAG (commit ${rev:-unknown})"

  # docker-compose.yml, this script and docker/go2rtc come from this checkout.
  checkout=$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || true)
  if [ -n "$checkout" ] && [ -n "$rev" ] && [ "$checkout" != "$rev" ]; then
    echo "  WARNING: this checkout is at ${checkout:0:12} but the images were built from ${rev:0:12}."
    echo "           docker-compose.yml, deploy.sh and docker/go2rtc come from the checkout;"
    echo "           bring it to ${rev:0:12} unless the difference is intended -- but never to a"
    echo "           commit whose deploy.sh lacks --prebuilt (it would build on this host)."
  fi

  # 2. Work out which image name compose uses for each service.
  project="${COMPOSE_PROJECT_NAME:-}"
  if [ -z "$project" ]; then
    project=$(docker compose config 2>/dev/null | sed -n 's/^name: *//p' | head -n 1 | tr -d "\"'")
  fi
  [ -n "$project" ] || prebuilt_fail "could not read the compose project name from 'docker compose config'; set COMPOSE_PROJECT_NAME"
  services=$(docker compose config --services) || prebuilt_fail "'docker compose config --services' failed"
  compose_images=$(docker compose config --images 2>/dev/null) \
    || prebuilt_fail "this docker compose cannot list service images ('config --images'); upgrade the compose plugin to use --prebuilt"
  compose_images=$(printf '%s\n' "$compose_images" | sed -e 's#^docker\.io/library/##' -e 's#:latest$##')

  for entry in $PREBUILT_SERVICE_MAP; do
    svc="${entry%%=*}"
    component="${entry#*=}"
    case " api app nginx db-backup " in
      *" $component "*) ;;
      *) prebuilt_fail "PREBUILT_SERVICE_MAP: '$entry' names no shipped image (api, app, nginx, db-backup)" ;;
    esac
    printf '%s\n' "$services" | grep -Fqx -- "$svc" || continue   # not in this compose file
    target="$project-$svc"
    if ! printf '%s\n' "$compose_images" | grep -Fqx -- "$target"; then
      prebuilt_fail "compose does not call service $svc's image '$target'; it lists: $(printf '%s\n' "$compose_images" | tr '\n' ' ')"
    fi
    PREBUILT_SERVICES+=("$svc")
    pairs+=("$target=$PREBUILT_REPO/$component:$PREBUILT_TAG")
    targets="$targets$target
"
  done
  [ ${#PREBUILT_SERVICES[@]} -gt 0 ] || prebuilt_fail "no compose service matches PREBUILT_SERVICE_MAP"

  # 3. Anything else compose would build here must be covered, or we refuse:
  #    it would either be built on this host or run from a stale local image.
  for img in $compose_images; do
    case "$img" in
      "$project-"*)
        if ! printf '%s' "$targets" | grep -Fqx -- "$img"; then
          prebuilt_fail "compose image $img has no prebuilt image. Add its service to PREBUILT_SERVICE_MAP (and to scripts/build-and-ship.sh if it needs a new image)."
        fi ;;
    esac
  done

  # 4. Retag, remembering what each name pointed at so a failed deploy can undo it.
  for entry in "${pairs[@]}"; do
    target="${entry%%=*}"
    img="${entry#*=}"
    prev=$(docker image inspect --format '{{.Id}}' "$target" 2>/dev/null || true)
    PREBUILT_RESTORE+=("$target|$prev")
    docker tag "$img" "$target"
  done
  echo "  Compose services now resolve to the shipped images: ${PREBUILT_SERVICES[*]}"
}

restore_prebuilt_tags() {
  local entry target prev
  for entry in "${PREBUILT_RESTORE[@]}"; do
    target="${entry%%|*}"
    prev="${entry#*|}"
    if [ -n "$prev" ]; then
      docker tag "$prev" "$target" || true
    else
      docker rmi "$target" > /dev/null 2>&1 || true
    fi
  done
}

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$PREBUILT_SWITCHED" = 0 ] && [ ${#PREBUILT_RESTORE[@]} -gt 0 ]; then
    echo "  Deploy stopped before any container was switched; restoring the previous compose image tags."
    restore_prebuilt_tags
  fi
}
trap on_exit EXIT

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

# ---- Step 3: Build Docker images (or use the prebuilt ones) ----
if [ -n "$PREBUILT_TAG" ]; then
  echo "[3/6] Using prebuilt images tagged $PREBUILT_TAG (nothing is built on this host)..."
  use_prebuilt_images
else
  echo "[3/6] Building Docker images (this takes a few minutes)..."
  echo "  (Production/docker-vm: build on Vault instead -- see deploy.sh --help and docs/DEPLOYMENT.md)"
  docker compose build --no-cache
fi

# ---- Step 4: Start DB + Redis first ----
echo "[4/6] Starting database and Redis..."
docker compose up -d db redis

# ---- Step 5: Wait for DB, then push schema before API starts ----
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

# Push schema NOW — before the API container starts — so it never boots against a stale schema
# Pin the Prisma CLI to v5: the runtime image prunes devDependencies, so a bare
# `npx prisma` downloads the latest major (v7+), which fails on the v5 schema.
# Guard: never let a deploy (or a rollback to older code) silently drop tables or
# columns. `db push --accept-data-loss` would drop anything the checked-out schema
# lacks, so diff the live DB against the schema first and stop on destructive SQL.
#   SKIP_DB_PUSH=1       code-only rollback: leave the database schema untouched
#   ALLOW_SCHEMA_DROP=1  intentional drop, after reviewing the printed SQL
if [ "${SKIP_DB_PUSH:-0}" = "1" ]; then
  echo "  SKIP_DB_PUSH=1 — database schema left untouched (code-only rollback)."
else
  echo "  Checking the schema change for drops..."
  # set -e: a failing `migrate diff` aborts the deploy here too.
  SCHEMA_DIFF=$(docker compose run --rm -T api sh -c 'npx prisma@5 migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script')
  if echo "$SCHEMA_DIFF" | grep -Eiq 'DROP|ALTER COLUMN|RENAME'; then
    echo "$SCHEMA_DIFF"
    if [ "${ALLOW_SCHEMA_DROP:-0}" != "1" ]; then
      echo "  ERROR: this deploy would drop or alter existing columns/tables. Nothing was changed."
      echo "  Rolling back code? Re-run with SKIP_DB_PUSH=1. Intentional drop? Review the SQL above, then ALLOW_SCHEMA_DROP=1."
      exit 1
    fi
  fi
  echo "  Applying database schema..."
  docker compose run --rm api npx prisma@5 db push --accept-data-loss
  echo "  Schema applied."
fi

# Bring up all remaining containers (API, app, nginx, workers, etc.)
echo "  Starting all containers..."
if [ -n "$PREBUILT_TAG" ]; then
  # Recreate every service that runs a shipped image (api, worker and the
  # moonraker printer bridge share the api image), then start anything else.
  # --no-build: this mode never builds here, even if an image went missing.
  PREBUILT_SWITCHED=1
  docker compose up -d --no-build --force-recreate "${PREBUILT_SERVICES[@]}"
  docker compose up -d --no-build
else
  docker compose up -d
fi

echo "  Waiting for API to become ready..."
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

# ---- Step 6: Seed ----
echo "[6/6] Setting up database..."

# Schema already pushed above — go straight to seed

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
if [ -n "$PREBUILT_TAG" ]; then
  echo "  Images:   ${PREBUILT_REPO}/{api,app,nginx,db-backup}:${PREBUILT_TAG}"
fi
echo ""
echo "  IMPORTANT: Save this password! Change it after first login."
echo ""
echo "  Commands:"
echo "    docker compose logs -f        # View logs"
echo "    docker compose ps             # Status"
echo "    docker compose down           # Stop"
echo "    docker compose up -d          # Start"
echo "========================================="

#!/usr/bin/env bash
# PrintForge — build the release images on Vault and ship them to docker-vm.
#
# Production images are built HERE (Vault), never on the host that runs them:
# building on docker-vm pushed it to ~80% iowait and took production down twice.
# docker-vm only loads the shipped images, pushes the Prisma schema and runs the
# containers (sudo bash deploy.sh --prebuilt <tag>). Run with --help for details.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/build-and-ship.sh [options] <git-ref>
       scripts/build-and-ship.sh --cancel [--builder NAME]

Run this on Vault. It builds the PrintForge images for <git-ref> (branch, tag or
commit) from a clean `git archive` export of that commit -- never from the working
tree -- tags them <repo>/{api,app,nginx,db-backup}:<tag>, streams them to the
target with `docker save | ssh <host> docker load`, and checks they arrived.
Nothing is ever built on the target. Then, on the target:

    sudo bash deploy.sh --prebuilt <tag>

Options:
  --host HOST       ssh destination to ship to (default: $DEPLOY_HOST, else docker-vm)
  --tag TAG         image tag (default: first 12 characters of the commit sha)
  --repo NAME       image name prefix (default: $IMAGE_REPO, else printforge)
  --builder NAME    buildx builder to build in (default: $BUILDER, else printforge-builder;
                    created with the docker-container driver if it does not exist)
  --platform P      platform to build for (default: the target daemon's, e.g. linux/amd64)
  --no-cache        build without the BuildKit cache
  --pull            re-pull the base images (node, nginx, postgres) before building
  --no-fetch        do not `git fetch origin` before resolving <git-ref>
  --no-ship         build only; do not contact the target
  --ship-only       skip the build; ship the images already tagged <repo>/*:<tag> here
  --compress        gzip -1 the stream (docker load unpacks it); only helps on slow links
  --rate LIMIT      throttle the stream with `pv -L LIMIT` (e.g. 30m) so docker load
                    cannot saturate the target's disk; needs pv on this machine
  --cancel          stop every build running in the builder, daemon-side, and exit
  -h, --help        show this help

Environment:
  DEPLOY_HOST, IMAGE_REPO, BUILDER   defaults for --host, --repo and --builder
  SSH_OPTS              extra ssh arguments, e.g. "-p 2222 -i /path/to/deploy_key"
  REMOTE_DOCKER         docker command on the target (default: docker). Use
                        "sudo -n docker" if the ssh user is not in the docker group.
  BUILDER_DRIVER_OPTS   --driver-opt used when the builder is first created, e.g.
                        "cpu-quota=200000,memory=6g" to cap it (recent buildx only;
                        `docker buildx rm` the builder to apply new options)
  BUILD_FORBIDDEN_HOSTS hostnames this script refuses to build on (default: docker-vm)

Cancelling a runaway build (daemon-side, not a CLI timeout):
  Builds run inside a dedicated BuildKit container (the docker-container driver),
  not inside this script. Killing the client -- Ctrl-C, a timeout, a dropped ssh
  session -- is not a reliable way to stop a build: the daemon can keep going.
  There is deliberately no CLI timeout here. Stop the builder instead; every build
  step running in it (npm install, next build, ...) dies with it:

      scripts/build-and-ship.sh --cancel            # = docker buildx stop printforge-builder
      docker buildx stop printforge-builder         # the same, by hand
      docker rm -f buildx_buildkit_printforge-builder0
                                                    # if buildx itself hangs: kill the
                                                    # builder container outright
      docker buildx rm printforge-builder           # drop the builder and its cache

  The next build starts the builder again automatically. With --builder default
  (the docker driver) builds run inside dockerd itself and cannot be stopped on
  their own short of restarting the Docker daemon, so keep the dedicated builder.

Examples:
  scripts/build-and-ship.sh origin/master
  scripts/build-and-ship.sh --tag v2.16.0 v2.16.0
  scripts/build-and-ship.sh --ship-only --host 192.168.100.241 origin/master
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }
need_value() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value (see --help)"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

HOST="${DEPLOY_HOST:-docker-vm}"
REPO="${IMAGE_REPO:-printforge}"
BUILDER="${BUILDER:-printforge-builder}"
REMOTE_DOCKER="${REMOTE_DOCKER:-docker}"
FORBIDDEN_HOSTS="${BUILD_FORBIDDEN_HOSTS:-docker-vm}"
REF="" TAG="" PLATFORM="" RATE=""
FETCH=1 BUILD=1 SHIP=1 COMPRESS=0 CANCEL=0
BUILD_FLAGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --host)      need_value "$@"; HOST=$2; shift 2 ;;
    --tag)       need_value "$@"; TAG=$2; shift 2 ;;
    --repo)      need_value "$@"; REPO=$2; shift 2 ;;
    --builder)   need_value "$@"; BUILDER=$2; shift 2 ;;
    --platform)  need_value "$@"; PLATFORM=$2; shift 2 ;;
    --rate)      need_value "$@"; RATE=$2; shift 2 ;;
    --no-cache)  BUILD_FLAGS+=(--no-cache); shift ;;
    --pull)      BUILD_FLAGS+=(--pull); shift ;;
    --no-fetch)  FETCH=0; shift ;;
    --no-ship)   SHIP=0; shift ;;
    --ship-only) BUILD=0; shift ;;
    --compress)  COMPRESS=1; shift ;;
    --cancel)    CANCEL=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    -*)          die "unknown option: $1 (see --help)" ;;
    *)           [ -z "$REF" ] || die "only one <git-ref> is allowed (got '$REF' and '$1')"
                 REF=$1; shift ;;
  esac
done

# ---- --cancel: stop the builder, which aborts its in-flight builds daemon-side ----
if [ "$CANCEL" = 1 ]; then
  [ "$BUILDER" != "default" ] || die "the 'default' builder runs inside dockerd and cannot be stopped on its own"
  echo "Stopping buildx builder '$BUILDER' -- every build running in it is aborted."
  echo "(If this hangs: docker rm -f buildx_buildkit_${BUILDER}0)"
  docker buildx stop "$BUILDER"
  echo "Stopped. The next build restarts it; its cache is kept (docker buildx rm $BUILDER drops it)."
  exit 0
fi

# ---- Validate inputs ----
[ -n "$REF" ] || { usage >&2; exit 2; }
[ "$BUILD" = 1 ] || [ "$SHIP" = 1 ] || die "--ship-only with --no-ship leaves nothing to do"
[[ "$REPO" =~ ^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]] \
  || die "invalid image prefix '$REPO' (lowercase letters, digits, . _ - and /)"
[ -z "$PLATFORM" ] || [[ "$PLATFORM" =~ ^[a-z0-9]+/[a-z0-9_]+(/[a-z0-9]+)?$ ]] || die "invalid --platform '$PLATFORM'"

for cmd in docker git tar; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd not found"
done
[ "$SHIP" = 0 ] || command -v ssh >/dev/null 2>&1 || die "ssh not found"
[ -z "$RATE" ] || command -v pv >/dev/null 2>&1 || die "--rate needs pv (apt install pv)"
[ "$COMPRESS" = 0 ] || command -v gzip >/dev/null 2>&1 || die "--compress needs gzip"

# ---- Never build on a production host ----
LOCAL_HOST="$(hostname 2>/dev/null || uname -n)"
if [ "$BUILD" = 1 ]; then
  for forbidden in $FORBIDDEN_HOSTS; do
    if [ "${LOCAL_HOST%%.*}" = "${forbidden%%.*}" ]; then
      die "refusing to build on $LOCAL_HOST: production hosts only run containers. Build on Vault."
    fi
  done
  docker buildx version >/dev/null 2>&1 || die "docker buildx is missing (apt install docker-buildx-plugin)"
fi

SSH_ARGS=(-o ServerAliveInterval=30)
if [ -n "${SSH_OPTS:-}" ]; then
  read -r -a EXTRA_SSH_ARGS <<< "$SSH_OPTS"
  SSH_ARGS+=(${EXTRA_SSH_ARGS[@]+"${EXTRA_SSH_ARGS[@]}"})
fi
remote() { ssh "${SSH_ARGS[@]}" "$HOST" "$@"; }

# ---- Check the target before spending minutes on a build ----
if [ "$SHIP" = 1 ]; then
  echo "Checking docker on $HOST..."
  REMOTE_INFO="$(remote "hostname; $REMOTE_DOCKER version --format '{{.Server.Os}}/{{.Server.Arch}}'")" \
    || die "cannot reach docker on $HOST over ssh (check SSH_OPTS / REMOTE_DOCKER)"
  # Last two lines, in case the remote login prints anything first.
  REMOTE_NAME="$(printf '%s\n' "$REMOTE_INFO" | tail -n 2 | head -n 1)"
  REMOTE_PLATFORM="$(printf '%s\n' "$REMOTE_INFO" | tail -n 1)"
  [[ "$REMOTE_PLATFORM" =~ ^[a-z0-9]+/[a-z0-9_]+(/[a-z0-9]+)?$ ]] \
    || die "unexpected reply from docker on $HOST: '$REMOTE_PLATFORM'"
  if [ "${REMOTE_NAME%%.*}" = "${LOCAL_HOST%%.*}" ]; then
    die "$HOST is this machine ($LOCAL_HOST). Run this on Vault and ship to the production host."
  fi
  [ -n "$PLATFORM" ] || PLATFORM="$REMOTE_PLATFORM"
  echo "  $HOST ($REMOTE_NAME) runs ${REMOTE_PLATFORM}."
fi

# ---- Resolve the ref to one commit ----
REPO_ROOT="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)"
cd "$REPO_ROOT"
if [ "$FETCH" = 1 ]; then
  echo "Fetching origin..."
  git fetch --quiet --tags origin || die "git fetch origin failed (--no-fetch builds from what is already here)"
fi
SHA="$(git rev-parse --verify --quiet "${REF}^{commit}")" || die "unknown git ref: $REF"
if git show-ref --verify --quiet "refs/heads/$REF"; then
  UPSTREAM="$(git rev-parse --verify --quiet "refs/remotes/origin/${REF}^{commit}" || true)"
  if [ -n "$UPSTREAM" ] && [ "$UPSTREAM" != "$SHA" ]; then
    echo "WARNING: local branch '$REF' (${SHA:0:12}) differs from origin/$REF (${UPSTREAM:0:12})."
    echo "         Building the LOCAL branch. Pass origin/$REF to build what GitHub has."
  fi
fi
[ -n "$TAG" ] || TAG="${SHA:0:12}"
[[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid image tag '$TAG'"
echo "Commit: $(git log -1 --format='%h %s' "$SHA")"
echo "Tag:    $TAG"
# A commit from before the prebuilt mode carries a deploy.sh that ignores
# --prebuilt and would build on the target, so it must never be checked out there.
PREBUILT_AWARE=1
if ! grep -q 'PREBUILT_TAG' <<< "$(git show "$SHA:deploy.sh" 2>/dev/null || true)"; then
  PREBUILT_AWARE=0
  echo "WARNING: deploy.sh at ${SHA:0:12} predates --prebuilt. Shipping these images is fine, but do not"
  echo "         check this commit out on $HOST: its deploy.sh ignores --prebuilt and would build there."
fi

# Each shipped image: name|Dockerfile|build context (paths relative to the repo root).
COMPONENTS=(
  "api|apps/api/Dockerfile|."
  "app|apps/app/Dockerfile|."
  "nginx|docker/nginx/Dockerfile|docker/nginx"
  "db-backup|docker/db-backup/Dockerfile|docker/db-backup"
)
IMAGES=()
for spec in "${COMPONENTS[@]}"; do
  IMAGES+=("$REPO/${spec%%|*}:$TAG")
done

# ---- Build (here, on Vault) ----
CTX=""
cleanup() { if [ -n "$CTX" ]; then rm -rf "$CTX"; fi; }
trap cleanup EXIT

if [ "$BUILD" = 1 ]; then
  # Build exactly the committed tree: no uncommitted edits, no stray node_modules.
  CTX="$(mktemp -d "${TMPDIR:-/tmp}/printforge-build.XXXXXX")"
  git archive --format=tar "$SHA" | tar -x -C "$CTX"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Note: this checkout has uncommitted changes; they are NOT in the build."
  fi

  if [ "$BUILDER" != "default" ] && ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    echo "Creating buildx builder '$BUILDER' (docker-container driver)..."
    DRIVER_OPTS=()
    [ -z "${BUILDER_DRIVER_OPTS:-}" ] || DRIVER_OPTS=(--driver-opt "$BUILDER_DRIVER_OPTS")
    docker buildx create --name "$BUILDER" --driver docker-container \
      ${DRIVER_OPTS[@]+"${DRIVER_OPTS[@]}"} >/dev/null
  fi

  PLATFORM_FLAGS=()
  [ -z "$PLATFORM" ] || PLATFORM_FLAGS=(--platform "$PLATFORM")
  for spec in "${COMPONENTS[@]}"; do
    IFS='|' read -r name dockerfile context <<< "$spec"
    echo ""
    echo "==> Building $REPO/$name:$TAG  (cancel: scripts/build-and-ship.sh --cancel)"
    # --provenance=false keeps --load a plain single-platform image that
    # `docker save` / `docker load` round-trip on any image store.
    docker buildx build --builder "$BUILDER" --load --provenance=false \
      ${PLATFORM_FLAGS[@]+"${PLATFORM_FLAGS[@]}"} \
      ${BUILD_FLAGS[@]+"${BUILD_FLAGS[@]}"} \
      --label "org.opencontainers.image.revision=$SHA" \
      --label "org.opencontainers.image.version=$TAG" \
      -f "$CTX/$dockerfile" -t "$REPO/$name:$TAG" "$CTX/$context"
  done
fi

# ---- Every image must exist here and come from this commit ----
for img in "${IMAGES[@]}"; do
  rev="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img" 2>/dev/null)" \
    || die "image $img is not on this machine"
  [ "$rev" = "$SHA" ] || die "$img was built from ${rev:-an unknown commit}, not $SHA"
done

if [ "$SHIP" = 0 ]; then
  echo ""
  echo "Built ${IMAGES[*]} (not shipped: --no-ship)."
  echo "Ship later with: scripts/build-and-ship.sh --ship-only --tag $TAG $SHA"
  exit 0
fi

# ---- Ship: docker save | ssh <host> docker load ----
echo ""
echo "==> Shipping to $HOST: ${IMAGES[*]}"
compress() { if [ "$COMPRESS" = 1 ]; then gzip -1; else cat; fi; }
throttle() { if [ -n "$RATE" ]; then pv -q -L "$RATE"; else cat; fi; }
docker save "${IMAGES[@]}" | compress | throttle | remote "$REMOTE_DOCKER load"

# ---- Confirm they arrived intact ----
REMOTE_REVS="$(remote "$REMOTE_DOCKER image inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' ${IMAGES[*]}")" \
  || die "the images did not arrive on $HOST"
REMOTE_REVS="$(printf '%s\n' "$REMOTE_REVS" | tail -n "${#IMAGES[@]}")"
ARRIVED=0
while IFS= read -r rev; do
  [ "$rev" = "$SHA" ] || die "an image on $HOST has revision '${rev}', expected $SHA"
  ARRIVED=$((ARRIVED + 1))
done <<< "$REMOTE_REVS"
[ "$ARRIVED" -eq "${#IMAGES[@]}" ] || die "expected ${#IMAGES[@]} images on $HOST, found $ARRIVED"

echo ""
echo "========================================="
echo "  Shipped $TAG (commit ${SHA:0:12}) to $HOST"
echo "========================================="
if [ "$PREBUILT_AWARE" = 1 ]; then
  echo "  On $HOST, in the PrintForge checkout:"
  echo "    1. bring the checkout to ${SHA:0:12} (docker-compose.yml, deploy.sh and"
  echo "       docker/go2rtc come from it), e.g.: git fetch origin && git checkout --detach $SHA"
  echo "    2. sudo bash deploy.sh --prebuilt $TAG"
else
  echo "  This commit's deploy.sh predates --prebuilt. On $HOST, leave the checkout on a"
  echo "  commit whose deploy.sh has it (check: grep -q PREBUILT_TAG deploy.sh) and run:"
  echo "    sudo bash deploy.sh --prebuilt $TAG"
fi
echo ""
echo "  Roll back to an earlier tag (code only, schema untouched):"
echo "    sudo SKIP_DB_PUSH=1 bash deploy.sh --prebuilt <previous-tag>"
echo "========================================="

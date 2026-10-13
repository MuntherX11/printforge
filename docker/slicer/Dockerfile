# PrintForge slicer sidecar: headless OrcaSlicer behind a small Node HTTP wrapper.
# Built on Vault by scripts/build-and-ship.sh like the other images (see docs/DEPLOYMENT.md).
#
# Base image: the pinned OrcaSlicer AppImage is the "Ubuntu2404" build, linked
# against glibc 2.39. debian:bookworm-slim ships glibc 2.36 and the binary
# refuses to start there (GLIBC_2.38 not found), so the runtime stage is
# ubuntu:24.04 (same Debian family, same apt package names). Override with
# --build-arg BASE_IMAGE=... if a Debian base with a matching glibc appears.
ARG BASE_IMAGE=ubuntu:24.04
ARG ORCA_VERSION=2.4.2

# ---- Node 20 binary (no apt nodejs, no npm needed: server.mjs has no dependencies)
FROM node:20-bookworm-slim AS node

# ---- Fetch and extract the AppImage (no FUSE at runtime)
FROM ${BASE_IMAGE} AS orca
ARG ORCA_VERSION
ARG ORCA_ASSET=OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage
ARG ORCA_URL=https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v${ORCA_VERSION}/${ORCA_ASSET}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/orca
RUN curl -fsSL --retry 3 -o orca.AppImage "${ORCA_URL}" \
 && chmod +x orca.AppImage \
 && ./orca.AppImage --appimage-extract > /dev/null \
 && rm orca.AppImage \
 && test -x squashfs-root/AppRun \
 && test -d squashfs-root/resources/profiles

# ---- Runtime
FROM ${BASE_IMAGE}
ARG ORCA_VERSION
ENV DEBIAN_FRONTEND=noninteractive

# What OrcaSlicer's Linux (wxGTK3 / WebKitGTK 4.1) build links against, plus Xvfb
# and Mesa so it can create its GL context off-screen. No desktop, no FUSE.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      xvfb xauth \
      libgl1 libegl1 libgl1-mesa-dri libglu1-mesa libosmesa6 \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 \
      libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
      libsoup-3.0-0 libsecret-1-0 libnotify4 \
      libdbus-1-3 libcurl4t64 libssl3t64 \
      libxkbcommon0 libxcb1 libx11-6 libxext6 libxrender1 libxi6 libxrandr2 \
      libfontconfig1 libfreetype6 fonts-dejavu-core \
      libasound2t64 libudev1 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=orca /opt/orca/squashfs-root /opt/orca/squashfs-root

RUN groupadd --system slicer \
 && useradd --system --gid slicer --create-home --home-dir /home/slicer --shell /usr/sbin/nologin slicer \
 && mkdir -p /uploads /scratch /app \
 && chown slicer:slicer /scratch /app

WORKDIR /app
COPY --chown=slicer:slicer package.json server.mjs flatten.mjs args.mjs labels.mjs request.mjs system-index.mjs ./

ENV PORT=7788 \
    SLICE_TIMEOUT_MS=300000 \
    UPLOADS_DIR=/uploads \
    SCRATCH_DIR=/scratch \
    ORCA_BIN=/opt/orca/squashfs-root/AppRun \
    ORCA_PROFILES_DIR=/opt/orca/squashfs-root/resources/profiles \
    ORCA_VERSION=${ORCA_VERSION} \
    HOME=/home/slicer \
    NODE_ENV=production

# /uploads is mounted read-only from pf-uploads; /scratch is a tmpfs.
VOLUME ["/uploads", "/scratch"]
EXPOSE 7788
USER slicer

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||7788)+'/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "server.mjs"]

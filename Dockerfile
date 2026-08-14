# Base image PINNED to a digest. The browser fingerprint LinkedIn sees is derived
# from the Chromium build below, which depends on this base. A floating tag would
# let a rebuild silently pull a newer Debian + newer Chromium, changing the
# fingerprint and triggering a LinkedIn forced-logout (root cause of the Jun 2026
# incident). Bump this digest only deliberately — it requires re-authenticating.
FROM node:22-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2

# Chromium PINNED to an exact version for a stable browser fingerprint.
# Do NOT unpin. Any Chromium change must be a conscious decision — it changes the
# fingerprint and will log the LinkedIn session out (Jun 2026 incident, §15).
#
# We fetch Chromium from snapshot.debian.org (a frozen, immutable Debian archive)
# instead of the live mirror. The live mirror only keeps the newest 1-2 Chromium
# builds, so it ROTATED 149 out (and the current live build, 150.0.7871.46, is a
# broken build that SIGTRAPs on launch — do not use it). The snapshot archive keeps
# every version forever, so this pin builds reproducibly regardless of the live
# mirror. Snapshot is served over http:// on purpose (its TLS cert isn't in the
# base image's CA bundle; apt would silently fall back to the live mirror otherwise).
# All three chromium packages are pinned together — chromium depends on
# chromium-common/chromium-sandbox at the exact same version or apt errors.
RUN echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260620T000000Z/ bookworm main" > /etc/apt/sources.list \
  && echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260620T000000Z/ bookworm-security main" >> /etc/apt/sources.list \
  && echo "Acquire::Check-Valid-Until false;" > /etc/apt/apt.conf.d/99snapshot \
  && apt-get -o Acquire::Retries=3 update && apt-get install -y --no-install-recommends \
  chromium=149.0.7827.155-1~deb12u1 \
  chromium-common=149.0.7827.155-1~deb12u1 \
  chromium-sandbox=149.0.7827.155-1~deb12u1 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnss3 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# Tell Playwright to use the system Chromium instead of downloading its own
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
# --include=dev because the build genuinely needs the dev dependencies, and Coolify
# passes NODE_ENV=production in, which would otherwise drop them.
#
# TypeScript is the one that bites: next.config.ts is TypeScript, so with no compiler
# in the tree Next fetched one mid-build ("Installing TypeScript as it was not found
# while loading next.config.ts"). That put a registry call on the critical path of
# every deploy, and on 2026-08-14 an ECONNRESET during it failed the build outright.
# Installing from the lock file instead pins the compiler (5.9.3) and needs no network.
#
# The @types/* packages are the reason this is --include=dev rather than adding
# typescript alone: a compiler with no type declarations type-checks the build and
# fails it on the first untyped import (papaparse), which is exactly what happened
# when only TypeScript was pinned. Build inputs and dev inputs are the same set here.
RUN npm ci --include=dev

COPY . .

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

RUN npm run build

# Data directory — mount a volume here to persist the SQLite DB
RUN mkdir -p /data && chown node:node /data
ENV LINKI_DB_PATH=/data/linki.db

USER node

EXPOSE 3000

CMD ["npm", "start"]

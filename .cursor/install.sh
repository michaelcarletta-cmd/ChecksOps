#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the ChecksOps app.
# Safe to run repeatedly and against cached/partially-prepared state.
set -euo pipefail

cd "$(dirname "$0")/.."

# Bun is the authoritative package manager for this Lovable project
# (bun.lock / bun.lockb are committed; package-lock.json is stale). Install it
# if the base image does not already provide it.
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi

# Install dependencies exactly as pinned by the committed bun lockfile.
bun install --frozen-lockfile

# Provide a local dev binding when none exists. Uses the committed public
# Supabase publishable keys from .env.production so `npm run dev` connects to
# the hosted backend out of the box. (.env is gitignored.)
if [ ! -f .env ] && [ -f .env.production ]; then
  cp .env.production .env
fi

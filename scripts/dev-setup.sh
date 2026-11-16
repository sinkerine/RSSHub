#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
workspace_key=$(printf '%s' "$PWD" | sha256sum | cut -c1-16)
scratch_root="${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/rsshub/$workspace_key"
mkdir -p "$scratch_root"

# Keep the normal node_modules entrypoint; put rebuildable package data in scratch.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
pnpm install --frozen-lockfile \
    --store-dir "$scratch_root/pnpm-store" \
    --virtual-store-dir "$scratch_root/node_modules"

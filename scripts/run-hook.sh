#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# GUI Git clients do not inherit the interactive shell's direnv environment.
if ! command -v pnpm >/dev/null 2>&1; then
    if [[ "${RSSHUB_HOOK_ENV_LOADING:-}" == 1 ]]; then
        echo "RSSHub hooks require pnpm. Run rsshub-setup in the Nix shell first." >&2
        exit 1
    fi
    export RSSHUB_HOOK_ENV_LOADING=1
    if command -v direnv >/dev/null 2>&1; then
        exec direnv exec "$PWD" bash scripts/run-hook.sh "$@"
    elif command -v nix >/dev/null 2>&1; then
        exec nix develop --impure -c bash scripts/run-hook.sh "$@"
    fi
    echo "RSSHub hooks require pnpm on PATH, or Nix with the project development shell." >&2
    exit 1
fi

profile=$1
shift
# A hook suite run inside an admitted job already has its resource reservation.
if command -v agent-job >/dev/null 2>&1 && [[ "${AGENT_JOB_ACTIVE:-}" != 1 ]]; then
    exec agent-job run "$profile" -- "$@"
fi
exec "$@"

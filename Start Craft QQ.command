#!/bin/zsh
set -euo pipefail
TASK_ROOT=${0:A:h}
cd "$TASK_ROOT"
export PATH="$TASK_ROOT/.local-tools:$TASK_ROOT/node_modules/.bin:$PATH"
# Keep this custom version on its source branch rather than replacing it with an official release.
export CRAFT_DISABLE_UPDATES=1
if ! command -v bun >/dev/null; then
  print 'Bun is required. Install Bun, then run this launcher again.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  bun install --frozen-lockfile
fi
if [[ ! -f apps/electron/dist/main.cjs ]]; then
  bun run electron:build
fi
print 'Starting the QQ custom build. Quit other Craft Agents instances first.'
exec bun run electron apps/electron

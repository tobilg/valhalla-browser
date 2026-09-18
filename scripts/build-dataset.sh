#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Arguments use repository-relative paths; the same layout is mounted at /work.
# For host-native tools, call scripts/build-dataset.py directly instead.
docker image inspect valhalla-browser-build >/dev/null 2>&1 || {
  echo 'Missing build image. Run pnpm run build:native first.' >&2
  exit 1
}
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work \
  valhalla-browser-build python3 scripts/build-dataset.py "$@"

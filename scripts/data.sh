#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker run --rm -v "$PWD:/work" -w /work valhalla-browser-build python3 scripts/prepare-data.py "$@"

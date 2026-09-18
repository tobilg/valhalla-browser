#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
docker build -t valhalla-browser-build -f scripts/Dockerfile .
docker run --rm -v "$PWD:/work" -w /work valhalla-browser-build bash scripts/build-container.sh "${1:-all}"

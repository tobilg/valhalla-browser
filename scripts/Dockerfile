FROM emscripten/emsdk:6.0.0@sha256:9eed2e47b4206928b22f99d2917013ad5462d777bb24cb546a652729896badd8
COPY scripts/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential cmake ninja-build pkg-config git curl ca-certificates python3 \
    libboost-dev libprotobuf-dev protobuf-compiler zlib1g-dev libsqlite3-dev \
    libspatialite-dev spatialite-bin libluajit-5.1-dev libgeos-dev libssl-dev \
    libexpat1-dev osmium-tool && rm -rf /var/lib/apt/lists/*
WORKDIR /work

#!/usr/bin/env bash
set -euo pipefail
stage=${1:-all}
jobs=${BUILD_JOBS:-4}
mkdir -p build/sources build/reports
source_dir=/work/build/sources/valhalla
revision=$(python3 -c 'import json; print(json.load(open("versions.json"))["valhalla"])')
if [ ! -d "$source_dir/.git" ]; then
  git clone https://github.com/valhalla/valhalla.git "$source_dir"
  git -C "$source_dir" checkout "$revision"
  git -C "$source_dir" submodule update --init --recursive
fi
test "$(git -C "$source_dir" rev-parse HEAD)" = "$revision"
python3 scripts/patch-upstream.py
dpkg-query -W > build/reports/container-packages.txt
emcc --version > build/reports/emscripten.txt
git -C "$source_dir" submodule status --recursive > build/reports/submodules.txt
common=(-G Ninja -DCMAKE_BUILD_TYPE=Release -DENABLE_SERVICES=OFF -DENABLE_TESTS=OFF
  -DENABLE_PYTHON_BINDINGS=OFF -DENABLE_NODE_BINDINGS=OFF -DENABLE_HTTP=OFF
  -DENABLE_GEOTIFF=OFF -DENABLE_LZ4=OFF -DENABLE_CCACHE=OFF
  -DENABLE_SINGLE_FILES_WERROR=OFF -DBUILD_SHARED_LIBS=OFF -DLOGGING_LEVEL=ERROR)
if [ "$stage" = native ] || [ "$stage" = all ]; then
  cmake -S native -B build/native "${common[@]}" -DVALHALLA_SOURCE="$source_dir" -DENABLE_DATA_TOOLS=ON -DENABLE_TOOLS=ON
  cmake --build build/native --target native-reference valhalla_build_tiles valhalla_build_admins -j "$jobs"
fi
if [ "$stage" = wasm ] || [ "$stage" = all ]; then
  if [ ! -d build/sources/protobuf ]; then
    git clone --depth 1 --branch v21.12 https://github.com/protocolbuffers/protobuf.git build/sources/protobuf
  fi
  if [ ! -d build/sources/zlib ]; then
    git clone --depth 1 --branch v1.3.1 https://github.com/madler/zlib.git build/sources/zlib
  fi
  test "$(git -C build/sources/protobuf rev-parse HEAD)" = f0dc78d7e6e331b8c6bb2d5283e06aa26883ca7c
  test "$(git -C build/sources/zlib rev-parse HEAD)" = 51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf
  prefix=/work/build/wasm-deps
  emcmake cmake -S build/sources/protobuf/cmake -B build/protobuf-wasm -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" \
    -Dprotobuf_BUILD_TESTS=OFF -Dprotobuf_BUILD_PROTOC_BINARIES=OFF \
    -Dprotobuf_WITH_ZLIB=OFF -DCMAKE_CXX_FLAGS=-fexceptions
  cmake --build build/protobuf-wasm --target install -j "$jobs"
  emcmake cmake -S build/sources/zlib -B build/zlib-wasm -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix"
  cmake --build build/zlib-wasm --target zlibstatic -j "$jobs"
  mkdir -p "$prefix/lib/pkgconfig" "$prefix/include"
  cp build/zlib-wasm/libz.a "$prefix/lib/"
  cp build/sources/zlib/zlib.h build/zlib-wasm/zconf.h "$prefix/include/"
  cp build/zlib-wasm/zlib.pc "$prefix/lib/pkgconfig/"
  # Boost is header-only here; never let CMake discover host binary libraries.
  if [ ! -d "$prefix/include/boost" ]; then cp -a /usr/include/boost "$prefix/include/"; fi
  export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig:$prefix/share/pkgconfig"
  export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
  emcmake cmake -S native -B build/wasm "${common[@]}" \
    -DVALHALLA_SOURCE="$source_dir" -DENABLE_DATA_TOOLS=OFF -DENABLE_TOOLS=OFF \
    -DCMAKE_CXX_FLAGS=-fexceptions -DCMAKE_FIND_ROOT_PATH="$prefix" \
    -DBOOST_ROOT="$prefix" -DBoost_NO_BOOST_CMAKE=ON \
    -DProtobuf_INCLUDE_DIR="$prefix/include" \
    -DProtobuf_LIBRARY="$prefix/lib/libprotobuf.a" \
    -DProtobuf_LITE_LIBRARY="$prefix/lib/libprotobuf-lite.a" \
    -Dpkgcfg_lib_ZLIB_z="$prefix/lib/libz.a" \
    -DProtobuf_PROTOC_EXECUTABLE=/usr/bin/protoc
  cmake --build build/wasm --target valhalla-browser -j "$jobs"
  mkdir -p public/wasm
  cp build/wasm/valhalla-browser.{js,wasm} public/wasm/
  python3 scripts/collect-licenses.py
fi

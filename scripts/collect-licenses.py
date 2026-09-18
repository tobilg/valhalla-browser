#!/usr/bin/env python3
"""Keep license texts beside locally built redistributable WASM artifacts."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
source = root / 'build/sources'
texts = {
    'Valhalla.txt': source / 'valhalla/COPYING',
    'Protobuf.txt': source / 'protobuf/LICENSE',
    'zlib.txt': source / 'zlib/LICENSE',
    'date.txt': source / 'valhalla/third_party/date/LICENSE.txt',
    'RapidJSON.txt': source / 'valhalla/third_party/rapidjson/license.txt',
    'unordered_dense.txt': source / 'valhalla/third_party/unordered_dense/LICENSE',
    'cpp-statsd-client.txt': source / 'valhalla/third_party/cpp-statsd-client/LICENSE.md',
    'cxxopts.txt': source / 'valhalla/third_party/cxxopts/LICENSE',
    'protozero.txt': source / 'valhalla/third_party/protozero/LICENSE.md',
    'vtzero.txt': source / 'valhalla/third_party/vtzero/LICENSE',
    'IANA-tz.txt': source / 'valhalla/third_party/tz/LICENSE',
    'Boost.txt': Path('/usr/share/doc/libboost1.83-dev/copyright'),
    'Emscripten.txt': Path('/emsdk/upstream/emscripten/LICENSE'),
    'musl.txt': Path('/emsdk/upstream/emscripten/system/lib/libc/musl/COPYRIGHT'),
}
out = root / 'public/wasm/licenses'
out.mkdir(parents=True, exist_ok=True)
for name, path in texts.items():
    shutil.copyfile(path, out / name)
shutil.copyfile(root / 'NOTICE.md', out / 'NOTICE.md')

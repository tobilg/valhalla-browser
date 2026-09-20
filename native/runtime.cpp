#include <emscripten.h>
#include <emscripten/heap.h>
#include <valhalla/tyr/actor.h>
#include <valhalla/exceptions.h>
#include <valhalla/config.h>
#include <boost/property_tree/json_parser.hpp>
#include <cstring>
#include <sstream>
#include <unordered_map>

using namespace valhalla;
using namespace valhalla::baldr;

EM_JS(int, has_interrupt, (), { return typeof Module.interrupt === 'function'; });
EM_ASYNC_JS(int, check_interrupt, (), {
  try { await Module.interrupt(); return 0; }
  catch (error) { Module.bridgeError = error; return 1; }
});

EM_JS(int, object_size, (const char* url), {
  return Module.tileLoader.objectSize(UTF8ToString(url));
});

EM_ASYNC_JS(int, fetch_bytes,
            (const char* url, const char* offset, const char* size, char* destination), {
  try {
    const bytes = await Module.tileLoader.get(UTF8ToString(url),
      BigInt(UTF8ToString(offset)), BigInt(UTF8ToString(size)));
    if (!bytes) return 0;
    HEAPU8.set(bytes, destination);
    return bytes.byteLength;
  } catch (error) {
    Module.bridgeError = error;
    return -1;
  }
});

EM_ASYNC_JS(double, fetch_head, (const char* url), {
  try { return await Module.tileLoader.head(UTF8ToString(url)); }
  catch (error) { Module.bridgeError = error; return -1; }
});

class BrowserGetter final : public tile_getter_t {
public:
  GET_response_t get(const std::string& url, uint64_t offset, uint64_t size) override {
    const auto capacity = size ? size : static_cast<uint64_t>(object_size(url.c_str()));
    if (!capacity) return {{}, status_code_t::FAILURE, 404};
    if (capacity > 64 * 1024 * 1024) throw std::runtime_error("Tile exceeds transfer limit");
    GET_response_t response;
    response.bytes_.resize(capacity);
    const int received = fetch_bytes(url.c_str(), std::to_string(offset).c_str(),
                                     std::to_string(size).c_str(), response.bytes_.data());
    if (received < 0) throw std::runtime_error("Browser tile transport failed");
    if (static_cast<uint64_t>(received) != capacity)
      throw std::runtime_error("Unexpected tile transport length");
    response.status_ = status_code_t::SUCCESS;
    response.http_code_ = size ? 206 : 200;
    return response;
  }
  HEAD_response_t head(const std::string& url, header_mask_t) override {
    const auto modified = fetch_head(url.c_str());
    if (modified < 0) throw std::runtime_error("Browser metadata transport failed");
    return {static_cast<uint64_t>(modified), status_code_t::SUCCESS, 200};
  }
};

class BrowserReader final : public GraphReader {
public:
  explicit BrowserReader(const boost::property_tree::ptree& config)
      : GraphReader(config, std::make_unique<BrowserGetter>()) {}
  graph_tile_ptr GetGraphTile(const GraphId& id) override {
    if (cache_->Contains(id.tile_base())) ++hits;
    auto tile = GraphReader::GetGraphTile(id);
    if (tile) sizes[id.tile_base()] = tile->header()->end_offset();
    return tile;
  }
  size_t bytes() const {
    size_t total = 0;
    for (const auto& [id, size] : sizes) if (cache_->Contains(id)) total += size;
    return total;
  }
  size_t hits = 0;
  std::unordered_map<GraphId, size_t> sizes;
};

static std::unique_ptr<BrowserReader> reader;
static std::unique_ptr<tyr::actor_t> actor;
static std::string output;

extern "C" {
const char* vb_dispose() {
  actor.reset();
  reader.reset();
  return "{}";
}

const char* vb_init(const char* json) {
  vb_dispose();
  try {
    boost::property_tree::ptree config;
    std::istringstream input(json);
    boost::property_tree::read_json(input, config);
    auto next_reader = std::make_unique<BrowserReader>(config.get_child("mjolnir"));
    auto next_actor = std::make_unique<tyr::actor_t>(config, *next_reader, true);
    reader = std::move(next_reader);
    actor = std::move(next_actor);
    return "{}";
  } catch (const std::exception&) {
    vb_dispose();
    return "{\"runtimeError\":\"INITIALIZATION\"}";
  }
}

const char* vb_route(const char* json) {
  try {
    if (!actor) throw std::runtime_error("Actor not initialized");
    const std::function<void()> interrupt = []() {
      if (check_interrupt()) throw std::runtime_error("Routing interrupted");
    };
    output = actor->route(json, has_interrupt() ? &interrupt : nullptr);
  } catch (const std::bad_alloc&) {
    output = "{\"runtimeError\":\"MEMORY\"}";
  } catch (const valhalla_exception_t& error) {
    output = "{\"nativeError\":" + std::to_string(error.code) + "}";
  } catch (const std::exception&) {
    output = "{\"runtimeError\":\"ROUTING\"}";
  }
  return output.c_str();
}

const char* vb_stats() {
  output = "{\"decodedCacheBytes\":" + std::to_string(reader ? reader->bytes() : 0) +
           ",\"decodedCacheHits\":" + std::to_string(reader ? reader->hits : 0) +
           ",\"wasmHeapCapacityHighWaterBytes\":" + std::to_string(emscripten_get_heap_size()) +
           ",\"valhallaVersion\":\"" VALHALLA_VERSION "\",\"sourceRevision\":\"" VB_SOURCE_REVISION "\",\"abi\":3}";
  return output.c_str();
}
}

#include <valhalla/tyr/actor.h>
#include <valhalla/exceptions.h>
#include <valhalla/midgard/logging.h>
#include <boost/property_tree/json_parser.hpp>
#include <fstream>
#include <iostream>
#include <chrono>
#include <unordered_map>

class TracingReader : public valhalla::baldr::GraphReader {
public:
  explicit TracingReader(const boost::property_tree::ptree& config) : GraphReader(config) {}
  valhalla::baldr::graph_tile_ptr GetGraphTile(const valhalla::baldr::GraphId& id) override {
    const bool cached = cache_->Contains(id.tile_base());
    auto tile = GraphReader::GetGraphTile(id);
    if (tile && !cached) reads[id.tile_base().value] = tile->header()->end_offset();
    return tile;
  }
  std::unordered_map<uint64_t, size_t> reads;
};

int main(int argc, char** argv) {
  if (argc != 3 && argc != 4) {
    std::cerr << "usage: native-reference config.json requests.jsonl [metrics.jsonl]\n";
    return 2;
  }
  boost::property_tree::ptree config;
  valhalla::midgard::logging::Configure({{"type", "std_err"}});
  boost::property_tree::read_json(argv[1], config);
  TracingReader reader(config.get_child("mjolnir"));
  if (std::string(argv[2]) == "--inspect") {
    size_t nodes = 0, timezone_nodes = 0, admin_nodes = 0, tiles = 0;
    for (const auto& id : reader.GetTileSet()) {
      auto tile = reader.GetGraphTile(id);
      ++tiles;
      for (uint32_t i = 0; i < tile->header()->nodecount(); ++i) {
        const auto* node = tile->node(i);
        ++nodes;
        if (node->timezone() != 0) ++timezone_nodes;
        if (!tile->admininfo(node->admin_index()).country_iso().empty()) ++admin_nodes;
      }
    }
    std::cout << "{\"tiles\":" << tiles << ",\"nodes\":" << nodes
              << ",\"nodesWithTimezone\":" << timezone_nodes
              << ",\"nodesWithCountry\":" << admin_nodes << "}\n";
    return 0;
  }
  valhalla::tyr::actor_t actor(config, reader, true);
  std::ofstream metrics;
  if (argc == 4) metrics.open(argv[3]);
  std::ifstream input(argv[2]);
  std::string request;
  while (std::getline(input, request)) {
    reader.reads.clear();
    const auto start = std::chrono::steady_clock::now();
    try {
      std::cout << actor.route(request) << '\n';
    } catch (const valhalla::valhalla_exception_t& e) {
      std::cout << "{\"nativeError\":" << e.code << "}\n";
    }
    if (metrics) {
      const auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
      metrics << "{\"routeMs\":" << elapsed << ",\"tileReads\":[";
      bool first = true;
      for (const auto& [id, size] : reader.reads) {
        if (!first) metrics << ',';
        first = false;
        metrics << "{\"id\":\"" << id << "\",\"bytes\":" << size << '}';
      }
      metrics << "]}\n";
    }
  }
}

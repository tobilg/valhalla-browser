---
title: Travel profiles and options
---

# Travel profiles and options

Choose `auto` (driving), `bicycle` (cycling), `pedestrian` (walking), or `truck`
on each route request. Omitted `costing` means `auto`. The native Valhalla 3.8.3
costing model computes each route; the SDK does not approximate modes by changing
driving speed. The same Router can switch profiles while retaining its tile cache.

## Typed settings

Use the native grouping, for example
`costing_options: { bicycle: { bicycle_type: 'hybrid', cycling_speed: 18 } }`.
Only the group matching the selected profile is accepted. TypeScript rejects
mismatched settings; runtime validation also protects JavaScript callers.
Unknown fields, invalid types, non-finite numbers, and out-of-range values produce
`INVALID_REQUEST`. Omitted fields use the pinned engine's defaults.

| Profile | Field | Accepted values | Native default |
| --- | --- | --- | --- |
| Bicycle | `bicycle_type` | `road`, `cross`, `hybrid`, `mountain` | `hybrid` |
| Bicycle | `cycling_speed` | 5–60 km/h on smooth flat roads | road 25, cross 20, hybrid 18, mountain 16 |
| Bicycle | `use_roads` | 0–1; lower values prefer avoiding roads | 0.25 |
| Pedestrian | `walking_speed` | 0.5–25 km/h | 5.1 |
| Truck | `height` | 0–10 meters | 4.11 |
| Truck | `width` | 0–10 meters | 2.6 |
| Truck | `length` | 0–50 meters | 21.64 |
| Truck | `weight` | 0–100 metric tonnes, total vehicle weight | 21.77 |
| Truck | `axle_load` | 0–40 metric tonnes | 9.07 |
| Truck | `hazmat` | boolean | false |

The SDK preserves Valhalla's accepted ranges, including zero-valued truck
attributes. Supply the actual vehicle attributes when restrictions matter.
`use_roads` is a preference, not a prohibition. Truck checks depend on restrictions
present in the OSM input. The data workflow does not add elevation inputs, so
the regional fixture does not establish elevation-aware cycling quality.

The current walking profile uses native `foot` defaults. Wheelchair-specific
settings, additional vehicle profiles, transit, and bike-and-train are not exposed.
Two endpoints, kilometers, English instructions, and the existing correlation
defaults apply to every supported profile.

## Dataset capabilities and migration

`await router.initialize()` returns `supportedCostings`, the intersection of the
dataset's `costings` list and this SDK's profiles. A request for an unavailable
profile produces `UNSUPPORTED_COSTING` without discarding the worker or its cache.
Initialization rejects datasets with no supported profiles.

Manifests with `costings: ['auto']` remain driving-only, even if their tiles
contain bicycle and pedestrian access. Upgrade with the pinned data workflow:

```sh
pnpm run data             # Synthetic native verification fixture
pnpm run data:region      # Historical Liechtenstein fixture with all four profiles
# For your own OSM PBF, follow the graph-building guide's pnpm run data:osm command.
```

The costing list participates in release identity. New output lives under a new
`public/datasets/<release>/` directory; existing releases remain unchanged.
Upload the **contents of that release directory into one matching remote release
directory**, then prepare its delivery manifest using the hosting guide. Do not
nest the release directory twice or overwrite an older immutable manifest.

Point your application's `manifestUrl`, or the demo's `VITE_DEMO_MANIFEST_URL`,
at the new manifest. The deployed demo requires a rebuild after changing that
environment variable. No purge of the old dataset is needed. Deployment URLs in
examples are placeholders for your own public objects.

See [Build graph data from OpenStreetMap](../../../docs/building-graph-data.md)
and [Host graph data on object storage](../../../docs/object-storage-hosting.md).
The demo starts lazily, learns capabilities on initialization, and disables
unavailable profiles without silently substituting driving.

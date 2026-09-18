import { map, tileLayer, layerGroup, polyline, circleMarker, latLngBounds } from 'leaflet';
import 'leaflet/dist/leaflet.css';

export function createRouteMap(element, { toggle, fitButton, status }) {
  const view = map(element, { scrollWheelZoom: false, minZoom: 2, maxZoom: 19 });
  const provider = document.createElement('span');
  provider.textContent = import.meta.env.VITE_DEMO_BASEMAP_ATTRIBUTION?.trim() ?? '';
  const basemap = tileLayer(import.meta.env.VITE_DEMO_BASEMAP_URL?.trim() || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    className: 'demo-basemap',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' +
      (provider.textContent ? ` · ${provider.innerHTML}` : ''),
    maxZoom: 19, updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 0,
    referrerPolicy: 'strict-origin-when-cross-origin',
  });
  basemap.on('loading', () => { status.textContent = ''; });
  basemap.on('tileerror', () => {
    status.textContent = 'Some basemap tiles could not be loaded. Routing is still available.';
  });
  if (toggle.checked) basemap.addTo(view);
  toggle.onchange = () => {
    status.textContent = '';
    if (toggle.checked) basemap.addTo(view);
    else view.removeLayer(basemap);
  };

  const geometry = layerGroup().addTo(view);
  let bounds;
  const fit = () => { if (bounds) view.fitBounds(bounds, { padding: [36, 36], maxZoom: 16, animate: false }); };
  fitButton.onclick = fit;
  function endpoints(coordinates) {
    for (const [index, position] of [coordinates[0], coordinates.at(-1)].entries()) {
      circleMarker(position, { radius: 7, color: '#fff', weight: 3,
        fillColor: index === 0 ? '#244f3b' : '#202823', fillOpacity: 1,
        className: 'route-endpoint', interactive: false })
        .bindTooltip(index === 0 ? 'Origin' : 'Destination', { permanent: true, direction: 'top', offset: [0, -8] })
        .addTo(geometry);
    }
  }
  return {
    preview(locations) {
      geometry.clearLayers();
      const coordinates = locations.map(({ lat, lon }) => [lat, lon]);
      bounds = latLngBounds(coordinates);
      endpoints(coordinates);
      fitButton.disabled = true;
      fit();
    },
    draw(coordinates) {
      geometry.clearLayers();
      // Valhalla's decoded coordinates are longitude/latitude; Leaflet uses latitude/longitude.
      const positions = coordinates.map(([lon, lat]) => [lat, lon]);
      polyline(positions, { color: '#fff', weight: 8, opacity: .9, interactive: false }).addTo(geometry);
      const line = polyline(positions, { color: '#244f3b', weight: 5, opacity: 1,
        className: 'route-line', interactive: false }).addTo(geometry);
      endpoints(positions);
      bounds = line.getBounds();
      fitButton.disabled = false;
      fit();
    },
  };
}

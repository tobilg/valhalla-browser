import { Router } from 'valhalla-browser';

const $ = id => document.getElementById(id);
const discovery = await (await fetch('/manifest.json')).json();
const datasets = [{ id: 'fixture', name: 'Synthetic fixture · local HTTP', ...discovery, requestsUrl: '/fixtures/requests.json' }];
const optional = async url => { const response = await fetch(url); return response.ok ? response.json() : null; };
const [region, minio, r2] = await Promise.all([optional('/public/region.json'), optional('/public/minio.json'), optional('/public/r2.json')]);
if (region) datasets.push({ id: 'region', name: 'Liechtenstein 2015 · local HTTP', ...region, requestsUrl: '/fixtures/region/requests.json' });
for (const item of minio?.datasets ?? []) datasets.push({ ...item, id: item.requestsUrl.includes('/region/') ? 'minio-region' : 'minio-fixture' });
if (r2) datasets.push({ ...r2, id: 'r2-region' });
let router, active, lastDiagnostics, fixtures, selected;
for (const dataset of datasets) $('dataset').add(new Option(dataset.name, dataset.id));
const requestedDataset = new URL(location.href).searchParams.get('dataset');
if (datasets.some(d => d.id === requestedDataset)) $('dataset').value = requestedDataset;
async function selectDataset() {
  $('route').disabled = true; $('dataset').disabled = true;
  try {
    await router?.dispose(); router = undefined;
    selected = datasets.find(d => d.id === $('dataset').value);
    fixtures = await (await fetch(selected.requestsUrl)).json();
    $('preset').replaceChildren(...fixtures.map(f => new Option(f.name, f.name)));
    $('preset').value = selected.requestsUrl.includes('/region/') ? 'balzers-ruggell' : 'cross-tile';
    selectFixture();
    $('geometry').replaceChildren(); $('maneuvers').replaceChildren();
    $('summary').textContent = 'Select a test journey';
    $('attribution').textContent = selected.requestsUrl.includes('/region/')
      ? '© OpenStreetMap contributors · ODbL 1.0 · July 2015 historical benchmark extract · not for navigation'
      : 'Synthetic test roads · not for navigation';
    $('status').textContent = 'Ready to initialize.';
    lastDiagnostics = undefined; $('diagnostics').textContent = 'No measurements yet.';
  } finally { $('route').disabled = false; $('dataset').disabled = false; }
}
function selectFixture() {
  const [from, to] = fixtures.find(f => f.name === $('preset').value).request.locations;
  $('from-lat').value = from.lat; $('from-lon').value = from.lon;
  $('to-lat').value = to.lat; $('to-lon').value = to.lon;
}
$('preset').onchange = selectFixture;
$('dataset').onchange = selectDataset;
await selectDataset();
$('transport').onchange = async () => { await router?.dispose(); router = undefined; };

function points(shape) {
  let i = 0, lat = 0, lon = 0;
  const output = [];
  function delta() {
    let value = 0, shift = 0, byte;
    do { byte = shape.charCodeAt(i++) - 63; value |= (byte & 31) << shift; shift += 5; } while (byte >= 32);
    return value & 1 ? ~(value >> 1) : value >> 1;
  }
  while (i < shape.length) { lat += delta(); lon += delta(); output.push([lon / 1e6, lat / 1e6]); }
  return output;
}

function draw(native) {
  const coordinates = native.trip.legs.flatMap(leg => points(leg.shape));
  const xs = coordinates.map(p => p[0]), ys = coordinates.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min(560 / Math.max(maxX - minX, .00001), 360 / Math.max(maxY - minY, .00001));
  const xy = coordinates.map(([x,y]) => [320 + (x - (minX+maxX)/2)*scale, 220 - (y - (minY+maxY)/2)*scale]);
  $('geometry').replaceChildren();
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  for (const [key,value] of Object.entries({ points: xy.map(p=>p.join(',')).join(' '), fill:'none', stroke:'#286c43', 'stroke-width':'4', 'stroke-linejoin':'round' })) line.setAttribute(key,value);
  $('geometry').append(line);
  for (const p of [xy[0],xy.at(-1)]) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg','circle');
    circle.setAttribute('cx',p[0]);circle.setAttribute('cy',p[1]);circle.setAttribute('r','6');circle.setAttribute('fill','#183529');$('geometry').append(circle);
  }
  $('summary').textContent = `${native.trip.summary.length.toFixed(3)} km · ${Math.round(native.trip.summary.time)} seconds`;
  $('maneuvers').replaceChildren(...native.trip.legs.flatMap(leg=>leg.maneuvers).map(m=>{const li=document.createElement('li');li.textContent=m.instruction;return li;}));
}

$('route-form').onsubmit = async event => {
  event.preventDefault();
  if (active) return;
  active = new AbortController();
  $('status').textContent = 'Preparing the routing engine…';
  $('cancel').disabled = false; $('route').disabled = true; $('transport').disabled = true; $('dataset').disabled = true;
  try {
    router ??= new Router({ manifestUrl: selected.manifestUrl, transport: $('transport').value,
      onProgress: event => { $('status').textContent = event.phase === 'fetching-tile' ? 'Loading road data…' : event.phase === 'routing' ? 'Calculating…' : 'Preparing the routing engine…'; } });
    const startup = await router.initialize();
    const result = await router.route({ origin: {lat: +$('from-lat').value, lon: +$('from-lon').value}, destination: {lat: +$('to-lat').value, lon: +$('to-lon').value} }, { signal: active.signal });
    draw(result.native);
    lastDiagnostics = { startup, route: result.diagnostics, dataset: result.dataset, session: await router.diagnostics() };
    $('diagnostics').textContent = JSON.stringify(lastDiagnostics,null,2);
    $('status').textContent = 'Route calculated in your browser.';
  } catch (error) { $('status').textContent = `${error.code ?? 'ERROR'}: ${error.message}`; }
  finally { $('cancel').disabled = true; $('route').disabled = false; $('transport').disabled = false; $('dataset').disabled = false; active = undefined; }
};
$('cancel').onclick = () => { active?.abort(); router?.cancel(); };
$('export').onclick = () => {
  if (!lastDiagnostics) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(lastDiagnostics,null,2)], {type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='valhalla-diagnostics.json';a.click();URL.revokeObjectURL(url);
};

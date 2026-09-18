import assert from 'node:assert/strict';

export const isBasemapRequest = url => /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(url);

// Never pan/zoom against the community OSM tile servers in automated tests.
// Only background images are substituted; all routing/graph requests stay real.
export async function mockBasemap(page) {
  const requests = [];
  let failing = false;
  await page.route('https://tile.openstreetmap.org/**', async route => {
    const url = route.request().url();
    assert(isBasemapRequest(url), `Unexpected basemap request: ${url}`);
    requests.push(url);
    await route.fulfill(failing ? { status: 503, body: '' } : {
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#edf1e7"/><path d="M0 0H256V256H0Z M128 0V256 M0 128H256" stroke="#cbd8c7" fill="none"/><text x="12" y="24" fill="#758970" font-family="sans-serif" font-size="12">Test basemap tile</text></svg>',
    });
  });
  return { requests, setFailure: value => { failing = value; } };
}

export async function assertBasemap(page) {
  await page.waitForFunction(() => {
    const tiles = [...document.querySelectorAll('#geometry img.leaflet-tile')];
    return tiles.length > 0 && tiles.every(tile => tile.complete && tile.naturalWidth === 256);
  });
  assert(await page.locator('#geometry a[href="https://www.openstreetmap.org/copyright"]').isVisible());
  assert(await page.getByRole('button', { name: 'Zoom in', exact: true }).isVisible());
  assert.equal(await page.locator('#geometry .route-endpoint').count(), 2);
}

export async function exerciseMap(page, tiles) {
  await assertBasemap(page);
  assert.equal(await page.locator('#geometry .route-line').count(), 1);
  const before = await page.locator('#geometry .route-line').getAttribute('d');
  const originalBounds = await page.locator('#geometry .route-line').evaluate(line => {
    const route = line.getBoundingClientRect(), map = document.querySelector('#geometry').getBoundingClientRect();
    return { x: route.x - map.x, y: route.y - map.y, width: route.width, height: route.height };
  });
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForFunction(before => document.querySelector('#geometry .route-line')?.getAttribute('d') !== before, before);
  await page.getByRole('button', { name: 'Fit route', exact: true }).click();
  // Leaflet rebases its SVG coordinates when zooming. Compare the visible
  // position/size within the map (independent of page scrolling), allowing two
  // pixels for projection and pixel rounding.
  await page.waitForFunction(expected => {
    const route = document.querySelector('#geometry .route-line').getBoundingClientRect();
    const map = document.querySelector('#geometry').getBoundingClientRect();
    const actual = { x: route.x - map.x, y: route.y - map.y, width: route.width, height: route.height };
    return ['x', 'y', 'width', 'height'].every(key => Math.abs(actual[key] - expected[key]) <= 2);
  }, originalBounds);
  await page.getByLabel('Show basemap').uncheck();
  assert.equal(await page.locator('#geometry img.leaflet-tile').count(), 0);
  assert.equal(await page.locator('#geometry .route-line').count(), 1);
  // Leave image failures active so the caller can prove a real route still works.
  tiles.setFailure(true);
  await page.getByLabel('Show basemap').check();
  // Firefox may reuse decoded images after a toggle. Request an unseen zoom
  // level so the failure assertion exercises a fresh image download.
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#map-status').textContent.includes('could not be loaded'));
}

export async function restoreBasemap(page, tiles) {
  tiles.setFailure(false);
  await page.getByLabel('Show basemap').uncheck();
  await page.getByLabel('Show basemap').check();
  await assertBasemap(page);
  assert.equal(await page.locator('#map-status').textContent(), '');
}

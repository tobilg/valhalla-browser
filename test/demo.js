import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer, preview } from 'vite';
import { demoConfig } from '../packages/demo/vite.config.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRangeServer } from '../scripts/server.js';
import { mockBasemap, exerciseMap, restoreBasemap } from './demo-map.js';

const host=createRangeServer({faults:true});
const production=process.argv.includes('--preview');
const defaults=demoConfig(host);
const config={...defaults,configFile:false,server:{...defaults.server,port:0},preview:{...defaults.preview,port:0}};
const vite=production?await preview(config):await createServer(config);
if(!production)await vite.listen();
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1120,height:1000}});
try{
  const tiles=await mockBasemap(page);
  await page.goto(vite.resolvedUrls.local[0]);
  await page.getByRole('button',{name:'Calculate route'}).click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='Route calculated in your browser.');
  assert.match(await page.locator('#summary').textContent(),/5\.609 km/);
  assert.equal(await page.locator('#geometry .route-line').count(),1);
  assert((await page.locator('#maneuvers li').count())>0);
  await exerciseMap(page,tiles);
  await page.getByRole('button',{name:'Calculate route'}).click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='Route calculated in your browser.');
  assert.match(await page.locator('#summary').textContent(),/5\.609 km/);
  await restoreBasemap(page,tiles);
  host.setFault({type:'delay',delayMs:1000,match:'.gph'});
  await page.locator('#transport').selectOption('individual-tiles');
  await page.getByRole('button',{name:'Calculate route'}).click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='Loading road data…');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('CANCELLED'));
  host.setFault(null);
  await page.getByRole('button',{name:'Calculate route'}).click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='Route calculated in your browser.');
  assert.match(await page.locator('#summary').textContent(),/5\.609 km/);
  await mkdir('test-results',{recursive:true});
  const checks=['route controls and rendered geometry','basemap images, attribution, zoom, fit and toggle',
    'routing succeeds with failed basemap tiles','cancel during tile fetch','subsequent route'];
  const remote = process.argv.includes('--r2') ? 'r2' : process.argv.includes('--minio') ? 'minio' : null;
  if (remote) {
    await page.locator('#dataset').selectOption(`${remote}-region`);
    await page.waitForFunction(()=>document.querySelector('#preset').value==='balzers-ruggell'&&!document.querySelector('#route').disabled);
    await page.locator('#transport').selectOption('indexed-tar');
    await page.getByRole('button',{name:'Calculate route'}).click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent==='Route calculated in your browser.');
    assert.match(await page.locator('#summary').textContent(),/21\.838 km/);
    assert.match(await page.locator('#attribution').textContent(),/OpenStreetMap/);
    assert.match(await page.locator('#diagnostics').textContent(),/liechtenstein-2015/);
    await page.getByRole('button',{name:'Calculate route'}).click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent==='Route calculated in your browser.');
    const diagnostics=JSON.parse(await page.locator('#diagnostics').textContent());
    assert.equal(diagnostics.route.loader.requests,0);
    checks.push(`switch dataset to real regional ${remote} graph`,'regional geometry rendered',`same-worker ${remote} cache reuse`);
  }
  const name=production?'demo-preview':'demo';
  await page.screenshot({path:`test-results/${name}.png`,fullPage:true});
  await writeFile(`test-results/${name}.json`,JSON.stringify({passed:true,mode:production?'production':'development',browser:browser.version(),checks,originRecords:host.records,basemap:'local test images; no public OSM requests',basemapRequests:tiles.requests.length},null,2));
  console.log('PASS demo route, cancellation, recovery, and rendered geometry');
}finally{
  await browser.close();
  if(production)await new Promise(resolve=>vite.httpServer.close(resolve));
  else await vite.close();
}

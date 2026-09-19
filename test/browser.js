import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import { createRangeServer } from '../scripts/server.js';

const reference = JSON.parse(await readFile(new URL('../fixtures/reference.json',import.meta.url)));
const manifest = JSON.parse(await readFile(new URL('../fixtures/manifest.json',import.meta.url)));
const host = createRangeServer({faults:true});
host.server.listen(0,'127.0.0.1');
await once(host.server,'listening');
const base = `http://127.0.0.1:${host.server.address().port}`;
const engineName = process.env.BROWSER ?? 'chromium';
const engine = { chromium, firefox, webkit }[engineName];
if (!engine) throw new Error(`Unknown BROWSER: ${engineName}`);
const browser = await engine.launch({headless:true});
const report = { at:new Date().toISOString(), engine:engineName, browser:browser.version(), device:{platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0].model,memoryBytes:os.totalmem()},
  release:reference.release, valhallaRevision:reference.valhallaRevision, configSha256:reference.configSha256,
  cdn:'none; loopback origin', cases:[], tests:[], measurements:[] };
const contexts = [];

async function page(transport='indexed-tar', options={}) {
  const context=await browser.newContext();contexts.push(context);
  const p=await context.newPage();
  p.on('pageerror',error=>console.error('PAGE',error));
  await p.goto(base);
  await p.evaluate(async ({transport,options})=>{
    const {Router}=await import('/dist/index.js');
    const {manifestUrl}=await(await fetch('/manifest.json')).json();
    window.progress=[];window.heartbeats=0;
    setInterval(()=>window.heartbeats++,10);
    window.router=new Router({manifestUrl,transport,onProgress:e=>window.progress.push(e),...options});
  },{transport,options});
  return p;
}
const initialize = p=>p.evaluate(()=>window.router.initialize());
const route = (p,request)=>p.evaluate(async request=>{
  try{return {result:await window.router.route(request)};}
  catch(e){return {error:{code:e.code,nativeCode:e.nativeCode,retryable:e.retryable,message:e.message}};}
},request);
const cross=reference.cases.find(c=>c.name==='cross-tile');
function equivalent(actual,expected) {
  if(expected.nativeError===171){assert.equal(actual.error?.code,'OUTSIDE_COVERAGE');return;}
  if(expected.nativeError!==undefined){assert.equal(actual.error?.nativeCode,expected.nativeError,JSON.stringify(actual));return;}
  assert(!actual.error,JSON.stringify(actual));
  // Compare the entire Valhalla response first; any tolerance must be justified from actual differences.
  assert.deepEqual(actual.result.native,expected);
  assert.equal(actual.result.dataset.release,reference.release);
}
async function check(name,body) {
  const started=performance.now();
  await body();
  report.tests.push({name,passed:true,elapsedMs:performance.now()-started});console.log(`PASS ${name}`);
}

try {
  await check('M1: actual WASM worker with local memory files matches native corpus',async()=>{
    const p=await page();
    const result=await p.evaluate(async ({requests,manifestUrl})=>{
      const worker=new Worker('/test/local-worker.js',{type:'module'});
      return new Promise((resolve,reject)=>{
        worker.onmessage=({data})=>{worker.terminate();resolve(data);};
        worker.onerror=e=>{worker.terminate();reject(new Error(e.message));};
        worker.postMessage({requests,manifestUrl});
      });
    },{requests:reference.cases.map(c=>c.request),manifestUrl:`${base}/datasets/${manifest.release}/manifest.json`});
    assert(!result.error,result.error);assert.deepEqual(result.results,reference.cases.map(c=>c.expected));
    await p.close();
  });
  for(const transport of ['indexed-tar','individual-tiles']) {
    await check(`${transport}: native corpus, cold selective loading, same-worker reuse`,async()=>{
      const p=await page(transport);
      const mark=host.records.length;
      const startup=await initialize(p);
      report.measurements.push({transport,state:'new worker, new browser context; HTTP cache not explicitly cleared',startup});
      const cold=await route(p,cross.request);equivalent(cold,cross.expected);
      assert(cold.result.diagnostics.loader.tileDownloads>=2,'Cold route must fetch multiple tiles');
      const warm=await route(p,cross.request);equivalent(warm,cross.expected);
      assert.equal(warm.result.diagnostics.loader.tileDownloads,0);
      assert(warm.result.diagnostics.decodedCacheHits>0);
      report.measurements.push({transport,state:'cold worker',...cold.result.diagnostics},{transport,state:'same worker repeated route',...warm.result.diagnostics});
      for(const fixture of reference.cases){const actual=await route(p,fixture.request);equivalent(actual,fixture.expected);report.cases.push({transport,name:fixture.name,diagnostics:actual.result?.diagnostics,error:actual.error});}
      const records=host.records.slice(mark).filter(r=>r.path.endsWith('graph.tar')||r.path.endsWith('.gph'));
      if(transport==='indexed-tar'){
        assert(records.every(r=>r.status===206&&r.range&&r.bodyBytes<Number(manifest.archive.size)));
        assert(startup.loader.requests>=2,'Native initialization must fetch header and index');
      }
      report.measurements.push({transport,originRequests:records});
      await p.close();
    });
  }

  await check('delayed native initialization, suspension and serialized concurrent host submissions',async()=>{
    host.setFault({type:'delay',delayMs:120,remaining:20,match:'graph.tar'});
    const p=await page();
    const startup=await initialize(p);
    assert(startup.graphStartupMs>=200);
    const responses=await p.evaluate(async request=>Promise.all([window.router.route(request),window.router.route(request),window.router.route(request)]),cross.request);
    for(const result of responses)equivalent({result},cross.expected);
    assert(responses[0].diagnostics.loader.sequentialWaitMs>=200);
    assert.equal(responses[1].diagnostics.loader.tileDownloads,0);
    assert(await p.evaluate(()=>window.heartbeats)>20,'Main thread must remain responsive during worker work');
    host.setFault(null);await p.close();
  });

  await check('mixed profiles serialize without option leakage and retain decoded tiles',async()=>{
    const p=await page();
    assert.deepEqual((await initialize(p)).supportedCostings,['auto','bicycle','pedestrian','truck']);
    const names=['cross-tile-bicycle','short-bicycle-configured','cross-tile-pedestrian','short-pedestrian-configured','cross-tile-truck','truck-height-restricted','truck-height-allowed','cross-tile'];
    const fixtures=names.map(name=>reference.cases.find(c=>c.name===name));
    for(let repeat=0;repeat<2;repeat++){
      const results=await p.evaluate(requests=>Promise.all(requests.map(request=>window.router.route(request))),fixtures.map(c=>c.request));
      results.forEach((result,i)=>{equivalent({result},fixtures[i].expected);if(repeat)assert.equal(result.diagnostics.loader.requests,0);});
    }
    await p.close();
  });

  for(const costings of [['auto'],['bicycle'],['auto','future-profile']])await check(`dataset capabilities ${costings} reject unsupported routes without resetting the actor`,async()=>{
    const p=await page();
    await p.route(`**/datasets/${manifest.release}/manifest.json`,async intercepted=>{
      const response=await intercepted.fetch();
      const body=JSON.stringify({...await response.json(),costings});
      await intercepted.fulfill({response,body,headers:{...response.headers(),'content-length':String(Buffer.byteLength(body))}});
    });
    assert.deepEqual((await initialize(p)).supportedCostings,costings.filter(c=>c!=='future-profile'));
    const allowed=costings.includes('auto')?cross:reference.cases.find(c=>c.name==='cross-tile-bicycle');
    equivalent(await route(p,allowed.request),allowed.expected);
    const mark=host.records.length;
    const rejected=await route(p,{...cross.request,costing:costings.includes('auto')?'bicycle':'auto'});
    assert.equal(rejected.error?.code,'UNSUPPORTED_COSTING');
    assert.equal(host.records.length,mark,'Capability rejection does not fetch or enter routing');
    const recovered=await route(p,allowed.request);equivalent(recovered,allowed.expected);
    assert.equal(recovered.result.diagnostics.loader.requests,0);
    await p.close();
  });

  await check('cancel cycling tile loading, then route on foot in a fresh worker',async()=>{
    const p=await page();await initialize(p);
    const cancelled=await p.evaluate(async request=>{
      window.router.options.onProgress=event=>{if(event.phase==='fetching-tile')window.router.cancel();};
      try{await window.router.route({...request,costing:'bicycle'});return null;}
      catch(error){return error.code;}
      finally{window.router.options.onProgress=undefined;}
    },cross.request);
    assert.equal(cancelled,'CANCELLED');
    const walking=reference.cases.find(c=>c.name==='cross-tile-pedestrian');
    equivalent(await route(p,walking.request),walking.expected);await p.close();
  });

  for(const [type,code] of [['ignore-range','RANGE_UNSUPPORTED'],['wrong-range','INVALID_RANGE'],['mismatch','DATASET_MISMATCH'],['transient','NETWORK'],['truncated',null],['drop','NETWORK'],['corrupt','CORRUPT_TILE'],['missing','INCOMPLETE_DATASET']]) {
    await check(`tile ${type} rejects and subsequent route succeeds in same actor`,async()=>{
      const p=await page('indexed-tar',{retries:0,timeoutMs:700});await initialize(p);
      // Chromium can transparently replay GETs after connection/validator failures.
      host.setFault({type,match:'graph.tar',tileOnly:true,remaining: ['mismatch','drop'].includes(type) ? 10 : 1});
      const failed=await route(p,cross.request);
      assert(failed.error,JSON.stringify(failed));
      if(code)assert.equal(failed.error.code,code);else assert(['DATASET','NETWORK','TIMEOUT'].includes(failed.error.code));
      host.setFault(null);
      equivalent(await route(p,cross.request),cross.expected);
      await p.close();
    });
  }

  await check('failed native initialization can be retried on the same Router',async()=>{
    const p=await page('indexed-tar',{retries:0});
    host.setFault({type:'transient',match:'graph.tar'});
    const error=await p.evaluate(()=>window.router.initialize().then(()=>null,e=>e.code));
    assert.equal(error,'NETWORK');
    await initialize(p);equivalent(await route(p,cross.request),cross.expected);await p.close();
  });

  await check('cancel then recover from one failed replacement worker script with concurrent submissions',async()=>{
    const p=await page();await initialize(p);
    const cancelled=await p.evaluate(async request=>{
      window.router.options.onProgress=event=>{if(event.phase==='fetching-tile')window.router.cancel();};
      try{await window.router.route(request);return 'unexpected success';}
      catch(error){return error.code;}
      finally{window.router.options.onProgress=undefined;}
    },cross.request);
    assert.equal(cancelled,'CANCELLED');
    const mark=host.records.length;
    host.setFault({type:'transient',match:'/dist/worker.js'});
    const results=await p.evaluate(async request=>Promise.all([
      window.router.route(request),window.router.route(request),
    ]),cross.request);
    for(const result of results)equivalent({result},cross.expected);
    const boots=host.records.slice(mark).filter(r=>r.path==='/dist/worker.js');
    assert.equal(boots.length,2,'Exactly one shared replacement startup retry');
    assert.equal(boots[0].status,503);
    assert([200,304].includes(boots[1].status));
    assert.equal(results[1].diagnostics.loader.requests,0,'Concurrent recovery still serializes actor calls');
    await p.close();
  });

  for(const retries of [0,2])await check(`persistent worker-load failure rejects after ${retries===0?'one attempt':'one retry'}`,async()=>{
    const p=await page('indexed-tar',{retries});
    const mark=host.records.length;
    host.setFault({type:'transient',match:'/dist/worker.js',remaining:20});
    assert.equal(await p.evaluate(()=>window.router.initialize().then(()=>null,error=>error.code)),'WORKER_FAILED');
    assert.equal(host.records.slice(mark).filter(r=>r.path==='/dist/worker.js').length,retries===0?1:2);
    host.setFault(null);
    equivalent(await route(p,cross.request),cross.expected);
    await p.close();
  });

  for(const operation of ['cancel','dispose'])await check(`${operation} interrupts worker startup recovery`,async()=>{
    const p=await page();
    // Interrupt the backoff after a real HTTP script failure, before its replacement starts.
    await p.evaluate(operation=>{
      const Original=Worker;
      window.Worker=class extends Original{
        constructor(...args){super(...args);this.addEventListener('error',()=>setTimeout(()=>window.router[operation](),10));}
      };
    },operation);
    const mark=host.records.length;
    host.setFault({type:'transient',match:'/dist/worker.js'});
    assert.equal(await p.evaluate(()=>window.router.initialize().then(()=>null,error=>error.code)),operation==='cancel'?'CANCELLED':'DISPOSED');
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(host.records.slice(mark).filter(r=>r.path==='/dist/worker.js').length,1,'No worker may restart after cancellation/disposal');
    if(operation==='cancel')equivalent(await route(p,cross.request),cross.expected);
    await p.close();
  });

  await check('AbortSignal interrupts route-triggered initialization and recovers',async()=>{
    const p=await page();
    host.setFault({type:'delay',delayMs:1500,match:'graph.tar'});
    await p.evaluate(request=>{
      window.controller=new AbortController();
      window.initialRoute=window.router.route(request,{signal:window.controller.signal}).then(()=>null,e=>e.code);
    },cross.request);
    await p.waitForFunction(()=>window.progress.some(e=>e.phase==='initializing-graph'));
    await p.evaluate(()=>window.controller.abort());
    assert.equal(await p.evaluate(()=>window.initialRoute),'CANCELLED');
    host.setFault(null);equivalent(await route(p,cross.request),cross.expected);await p.close();
  });

  await check('hard decoded-cache eviction retains correct tile buffer lifetimes',async()=>{
    // Fit each tile, but not all tiles needed by the cross-tile route at once.
    const budget=Math.max(...Object.values(manifest.tiles).map(tile=>Number(tile.size)));
    const p=await page('indexed-tar',{memoryBudgetBytes:budget});await initialize(p);
    const first=await route(p,cross.request);equivalent(first,cross.expected);
    const second=await route(p,cross.request);equivalent(second,cross.expected);
    assert(first.result.diagnostics.native.decodedCacheBytes<=budget);
    assert(second.result.diagnostics.native.decodedCacheBytes<=budget);
    assert(second.result.diagnostics.loader.tileDownloads>0,'Evicted tiles must reload');
    report.measurements.push({cacheEvictionBudgetBytes:budget,first:first.result.diagnostics,second:second.result.diagnostics});
    await p.close();
  });

  await check('cache smaller than one tile rejects explicitly and initialization can recover',async()=>{
    const p=await page('indexed-tar',{memoryBudgetBytes:1024});
    assert.equal(await p.evaluate(()=>window.router.initialize().then(()=>null,e=>e.code)),'INVALID_REQUEST');
    await p.evaluate(()=>{window.router.options.memoryBudgetBytes=32*1024*1024;});
    equivalent(await route(p,cross.request),cross.expected);await p.close();
  });

  await check('cancel during suspended fetch terminates worker and subsequent route succeeds',async()=>{
    const p=await page();await initialize(p);
    host.setFault({type:'delay',delayMs:1500,remaining:1,match:'graph.tar',tileOnly:true});
    await p.evaluate(request=>{window.pendingResult=window.router.route(request).then(()=>({stale:true}),e=>({code:e.code}));},cross.request);
    await p.waitForFunction(()=>window.progress.some(e=>e.phase==='fetching-tile'));
    const start=performance.now();
    await p.evaluate(()=>window.router.cancel());
    assert.deepEqual(await p.evaluate(()=>window.pendingResult),{code:'CANCELLED'});
    report.measurements.push({cancellation:'during pending fetch',elapsedMs:performance.now()-start});
    host.setFault(null);equivalent(await route(p,cross.request),cross.expected);await p.close();
  });

  await check('cancel queued or computing warm operations suppresses stale results',async()=>{
    const p=await page();await initialize(p);equivalent(await route(p,cross.request),cross.expected);
    const cancelled=await p.evaluate(async request=>{
      const controller=new AbortController();
      const promise=window.router.route(request,{signal:controller.signal}).then(()=>false,e=>e.code);
      controller.abort();return promise;
    },cross.request);
    assert.equal(cancelled,'CANCELLED');
    equivalent(await route(p,cross.request),cross.expected);await p.close();
  });

  await check('hard cancellation interrupts uninterrupted real actor CPU work',async()=>{
    const p=await page();
    await p.evaluate(async()=>{
      const {Router}=await import('/dist/index.js');
      let first=true;
      const {manifestUrl}=await(await fetch('/manifest.json')).json();
      window.router=new Router({manifestUrl,onProgress:e=>window.progress.push(e),workerFactory:()=>{
        const worker=new Worker(first?'/test/cpu-worker.js':'/dist/worker.js',{type:'module'});first=false;return worker;
      }});
      await window.router.initialize();
    });
    await p.evaluate(request=>{window.cpuResult=window.router.route(request).then(()=>({stale:true}),e=>({code:e.code}));},cross.request);
    await p.waitForFunction(()=>window.progress.some(e=>e.phase==='routing-cpu'));
    await new Promise(resolve=>setTimeout(resolve,50));
    const started=performance.now();await p.evaluate(()=>window.router.cancel());
    assert.deepEqual(await p.evaluate(()=>window.cpuResult),{code:'CANCELLED'});
    report.measurements.push({cancellation:'CPU: uninterrupted loop of real warm actor routes',elapsedMs:performance.now()-started});
    equivalent(await route(p,cross.request),cross.expected);await p.close();
  });

  if(process.argv.includes('--benchmark')){
    for(const transport of ['indexed-tar','individual-tiles']){
      const cold=[];
      for(let i=0;i<10;i++){
        const p=await page(transport);
        const cdp=await p.context().newCDPSession(p);await cdp.send('Network.clearBrowserCache');
        const startup=await initialize(p);
        const actual=await route(p,cross.request);equivalent(actual,cross.expected);
        cold.push({startup,...actual.result.diagnostics});await p.close();
      }
      const coldSorted=cold.map(s=>s.hostRouteMs).sort((a,b)=>a-b);
      report.measurements.push({transport,sampleCount:cold.length,state:'cold worker; HTTP cache explicitly cleared; engine compilation cache not controlled',metric:'hostRouteMs',p50Ms:coldSorted[4],p95Ms:coldSorted[9],samples:cold});
      const p=await page(transport);await initialize(p);equivalent(await route(p,cross.request),cross.expected);
      const samples=[];
      for(let i=0;i<20;i++){const actual=await route(p,cross.request);equivalent(actual,cross.expected);samples.push(actual.result.diagnostics);}
      const sorted=samples.map(s=>s.hostRouteMs).sort((a,b)=>a-b);
      report.measurements.push({transport,sampleCount:samples.length,state:'warm worker after one unmeasured route',metric:'hostRouteMs',p50Ms:sorted[9],p95Ms:sorted[18],samples});
      await p.close();
    }
    await check('M3: observe identical and overlapping ranges, reload and page reopen',async()=>{
      const context=await browser.newContext();contexts.push(context);
      let p=await context.newPage();await p.goto(base);
      const cdp=await context.newCDPSession(p);await cdp.send('Network.clearBrowserCache');
      const archive=`${base}/datasets/${manifest.release}/graph.tar`;
      const first=Object.values(manifest.tiles)[0];
      const individual=`${base}/datasets/${manifest.release}/tiles/${first.path}`;
      async function sample(label,url,range){
        const mark=host.records.length;
        const observation=await p.evaluate(async({url,range})=>{
          performance.clearResourceTimings();const start=performance.now();
          const response=await fetch(url,{headers:range?{Range:range}:{}});
          const body=await response.arrayBuffer();
          const entry=performance.getEntriesByName(url).at(-1);
          return {status:response.status,bodyBytes:body.byteLength,elapsedMs:performance.now()-start,
            timing:entry?{transferSize:entry.transferSize,encodedBodySize:entry.encodedBodySize,decodedBodySize:entry.decodedBodySize}:null};
        },{url,range});
        assert.equal(observation.status,range?206:200);
        assert.equal(observation.bodyBytes,range?512:Number(first.size));
        const records=host.records.slice(mark);
        report.measurements.push({httpCacheExperiment:label,url,range,...observation,
          originRequests:records.filter(r=>r.path===new URL(url).pathname),backgroundRequests:records.filter(r=>r.path!==new URL(url).pathname)});
      }
      await sample('initial range; browser cache explicitly cleared',archive,'bytes=0-511');
      await sample('identical range, same page',archive,'bytes=0-511');
      await sample('overlapping range',archive,'bytes=256-767');
      await sample('initial individual object',individual);
      await sample('identical individual object',individual);
      await p.reload();
      await sample('range after reload',archive,'bytes=0-511');await sample('individual after reload',individual);
      await p.close();p=await context.newPage();await p.goto(base);
      await sample('range after page close/reopen; same browser context',archive,'bytes=0-511');
      await sample('individual after page close/reopen',individual);
      await p.close();
    });
  }
  report.passed=true;
}catch(error){report.passed=false;report.failure={message:error.message,stack:error.stack};throw error;}
finally{
  report.originRecords=host.records;
  await mkdir('test-results',{recursive:true});
  await writeFile(`test-results/browser${engineName === 'chromium' ? '' : `-${engineName}`}.json`,JSON.stringify(report,null,2)+'\n');
  for(const context of contexts)await context.close();
  await browser.close();host.server.closeAllConnections();await new Promise(resolve=>host.server.close(resolve));
}

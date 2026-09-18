import createModule from '../public/wasm/valhalla-browser.js';
let module;
const call=(name,input)=>JSON.parse(module.ccall(name,'string',['string'],[JSON.stringify(input)]));
self.onmessage=async({data})=>{
  if(data.type==='initialize'){
    module=await createModule({locateFile:file=>new URL(`../public/wasm/${file}`,import.meta.url).href,print:()=>{},printErr:()=>{}});
    const manifest=await(await fetch(data.options.manifestUrl)).json();
    const config=await(await fetch(new URL(manifest.config.url,data.options.manifestUrl))).json();
    for(const tile of Object.values(manifest.tiles)){
      const bytes=new Uint8Array(await(await fetch(new URL(`tiles/${tile.path}`,data.options.manifestUrl))).arrayBuffer());
      const path=`/tiles/${tile.path}`;module.FS.mkdirTree(path.slice(0,path.lastIndexOf('/')));module.FS.writeFile(path,bytes);
    }
    config.mjolnir.tile_url='';config.mjolnir.tile_dir='/tiles';
    const result=call('vb_init',config);
    if(result.runtimeError)throw new Error(JSON.stringify(result));
    postMessage({type:'result',id:data.id,result});
  }else if(data.type==='route'){
    postMessage({type:'progress',id:data.id,detail:{phase:'routing-cpu'}});
    // Repeated real actor operations make CPU cancellation reproducible on this tiny graph.
    for(let i=0;i<100000;i++){
      const result=call('vb_route',data.request);
      if(!result.trip)throw new Error(JSON.stringify(result));
    }
    postMessage({type:'result',id:data.id,result:{unexpectedCompletion:true}});
  }
};

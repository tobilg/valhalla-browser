import createModule from '../public/wasm/valhalla-browser.js';

self.onmessage = async ({data}) => {
  try {
    const module = await createModule({locateFile:file=>new URL(`../public/wasm/${file}`,import.meta.url).href,print:()=>{},printErr:console.error});
    const manifest=await(await fetch(data.manifestUrl)).json();
    const config=await(await fetch(new URL(manifest.config.url,data.manifestUrl))).json();
    for(const tile of Object.values(manifest.tiles)){
      const bytes=new Uint8Array(await(await fetch(new URL(`tiles/${tile.path}`,data.manifestUrl))).arrayBuffer());
      const path=`/tiles/${tile.path}`;
      module.FS.mkdirTree(path.slice(0,path.lastIndexOf('/')));
      module.FS.writeFile(path,bytes);
    }
    config.mjolnir.tile_url='';config.mjolnir.tile_dir='/tiles';
    const invoke=(name,input)=>JSON.parse(module.ccall(name,'string',['string'],[JSON.stringify(input)]));
    const init=invoke('vb_init',config);
    if(init.runtimeError)throw new Error(JSON.stringify(init));
    const results=data.requests.map(request=>invoke('vb_route',request));
    postMessage({results});
    invoke('vb_dispose',{});
  }catch(error){postMessage({error:String(error)});}
};

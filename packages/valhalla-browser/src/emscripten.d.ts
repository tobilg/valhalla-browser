declare module '*valhalla-browser.js' {
  interface RuntimeModule {
    bridgeError?: unknown;
    tileLoader?: import('./loader.js').TileLoader;
    ccall(name: string, result: 'string', types: string[], values: string[], options: { async: true }): Promise<string>;
  }
  export default function createModule(options: {
    locateFile: (file: string) => string;
    print: (text: string) => void;
    printErr: (text: string) => void;
  }): Promise<RuntimeModule>;
}

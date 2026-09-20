declare module '*valhalla.js' {
  export default function createModule(options: import('@tobilg/valhalla-core/runtime').RuntimeOptions): Promise<import('@tobilg/valhalla-core/engine').RuntimeModule>;
}

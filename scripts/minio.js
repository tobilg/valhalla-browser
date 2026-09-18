import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = path.join(root, 'build/minio');
const pins = JSON.parse(readFileSync(path.join(root, 'versions.json')));
const name = 'valhalla-browser-minio';
const bucket = 'valhalla';
export const endpoint = 'http://127.0.0.1:19000';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', cwd: root });
export function mcArgs(args) {
  return ['run', '--rm', '--network', `container:${name}`, '--env-file', `${work}/client.env`,
    '-v', `${root}:/work:ro`, pins.minioClientImage, ...args];
}
export function mc(...args) { return docker(mcArgs(args)); }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function start() {
  mkdirSync(work, { recursive: true });
  if (!existsSync(`${work}/server.env`)) {
    const password = randomBytes(32).toString('hex');
    writeFileSync(`${work}/server.env`, `MINIO_ROOT_USER=valhalla-local\nMINIO_ROOT_PASSWORD=${password}\nMINIO_API_CORS_ALLOW_ORIGIN=*\n`, { mode: 0o600 });
    writeFileSync(`${work}/client.env`, `MC_HOST_lab=http://valhalla-local:${password}@127.0.0.1:9000\n`, { mode: 0o600 });
  }
  const names = docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']).trim();
  if (names) {
    const label = docker(['inspect', name, '--format', '{{index .Config.Labels "dev.valhalla-browser"}}']).trim();
    if (label !== 'minio') throw new Error('Container name belongs to another project.');
    let expectedImage;
    try { expectedImage = docker(['image', 'inspect', pins.minioImage, '--format', '{{.Id}}']).trim(); }
    catch { docker(['pull', pins.minioImage]); expectedImage = docker(['image', 'inspect', pins.minioImage, '--format', '{{.Id}}']).trim(); }
    if (docker(['inspect', name, '--format', '{{.Image}}']).trim() !== expectedImage)
      throw new Error('Existing MinIO container uses a different image. Stop and recreate this project container before upgrading.');
    docker(['start', name]);
  } else {
    docker(['run', '-d', '--name', name, '--label', 'dev.valhalla-browser=minio',
      '-p', '127.0.0.1:19000:9000', '--env-file', `${work}/server.env`,
      '-v', 'valhalla-browser-minio-data:/data', pins.minioImage, 'server', '/data']);
  }
  for (let n = 0; n < 60; n++) {
    if (await fetch(`${endpoint}/minio/health/ready`).then(r => r.ok).catch(() => false)) break;
    if (n === 59) throw new Error('MinIO failed readiness. Inspect docker logs valhalla-browser-minio.');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  mc('mb', '--ignore-existing', `lab/${bucket}`);
  // Public read-only graph data; administrative credentials never reach public/.
  mc('anonymous', 'set', 'download', `lab/${bucket}`);
  console.log(`MinIO ready at ${endpoint}/${bucket}; loopback only.`);
}

async function upload(local, key, immutable = true) {
  const bytes = readFileSync(local);
  const sha = hash(bytes);
  const url = `${endpoint}/${bucket}/${key}`;
  const previous = await fetch(url, { method: 'HEAD' });
  if (previous.ok && immutable) {
    if (previous.headers.get('x-amz-meta-sha256') !== sha || previous.headers.get('content-length') !== String(bytes.length))
      throw new Error(`Refusing to overwrite immutable object ${key}`);
  } else {
    if (![200, 404].includes(previous.status)) throw new Error(`HEAD ${key}: ${previous.status}`);
    const attr = `Cache-Control=${immutable ? 'public, max-age=31536000, immutable' : 'no-cache'};sha256=${sha}`;
    mc('cp', '--quiet', '--attr', attr, `/work/${path.relative(root, local)}`, `lab/${bucket}/${key}`);
  }
  const response = await fetch(url, { method: 'HEAD' });
  if (!response.ok || response.headers.get('x-amz-meta-sha256') !== sha) throw new Error(`Upload verification failed: ${key}`);
  return response.headers.get('etag');
}

async function publish() {
  const fixtures = ['fixtures', ...(existsSync(`${root}/fixtures/region/manifest.json`) ? ['fixtures/region'] : [])];
  const datasets = [];
  for (const fixture of fixtures) {
    const manifest = JSON.parse(readFileSync(`${root}/${fixture}/manifest.json`));
    const prefix = `datasets/${manifest.release}`;
    const local = `${root}/public/${prefix}`;
    manifest.archive.etag = await upload(`${local}/graph.tar`, `${prefix}/graph.tar`);
    await upload(`${local}/config.json`, `${prefix}/config.json`);
    for (const tile of Object.values(manifest.tiles))
      tile.etag = await upload(`${local}/tiles/${tile.path}`, `${prefix}/tiles/${tile.path}`);
    manifest.delivery = { kind: 's3', origin: 'MinIO', validator: 'opaque ETag; independent SHA-256 integrity' };
    const manifestFile = `${work}/${manifest.release}.json`;
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    await upload(manifestFile, `${prefix}/manifest.json`);
    datasets.push({ name: fixture === 'fixtures' ? 'Synthetic fixture · MinIO' : 'Liechtenstein 2015 · MinIO',
      manifestUrl: `${endpoint}/${bucket}/${prefix}/manifest.json`, requestsUrl: `/${fixture}/requests.json` });
  }
  const discoveryFile = `${work}/discovery.json`;
  writeFileSync(discoveryFile, JSON.stringify({ datasets }, null, 2) + '\n');
  await upload(discoveryFile, 'manifest.json', false);
  writeFileSync(`${root}/public/minio.json`, JSON.stringify({ datasets }, null, 2) + '\n');
  console.log(JSON.stringify({ discovery: `${endpoint}/${bucket}/manifest.json`, datasets }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'start';
  if (command === 'start') await start();
  else if (command === 'publish') await publish();
  else if (command === 'stop') {
    const label = docker(['inspect', name, '--format', '{{index .Config.Labels "dev.valhalla-browser"}}']).trim();
    if (label !== 'minio') throw new Error('Refusing to stop unrelated container.');
    docker(['stop', name]);
  } else throw new Error('Usage: node scripts/minio.js start|publish|stop');
}

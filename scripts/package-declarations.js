import { cp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Emit the private workspace package explicitly: TypeScript does not emit
// declarations for dependencies resolved through node_modules. Ship its types
// alongside each SDK so consumers never need to install the private package.
export async function packageDeclarations(packageRoot, name) {
  const output = path.join(packageRoot, 'dist');
  await mkdir(output, { recursive: true });
  const declarations = path.join(packageRoot, 'build/declarations');
  await cp(path.join(declarations, name, 'src'), output, { recursive: true });
  const core = path.resolve(packageRoot, '../valhalla-core');
  execFileSync('pnpm', ['exec', 'tsc', '-p', path.join(core, 'tsconfig.json'),
    '--declaration', '--emitDeclarationOnly', '--rootDir', path.join(core, 'src'),
    '--outDir', path.join(output, 'core')], { cwd: packageRoot, stdio: 'inherit' });
  async function rewrite(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await rewrite(file);
      else if (entry.name.endsWith('.d.ts')) {
        const relative = path.relative(directory, path.join(output, 'core')).split(path.sep).join('/');
        const prefix = relative.startsWith('.') ? relative : `./${relative}`;
        const text = await readFile(file, 'utf8');
        await writeFile(file, text.replace(/(['"])@tobilg\/valhalla-core\/([^'"]+)\1/g,
          (_, quote, module) => `${quote}${prefix}/${module}.js${quote}`));
      }
    }
  }
  await rewrite(output);
}

// Bundle the CLI (+ server, core, schema from workspace source) into dist/, and copy the built web UI.
import { build } from 'esbuild';
import { cpSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})];
rmSync('dist', { recursive: true, force: true });
const coreDir = path.dirname(require.resolve('@grim-repo/core/package.json'));
await build({
  entryPoints: { index: 'src/index.ts', 'parse-worker': path.join(coreDir, 'src/parse-worker.ts') },
  outdir: 'dist', bundle: true, platform: 'node', format: 'esm', target: 'node20', sourcemap: true, splitting: true, chunkNames: 'chunks/[name]-[hash]',
  conditions: ['source'], external, logLevel: 'warning',
});
const webDist = path.join(path.dirname(require.resolve('@grim-repo/web/package.json')), 'dist');
if (!existsSync(webDist)) throw new Error('build @grim-repo/web first');
cpSync(webDist, 'dist/web', { recursive: true });
console.log('cli bundled → dist/ (+ web assets)');

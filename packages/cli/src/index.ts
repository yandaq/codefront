#!/usr/bin/env node
import path from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scanTarget, isGitUrl } from '@grim-repo/core';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return args[i]!.includes('=') ? args[i]!.split('=').slice(1).join('=') : args[i + 1];
};
const VALUE_OPTS = new Set(['--out', '--ref', '--port']);
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.has(args[i - 1] ?? ''));
const asTarget = (t: string | undefined) => (t ? (isGitUrl(t) ? t : path.resolve(t)) : process.cwd());

if (flag('help') || flag('h')) {
  console.log(`Usage:
  grim-repo [path|git-url] [--no-open] [--port N]     start the local UI
  grim-repo scan <path|git-url> [--out snapshot.json] [--ref branch] [--no-cache]
                                                       headless scan to a portable JSON snapshot`);
  process.exit(0);
}

if (positional[0] === 'scan') {
  const target = asTarget(positional[1]);
  const out = opt('out') ?? 'snapshot.json';
  const t0 = Date.now();
  let last = '';
  const { snapshot } = await scanTarget(target, {
    ref: opt('ref'), useCache: !flag('no-cache'),
    onProgress: (p) => { if (p.stage !== last) { last = p.stage; process.stderr.write(`· ${p.stage}${p.message ? ` ${p.message}` : ''}\n`); } },
  });
  await writeFile(out, JSON.stringify(snapshot));
  console.error(`Wrote ${out}: ${snapshot.stats.files} files, ${snapshot.stats.sloc} SLOC in ${Date.now() - t0}ms (cache ${snapshot.stats.cacheHits ?? 0} hit / ${snapshot.stats.cacheMisses ?? 0} miss)`);
  process.exit(0);
}

const target = asTarget(positional[0]);
const here = path.dirname(fileURLToPath(import.meta.url));
const bundledWeb = path.join(here, 'web'); // present in the published (bundled) package
const port = opt('port');
// server (fastify) is loaded lazily so headless `scan` stays lightweight
const { startServer } = await import('@grim-repo/server');
const { address } = await startServer({ port: port ? Number(port) : 0, defaultPath: target, webRoot: existsSync(bundledWeb) ? bundledWeb : undefined,
  log: flag('verbose') ? (m) => console.log(m) : undefined });
const url = `${address}/?path=${encodeURIComponent(target)}`;
console.log(`grim-repo running at ${url}\nPress Ctrl+C to stop.`);
if (!flag('no-open')) (await import('open')).default(url).catch(() => {});

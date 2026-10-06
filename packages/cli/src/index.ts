#!/usr/bin/env node
import path from 'node:path';
import open from 'open';
import { startServer } from '@grim-repo/server';

const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');
const target = path.resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());
const portArg = args.find((a) => a.startsWith('--port='));

const { address } = await startServer({ port: portArg ? Number(portArg.split('=')[1]) : 0, defaultPath: target });
const url = `${address}/?path=${encodeURIComponent(target)}`;
console.log(`grim-repo running at ${url}\nPress Ctrl+C to stop.`);
if (!noOpen) open(url).catch(() => {});

import { parentPort } from 'node:worker_threads';
import { analyzeFile } from './analyze.js';

parentPort!.on('message', async (m: { id: number; rel: string; text: string }) => {
  try { parentPort!.postMessage({ id: m.id, result: await analyzeFile(m.rel, m.text) }); }
  catch (e) { parentPort!.postMessage({ id: m.id, error: String((e as Error)?.message ?? e) }); }
});

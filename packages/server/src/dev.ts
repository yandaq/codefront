import { startServer } from './index.js';
const { address } = await startServer({ port: Number(process.env.PORT ?? 4317), defaultPath: process.argv[2] ?? process.cwd() });
console.log(`codefront API on ${address}`);

// Copy the root README and LICENSE into the package so they ship to npm.
// Relative image links are rewritten to GitHub so they render on npmjs.com.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const raw = 'https://raw.githubusercontent.com/yandaq/codefront/main/';
const readme = readFileSync('../../README.md', 'utf8').replace(/\]\((?!https?:|#)([^)]+\.(?:png|jpe?g|gif|svg))\)/g, `](${raw}$1)`);
writeFileSync('README.md', readme);
copyFileSync('../../LICENSE', 'LICENSE');

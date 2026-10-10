import { readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const dir = resolve('dist');
let html = await readFile(resolve(dir, 'index.html'), 'utf8');
const assets = await readdir(resolve(dir, 'assets'));
const css = await readFile(resolve(dir, 'assets', assets.find((name) => name.endsWith('.css'))), 'utf8');
const js = await readFile(resolve(dir, 'assets', assets.find((name) => name.endsWith('.js'))), 'utf8');
const hash = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
// No network access at all: trace data cannot leave the page even if something injected markup.
const csp = `default-src 'none'; script-src ${hash(js)}; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`;
// Function replacers: a string replacement would expand `$$`, `$&`, etc. inside the bundle.
html = html
  .replace(/<link rel="stylesheet"[^>]+>/, () => `<style>${css}</style>`)
  .replace(/<script type="module"[^>]+><\/script>/, () => `<script type="module">${js}</script>`)
  .replace('<meta charset="UTF-8" />', () => `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
if (!html.includes(js) || !html.includes(css) || !html.includes(csp)) throw new Error('inlined bundle does not match build output');
await writeFile(resolve(dir, 'index.html'), html);
await rm(resolve(dir, 'assets'), { recursive: true, force: true });
console.log('Inlined dist/index.html');

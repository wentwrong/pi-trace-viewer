import { readdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseTrace } from '../src/parse.mjs';

// Parser: bad lines are skipped and reported, never fatal.
const ok = '{"type":"session","id":"h"}';
assert.deepEqual(parseTrace(`${ok}\n  \n{broken\nnull\n[1]\n{}\n{"type":"message"`), { entries: [{ type: 'session', id: 'h' }, {}], skipped: [3, 4, 5, 7] });
assert.equal(parseTrace(`[${ok},${ok}]`).entries.length, 2);
assert.equal(parseTrace(JSON.stringify({ type: 'session' }, null, 2)).entries.length, 1);
assert.deepEqual(parseTrace(''), { entries: [], skipped: [] });
assert.deepEqual(parseTrace(`\uFEFF${ok}\r\n${ok}\r\n`).skipped, [], 'BOM and CRLF are tolerated');

const files = await readdir('dist');
const html = await readFile('dist/index.html', 'utf8');
assert.deepEqual(files, ['index.html'], 'production output must be one HTML page');
assert.match(html, /<script type="module">/);
assert.match(html, /<style>/);
assert.match(html, /Pi Agent Harness Trace Viewer/);
const script = html.match(/<script type="module">([\s\S]*)<\/script>/)[1];
const sha = createHash('sha256').update(script).digest('base64');
assert.ok(html.includes(`script-src 'sha256-${sha}'`), 'CSP must allow exactly the inlined script');
console.log('dist check passed: one self-contained HTML page');

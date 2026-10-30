/**
 * The PDF reader must never load in the server process.
 *
 * pdf-parse pulls in @napi-rs/canvas, whose prebuilt Skia binary uses CPU
 * instructions some virtual machines do not have. Loading it there raises
 * SIGILL, which kills the process and cannot be caught, so a static import
 * anywhere in the boot graph takes the whole server down at startup
 * (issue #59). PDFs are read in a child process instead.
 *
 * These are text checks plus a real walk of the import graph, so they run
 * without a compiled better-sqlite3 binding. The child-process behaviour
 * itself (a real PDF, a corrupt one, a worker killed by SIGILL, a timeout)
 * was verified by running the extractor directly.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, '../server');
const extractors = readFileSync(resolve(serverDir, 'lib/text-extractors.js'), 'utf8');

test('nothing in the server boot graph statically imports the PDF stack', () => {
  const seen = new Set();
  const offenders = [];
  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      if (spec === 'pdf-parse' || spec.startsWith('pdfjs') || spec.includes('napi-rs')) {
        offenders.push(`${relative(serverDir, file)} imports ${spec}`);
      }
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec));
    }
  };
  walk(resolve(serverDir, 'index.js'));
  assert.ok(seen.size > 20, 'the walk should reach most of the server');
  assert.deepEqual(offenders, [], 'a static import here kills the server at boot on some CPUs');
});

test('PDF text extraction runs in a child process', () => {
  assert.match(extractors, /spawn\(process\.execPath, \[worker\]/);
  assert.match(extractors, /pdf-extract-worker\.js/);
  assert.doesNotMatch(extractors, /from 'pdf-parse'/, 'the parent must never import it');
  assert.ok(existsSync(resolve(serverDir, 'lib/pdf-extract-worker.js')), 'the worker ships');
});

test('a worker killed by a signal becomes a readable error, and a hung one is capped', () => {
  assert.match(extractors, /if \(signal\)/);
  assert.match(extractors, /SIGKILL.*PDF read timed out|PDF read timed out/s);
  assert.match(extractors, /PDF import is not available on this server/);
  assert.match(extractors, /PDF_TIMEOUT_MS/);
  assert.match(extractors, /child\.kill\('SIGKILL'\)/);
});

test('the worker answers with JSON and keeps the old error wording for a bad PDF', () => {
  const worker = readFileSync(resolve(serverDir, 'lib/pdf-extract-worker.js'), 'utf8');
  assert.match(worker, /await import\('pdf-parse'\)/);
  assert.match(worker, /JSON\.stringify\(\{ text/);
  assert.match(worker, /JSON\.stringify\(\{ error/);
  assert.match(extractors, /'PDF read failed: ' \+ parsed\.error/);
});

// A one-page PDF with a line of text, built by hand so no fixture ships.
function tinyPdf(line) {
  const content = `BT /F1 18 Tf 72 720 Td (${line}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('the worker reads text on a CPU where the canvas binary would crash', {
  skip: !existsSync(resolve(serverDir, 'node_modules/pdf-parse')) && 'server deps not installed',
}, () => {
  // Stand in for the bad CPU: loading any canvas binary raises SIGILL.
  const preload = 'const d = process.dlopen; process.dlopen = function (m, f, ...r) {'
    + " if (/canvas|skia/i.test(String(f))) process.kill(process.pid, 'SIGILL');"
    + ' return d.call(this, m, f, ...r); };';
  const dir = mkdtempSync(join(tmpdir(), 'ct-pdf-'));
  const preloadFile = join(dir, 'sigill.cjs');
  writeFileSync(preloadFile, preload);
  const run = (env) => spawnSync(process.execPath,
    ['--require', preloadFile, resolve(serverDir, 'lib/pdf-extract-worker.js')],
    { input: tinyPdf('Pancakes: 2 cups flour'), env: { ...process.env, ...env }, encoding: 'utf8' });

  const ok = run({});
  assert.equal(ok.signal, null, 'the worker must not load canvas');
  assert.match(JSON.parse(ok.stdout).text, /Pancakes: 2 cups flour/);

  // And the stand-in works: with canvas allowed, the worker dies.
  assert.equal(run({ CT_PDF_ALLOW_CANVAS: '1' }).signal, 'SIGILL');
  rmSync(dir, { recursive: true, force: true });
});

/**
 * server/lib/pdf-extract-worker.js
 *
 * Reads a PDF from stdin, writes {text, pages} as JSON to stdout, and is
 * meant to be run as a child process by text-extractors.js.
 *
 * It exists because pdf-parse loads @napi-rs/canvas, whose prebuilt Skia
 * binary uses CPU instructions some virtual machines do not have (QEMU's
 * default model, for one). Loading it there raises SIGILL, which kills
 * the process outright and cannot be caught in JavaScript. In a child,
 * that kills only the child, and the parent turns it into an error the
 * person importing the file can read. Issue #59.
 *
 * Protocol: raw PDF bytes on stdin, one JSON line on stdout, either
 * { text, pages } or { error }. Anything else, including dying on a
 * signal, is the parent's problem to report.
 *
 * Reading text never needs canvas: pdfjs only loads it to draw pages and
 * images. So the worker refuses to load it, and pdfjs, which loads it
 * inside a try/catch, warns and carries on. That makes PDF import work on
 * CPUs where the Skia binary would crash. Set CT_PDF_ALLOW_CANVAS=1 to
 * load it normally.
 */
import Module from 'node:module';

if (process.env.CT_PDF_ALLOW_CANVAS !== '1') {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === '@napi-rs/canvas' || request.startsWith('@napi-rs/canvas-')) {
      throw new Error('@napi-rs/canvas is disabled in the PDF worker');
    }
    return load.call(this, request, ...rest);
  };

  // pdfjs builds one DOMMatrix when it loads, in its drawing code. Canvas
  // normally supplies the class and Node has none, so give it a stand-in
  // that holds the matrix. Text extraction never calls any of its methods;
  // if something ever does, it fails with an error rather than a crash.
  if (!globalThis.DOMMatrix) {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor(init = [1, 0, 0, 1, 0, 0]) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = Array.from(init);
      }
    };
  }

  // The warnings about canvas being missing are expected here.
  const EXPECTED = /^Warning: Cannot (load "@napi-rs\/canvas"|polyfill)/;
  const warn = console.warn;
  console.warn = (...args) => {
    if (typeof args[0] === 'string' && EXPECTED.test(args[0])) return;
    warn(...args);
  };
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: Buffer.concat(chunks) });
    let result;
    try {
      result = await parser.getText();
    } finally {
      if (typeof parser.destroy === 'function') {
        try { await parser.destroy(); } catch { /* nothing useful to do */ }
      }
    }
    const pages = Array.isArray(result?.pages)
      ? result.pages.length
      : (result?.total || result?.numpages || null);
    process.stdout.write(JSON.stringify({ text: String(result?.text || ''), pages }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e?.message || 'unknown error' }));
  }
});

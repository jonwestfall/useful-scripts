// pdf.js, loaded the first time a PDF is shown (Issues #335, #341).
//
// It used to be a classic <script> on every page that might show a PDF -
// controller, display, planner, Quick Look, Guest View - so 86 KB arrived
// with every load whether a PDF was ever shown or not. It is pdf.js 6 now, an
// ES module, and arrives with the first PDF instead. Everything else is
// already loaded this way: Marp, Mermaid, CodeMirror, mammoth.
//
// The vendored copy is the LEGACY build (see vendor-build/build-pdfjs.mjs):
// the modern one calls methods only the newest browsers have, and an iPad a
// few versions behind would show nothing. It runs on Safari 16.4 / iPadOS
// 16.4 and later.

const LIB_URL = new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url).href;
const WORKER_URL = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
// JPEG 2000, JBIG2 and ICC colour decoders (and their non-WebAssembly
// fallbacks), which pdf.js fetches from here when a PDF needs one.
const WASM_URL = new URL('../vendor/pdfjs/wasm/', import.meta.url).href;

let loading = null;

/**
 * The pdf.js library, imported once and shared. A failed import is not
 * remembered: the next PDF tries again, under a fresh address the first
 * time round (a module that failed to load stays failed under its own URL
 * for the life of the page - the same reason importMarp in deck.js does it).
 */
export function loadPdfjs() {
  loading ??= (async () => {
    let lib;
    try {
      lib = await import(LIB_URL);
    } catch {
      lib = await import(`${LIB_URL}?retry=${Date.now()}`);
    }
    lib.GlobalWorkerOptions.workerSrc = WORKER_URL;
    return lib;
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/**
 * What pdf.getDocument is handed, for every PDF Podium opens: the file, and
 * where pdf.js finds its image decoders. (pdf.js 3's eval-based font path,
 * CVE-2024-4367, which #333 switched off here, is gone from pdf.js 6.)
 */
export function pdfSource(src) {
  const base = typeof src === 'string' || src instanceof URL ? { url: String(src) } : (src?.url || src?.data ? src : { data: src });
  return { ...base, wasmUrl: WASM_URL };
}

/** A PDF opened: the loading task pdf.js returns (its .promise is the document). */
export async function openPdf(src) {
  const lib = await loadPdfjs();
  return lib.getDocument(pdfSource(src));
}

// Packaged Electron always loads the application entry point, even when a
// script path is passed on the command line. Route OCR workers explicitly.
if (process.argv.includes('--arc-ocr-worker')) {
  require('./ocr-worker.cjs');
} else {
  require('./index.cjs');
}

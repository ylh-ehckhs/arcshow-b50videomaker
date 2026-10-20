import { build } from 'esbuild';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['vendor/ocr/main/ocr.ts'],outfile:'dist/ocr.cjs',bundle:true,platform:'node',format:'cjs',external:['electron','onnxruntime-node'],alias:{'@shared':resolve('vendor/ocr/shared')},logLevel:'info'});
await build({entryPoints:['main/poster-ocr.ts'],outfile:'dist/poster-ocr.cjs',bundle:true,platform:'node',format:'cjs',external:['electron','onnxruntime-node'],alias:{'@shared':resolve('vendor/ocr/shared')},logLevel:'info'});
await build({entryPoints:['main/player-enhance.ts'],outfile:'dist/player-enhance.cjs',bundle:true,platform:'node',format:'cjs',external:['electron','onnxruntime-node'],alias:{'@shared':resolve('vendor/ocr/shared')},logLevel:'info'});
console.log('离线 OCR 模块已构建。');

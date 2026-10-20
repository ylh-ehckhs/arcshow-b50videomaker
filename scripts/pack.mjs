import fs from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const checked=spawnSync('py',['-3','scripts/prepare-resources.py','--check-only','--emoji'],{stdio:'inherit',windowsHide:true});
if(checked.error)throw checked.error;if(checked.status!==0)process.exit(checked.status??1);
await import('./build.mjs');
const pkgSource=JSON.parse(await fs.readFile('package.json','utf8'));
const root=process.cwd(),out=path.resolve(process.argv[2]||`portable/arcshow-b50videomaker-${pkgSource.version}`),app=path.join(out,'resources/app');
if(out===root||root.startsWith(out+path.sep))throw new Error('Output must not contain the source directory');
if(existsSync(out)&&(await fs.readdir(out)).length)throw new Error('Choose a new empty output directory to avoid including old files');
await fs.mkdir(out,{recursive:true});
// Copy the standalone Electron runtime; no link to the development dependency tree.
const electron=path.dirname((await import('electron')).default);
await fs.cp(electron,out,{recursive:true,force:true});
await fs.copyFile(path.join(electron,'LICENSE'),path.join(out,'LICENSE.electron'));
await fs.rename(path.join(out,'electron.exe'),path.join(out,'arcshow-b50videomaker.exe')).catch(async error=>{if(error.code==='EEXIST'||error.code==='EPERM'){await fs.copyFile(path.join(out,'electron.exe'),path.join(out,'arcshow-b50videomaker.exe'));await fs.unlink(path.join(out,'electron.exe'));}else throw error;});
await fs.mkdir(app,{recursive:true});
for(const folder of ['main','renderer','shared','data','dist','resources'])await fs.cp(path.join(root,folder),path.join(app,folder),{recursive:true,force:true,...folder==='renderer'?{filter:source=>path.relative(path.join(root,'renderer'),source).split(path.sep)[0]!=='assets'}:{}});
const pkg=JSON.parse(await fs.readFile('package.json','utf8'));delete pkg.devDependencies;delete pkg.scripts;
await fs.writeFile(path.join(app,'package.json'),JSON.stringify(pkg,null,2));
for(const name of ['onnxruntime-node','onnxruntime-common']){
  const source=path.join(root,'node_modules',name),dest=path.join(app,'node_modules',name);await fs.mkdir(dest,{recursive:true});
  for(const f of ['package.json','README.md','dist'])await fs.cp(path.join(source,f),path.join(dest,f),{recursive:true,force:true});
}
await fs.cp(path.join(root,'node_modules/onnxruntime-node/bin/napi-v3/win32/x64'),path.join(app,'node_modules/onnxruntime-node/bin/napi-v3/win32/x64'),{recursive:true,force:true});
for(const f of ['README.md','THIRD_PARTY_NOTICES.md','LICENSE'])if(existsSync(f))await fs.copyFile(f,path.join(out,f));
// Only the current, media-free tutorial is eligible for packaging.
for(const folder of ['docs','licenses'])await fs.cp(folder,path.join(out,folder),{recursive:true});
await fs.cp('examples/full-b50-tutorial',path.join(out,'examples/full-b50-tutorial'),{recursive:true,filter:source=>path.relative(path.resolve('examples/full-b50-tutorial'),path.resolve(source)).split(path.sep)[0]!=='assets'});
await fs.writeFile(path.join(out,'启动arcshow-b50videomaker.cmd'),'@echo off\r\nset ELECTRON_RUN_AS_NODE=\r\nstart "" "%~dp0arcshow-b50videomaker.exe"\r\n','utf8');
let bytes=0;async function count(folder){for(const e of await fs.readdir(folder,{withFileTypes:true})){const f=path.join(folder,e.name);if(e.isDirectory())await count(f);else bytes+=(await fs.stat(f)).size;}}await count(out);
console.log(`离线便携版：${out}\n${(bytes/1024/1024).toFixed(1)} MiB · 内置 Electron / OCR / FFmpeg`);

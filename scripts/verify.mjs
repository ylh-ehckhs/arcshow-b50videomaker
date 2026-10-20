import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
const run=(command,args)=>{
  const result=spawnSync(command,args,{stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
};
run(process.platform==='win32'?'py':'python3',[...(process.platform==='win32'?['-3']:[]),'scripts/prepare-resources.py','--check-only','--emoji']);
run(process.execPath,['--test',...readdirSync('tests').filter(f=>f.endsWith('.test.mjs')).map(f=>'tests/'+f)]);
await import('./build.mjs');

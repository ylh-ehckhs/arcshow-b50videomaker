import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

// Exercise the actual parser without Electron or an OCR model fixture.
const bundle=await build({entryPoints:['vendor/ocr/shared/ocr.ts'],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {parseCardItems}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const parse=(bands,items=[])=>parseCardItems(items,'arcaea',undefined,3,undefined,bands);

test('isolated Potential band supplies its own explicit clear status',()=>{
  assert.equal(parse(['0.5>12.3813NC']).grade,'NC');
  assert.equal(parse(['.1>12.1585HC']).grade,'HC');
  assert.equal(parse(['12.3813NC','12.3813NC']).grade,'NC');
  assert.equal(parse(['12.3813HC'],[{text:'12.3813NC',x:0,y:0,w:100,h:15}]).grade,'HC');
});

test('conflicting or unreadable band values cannot silently supply a status',()=>{
  assert.equal(parse(['12.3813NC','12.3813HC']).grade,null);
  assert.equal(parse(['12.3813NC','12.3013HC']).grade,null);
  assert.equal(parse(['123813HC']).grade,null);
  assert.equal(parse(['99.3813HC']).grade,null);
});

test('a two-character CJK title from its isolated band remains a candidate',()=>{
  const result=parseCardItems([],'arcaea',text=>text==='魔王'?1:0,3,['魔王']);
  assert.equal(result.title,'魔王');
});

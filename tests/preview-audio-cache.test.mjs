import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import preview from '../main/preview-audio-cache.cjs';

const ffmpeg=path.resolve('resources/bin',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
function wav(seconds=.3){
  const frames=Math.round(seconds*48000),data=Buffer.alloc(44+frames*4);
  data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);
  data.writeUInt16LE(1,20);data.writeUInt16LE(2,22);data.writeUInt32LE(48000,24);data.writeUInt32LE(192000,28);data.writeUInt16LE(4,32);data.writeUInt16LE(16,34);
  data.write('data',36);data.writeUInt32LE(frames*4,40);
  for(let frame=0;frame<frames;frame++){const sample=Math.round(12000*Math.sin(2*Math.PI*440*frame/48000));data.writeInt16LE(sample,44+frame*4);data.writeInt16LE(-sample,46+frame*4);}
  return data;
}
function pcm(buffer){
  for(let at=12;at+8<=buffer.length;){const name=buffer.toString('ascii',at,at+4),length=buffer.readUInt32LE(at+4);if(name==='data')return buffer.subarray(at+8,at+8+length);at+=8+length+(length%2);}
  assert.fail('WAV data chunk missing');
}
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');

test('preview PCM cache preserves exact selected samples, shares concurrent work, invalidates source changes and cleans cancellation',{skip:!existsSync(ffmpeg),timeout:30000},async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'arcshow-preview-pcm-test-')),cache=path.join(folder,'cache'),file=path.join(folder,'source.wav');
  t.after(async()=>{preview.configureCache('');await fs.rm(folder,{recursive:true,force:true});});
  const source=wav();await fs.writeFile(file,source);preview.configureCache(cache);
  const track={id:'song-a',file,start:.05,duration:.1};
  const batches=await Promise.all([preview.prepareTracks([track,{...track,id:'song-b'}]),preview.prepareTracks([{...track,id:'other-request'}])]);
  assert.equal(batches[0][0].file,batches[0][1].file);assert.equal(batches[0][0].file,batches[1][0].file);
  const prepared=batches[0][0],output=await fs.readFile(prepared.file);
  assert.deepEqual({...prepared,file:'cache.wav'},{id:'song-a',file:'cache.wav',start:0,duration:.1,sourceStart:.05});
  assert.equal(path.dirname(prepared.file),cache);assert.equal(pcm(output).length,19200);
  assert.deepEqual(pcm(output),source.subarray(44+Math.round(.05*192000),44+Math.round(.15*192000)));
  assert.equal(digest(await fs.readFile(file)),digest(source));assert.equal((await fs.readdir(cache)).filter(name=>name.endsWith('.wav')).length,1);

  const before=await fs.stat(prepared.file);await preview.prepareTracks([track]);assert.equal((await fs.stat(prepared.file)).birthtimeMs,before.birthtimeMs);
  await fs.writeFile(prepared.file,'broken');const repaired=(await preview.prepareTracks([track]))[0];assert.equal(repaired.file,prepared.file);assert.equal(pcm(await fs.readFile(repaired.file)).length,19200);
  await fs.utimes(file,new Date(),new Date(Date.now()+1500));
  const updated=(await preview.prepareTracks([track]))[0];assert.notEqual(updated.file,prepared.file);

  const looped=(await preview.prepareTracks([{id:'loop',file,start:0,duration:.6,loop:true}]))[0];
  assert.equal(looped.loop,false);assert.equal(looped.sourceStart,0);assert.equal(pcm(await fs.readFile(looped.file)).length,115200);
  const aac=path.join(folder,'44100.m4a'),encoded=spawnSync(ffmpeg,['-y','-v','error','-i',file,'-ar','44100','-c:a','aac',aac],{windowsHide:true});
  assert.equal(encoded.status,0,encoded.stderr?.toString());
  const compressed=(await preview.prepareTracks([{id:'aac',file:aac,start:0,duration:.175}]))[0];
  assert.equal(pcm(await fs.readFile(compressed.file)).length,Math.round(.175*48000)*4);
  await assert.rejects(preview.prepareTracks([{...track,start:.25,duration:.2}]),/范围超过音频长度/);
  await assert.rejects(preview.prepareTracks([{...track,file:path.join(folder,'missing.wav')}]),{code:'ENOENT'});
  const invalid=path.join(folder,'invalid.wav');await fs.writeFile(invalid,'not audio');await assert.rejects(preview.prepareTracks([{...track,file:invalid}]),/无法准备预览音轨/);
  await assert.rejects(preview.prepareTracks([{...track,duration:-1}]),/正时长/);
  const canceled=new AbortController();canceled.abort();await assert.rejects(preview.prepareTracks([track],{signal:canceled.signal}),{name:'AbortError'});

  const running=new AbortController(),pending=preview.prepareTracks([{...track,start:0,duration:20,loop:true}],{signal:running.signal});
  setTimeout(()=>running.abort(),10);await assert.rejects(pending,{name:'AbortError'});
  assert.equal((await fs.readdir(cache)).filter(name=>name.endsWith('.tmp')).length,0);

  // Canceling one consumer must not cancel another consumer of the same range.
  const one=new AbortController(),unique={...track,start:0,duration:1.5,loop:true};
  const a=preview.prepareTracks([unique],{signal:one.signal}),b=preview.prepareTracks([{...unique,id:'survivor'}]);
  setTimeout(()=>one.abort(),5);const results=await Promise.allSettled([a,b]);
  assert.equal(results[0].status,'rejected');assert.equal(results[0].reason.name,'AbortError');assert.equal(results[1].status,'fulfilled');
  assert.equal(pcm(await fs.readFile(results[1].value[0].file)).length,288000);

  // A sparse old file exercises disk eviction without doing heavy decoding.
  const old=path.join(cache,'0'.repeat(64)+'.wav'),handle=await fs.open(old,'w');await handle.truncate(1024*1024*1024);await handle.close();
  await fs.utimes(old,new Date(0),new Date(0));await preview.prepareTracks([track]);
  assert.equal(existsSync(old),false);assert.equal(existsSync((await preview.prepareTracks([track]))[0].file),true);
  assert.equal(digest(await fs.readFile(file)),digest(source));
});

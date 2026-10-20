import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {alignSamples}=require('../main/alignment-worker.cjs');
const {waveform,align,clearCache}=require('../main/audio-tools.cjs');
const rate=4000;
function song(seconds,seed=17){
  const data=new Float32Array(Math.round(seconds*rate));let state=seed;
  const rand=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const notes=Array.from({length:Math.ceil(seconds*4)+2},()=>[80+rand()*1050,50+rand()*450,rand(),rand()]);
  for(let i=0;i<data.length;i++){const t=i/rate,k=Math.floor(t*4),n=notes[k],local=t-k*.25,env=.3+.7*Math.exp(-local*8);data[i]=env*(.18*Math.sin(2*Math.PI*n[0]*t)+.1*Math.sin(2*Math.PI*n[1]*t)+.08*Math.sin(2*Math.PI*(n[0]*1.5+local*240)*t))*(.7+.3*Math.cos(t*7+n[2]));}
  return data;
}
function recording(master,{start=8,length=30,padding=1.725,noise=0,stretch=1}={}){
  const data=new Float32Array(Math.round((padding+length)*rate));let state=42;
  for(let i=Math.round(padding*rate);i<data.length;i++){const j=start*rate+(i-padding*rate)*stretch,a=Math.floor(j),fraction=j-a;state=(Math.imul(state,1664525)+1013904223)>>>0;data[i]=((master[a]||0)*(1-fraction)+(master[a+1]||0)*fraction)*.76+noise*(state/4294967296-.5);}
  return data;
}
function wav(samples){const b=Buffer.alloc(44+samples.length*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples.length*2,40);for(let i=0;i<samples.length;i++)b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),44+i*2);return b;}
test('multiple windows recover a recording offset despite padding, gain and noise',()=>{
  const master=song(48),video=recording(master,{start:8,length:32,padding:1.725,noise:.1}),result=alignSamples(master,video,rate);
  assert.equal(result.status,'matched',JSON.stringify(result));assert.ok(Math.abs(result.offset-(1.725-8))<.003,JSON.stringify(result));assert.ok(result.candidates[0].matchedWindows>=5);assert.ok(result.candidates[0].matchedAt.length>=5);
});
test('a whole repeated musical section produces alternatives instead of false certainty',()=>{
  const block=song(20),master=new Float32Array(block.length*3);for(let n=0;n<3;n++)master.set(block,n*block.length);
  const video=block.slice(2*rate,18*rate),result=alignSamples(master,video,rate);
  assert.equal(result.status,'ambiguous',JSON.stringify(result));assert.equal(result.offset,null);assert.ok(result.candidates.length>=2);
});
test('positive offsets keep the target-minus-source convention',()=>{
  const master=song(30),video=recording(master,{start:0,length:28,padding:3.125,noise:.02}),result=alignSamples(master,video,rate);
  assert.equal(result.status,'matched',JSON.stringify(result));assert.ok(Math.abs(result.offset-3.125)<.003,JSON.stringify(result));
});
test('silence and unrelated music cannot be accepted',()=>{
  assert.equal(alignSamples(new Float32Array(30*rate),new Float32Array(20*rate),rate).status,'unmatched');
  assert.equal(alignSamples(song(42,17),song(30,83),rate).status,'unmatched');
});
test('time drift is rejected rather than treated as a single reliable offset',()=>{
  const master=song(52),video=recording(master,{start:8,length:36,padding:1,stretch:1.006}),result=alignSamples(master,video,rate);
  assert.equal(result.status,'unmatched',JSON.stringify(result));assert.equal(result.offset,null);
});
test('bundled FFmpeg decodes real WAV files, worker returns waveforms and an explicit offset',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arcshow-audio-test-'));try{
    const master=song(36),video=recording(master,{start:7,length:24,padding:1.25,noise:.03}),source=path.join(dir,'master.wav'),target=path.join(dir,'video.wav');
    await fs.writeFile(source,wav(master));await fs.writeFile(target,wav(video));
    const wave=await waveform(target,{points:100,start:1,end:10});assert.equal(wave.peaks.length,100);assert.equal(wave.ranges.length,100);assert.ok(wave.peaks.some(x=>x>.1));assert.equal(wave.start,1);
    const result=await align({source,target});assert.equal(result.status,'matched',JSON.stringify(result));assert.ok(Math.abs(result.offset+5.75)<.003);assert.equal(result.offsetConvention,'targetTime - sourceTime');
    assert.deepEqual(await align({source,target}),result,'cached results preserve the same evidence');
    const abort=new AbortController();abort.abort();await assert.rejects(waveform(source,{signal:abort.signal}),{name:'AbortError'});
    const cancel=new AbortController();clearCache();await assert.rejects(align({source,target},{signal:cancel.signal,onProgress:p=>{if(p.stage==='提取共同音源特征')cancel.abort();}}),{name:'AbortError'});
    clearCache();
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

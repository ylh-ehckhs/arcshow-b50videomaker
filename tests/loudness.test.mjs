import {existsSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import loudness from '../main/loudness.cjs';
import exporter from '../main/exporter.cjs';
import {newProject,newEntry,buildTimeline,validateProject} from '../shared/core.mjs';

test('loudness gain is static, peak-capped and safe for silence',()=>{
  const quiet=loudness.gainFor({input_i:'-36',input_tp:'-20'}),loud=loudness.gainFor({input_i:'-6',input_tp:'0'});
  assert.equal(quiet.gainDb,18.5);assert.equal(quiet.peakLimited,true);assert.equal(loud.gainDb,-10);
  for(const input of [{input_i:'-inf',input_tp:'-inf'},{input_i:'-65',input_tp:'-60'}])assert.equal(loudness.gainFor(input).gain,1);
});

test('old projects opt into loudness/blur and explicit preferences survive roundtrip',()=>{
  const p=newProject();delete p.settings.normalizeAudio;delete p.settings.cutBlur;
  assert.equal(validateProject(p).settings.normalizeAudio,true);assert.equal(validateProject(p).settings.cutBlur,.3);
  p.settings.normalizeAudio=false;p.settings.cutBlur=0;assert.equal(validateProject(p).settings.normalizeAudio,false);assert.equal(validateProject(p).settings.cutBlur,0);
  for(const value of [null,-1,2,'',true]){p.settings.cutBlur=value;assert.throws(()=>validateProject(p),/cutBlur/);}
});

test('one shared loudness range survives per-card export and leaves overlays unnormalized',()=>{
  const p=newProject();Object.assign(p.settings,{overview:0,segmentGap:0});
  p.entries=[newEntry({id:'a',title:'A',constant:10,score:9900000,audio:'same.wav',audioStart:20,duration:5}),newEntry({id:'b',title:'A',difficulty:'BYD',constant:11,score:9900000,audio:'same.wav',audioStart:25,duration:5})];
  p.sequence=p.entries.map(e=>({id:'song:'+e.id,type:'song',entryId:e.id}));
  const full=buildTimeline(p),single=buildTimeline(p,{singleId:'b'});
  assert.equal(full.audio.length,1);assert.deepEqual(full.audio[0].loudnessRange,{start:20,duration:10});
  assert.deepEqual(single.audio[0].loudnessRange,full.audio[0].loudnessRange);assert.equal(single.audio[0].start,25);assert.equal(single.audio[0].duration,5);
  p.settings.normalizeAudio=false;assert.equal(buildTimeline(p).audio[0].normalizeAudio,false);
});

test('offline measurements remove a 20 dB source difference, invalidate modified files and support cancellation',{skip:!existsSync(exporter.binary('ffmpeg')),timeout:30000},async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'arcshow-loudness-test-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const make=(file,amplitude)=>{const result=spawnSync(exporter.binary('ffmpeg'),['-y','-v','error','-f','lavfi','-i',`aevalsrc=${amplitude}*sin(2*PI*440*t)|${amplitude}*sin(2*PI*440*t):s=48000:d=3`,'-c:a','pcm_s16le',file],{windowsHide:true});assert.equal(result.status,0,result.stderr?.toString());};
  const a=path.join(folder,'loud.wav'),b=path.join(folder,'quiet.wav');make(a,.4);make(b,.04);
  loudness.configureCache(path.join(folder,'cache'));
  const tracks=[a,b].map((file,i)=>({id:String(i),file,start:0,duration:3,normalizeAudio:true}));
  const [loud,quiet]=await loudness.normalizeTracks(tracks);
  assert.ok(Math.abs(loud.integrated-quiet.integrated-20)<.1);assert.ok(Math.abs(quiet.gainDb-loud.gainDb-20)<.1);
  for(const value of [loud,quiet])assert.ok(Math.abs(value.integrated+value.gainDb+16)<.1);
  const cached=await loudness.analyze(tracks[1]);assert.equal(cached.gain,quiet.gain);assert.equal((await fs.readdir(path.join(folder,'cache'))).length,2);
  await fs.utimes(b,new Date(),new Date(Date.now()+1000));make(b,.08);
  const modified=await loudness.analyze(tracks[1]);assert.ok(Math.abs(modified.gainDb-quiet.gainDb+6.02)<.1);
  const silent=path.join(folder,'silent.wav');make(silent,0);assert.equal((await loudness.analyze({...tracks[0],file:silent})).gain,1);
  const controller=new AbortController();controller.abort();await assert.rejects(loudness.normalizeTracks(tracks,{signal:controller.signal}),{name:'AbortError'});
  assert.equal((await loudness.analyze({id:'effect',overlay:true,file:'missing.wav',start:0,duration:1})).gain,1);
  const mono=path.join(folder,'mono.wav'),monoArgs=['-y','-v','error','-i',b,'-ac','1','-c:a','pcm_s16le',mono];
  assert.equal(spawnSync(exporter.binary('ffmpeg'),monoArgs,{windowsHide:true}).status,0);
  const monoMeasurement=await loudness.analyze({...tracks[1],file:mono});assert.equal(monoMeasurement.audioChannels,1);assert.ok(Math.abs(monoMeasurement.previewGain/monoMeasurement.gain-Math.SQRT1_2)<1e-10);
  const running=new AbortController(),pending=loudness.analyze({...tracks[0],file:a,duration:1800,loop:true},{signal:running.signal});setTimeout(()=>running.abort(),30);await assert.rejects(pending,{name:'AbortError'});
  loudness.configureCache('');
});

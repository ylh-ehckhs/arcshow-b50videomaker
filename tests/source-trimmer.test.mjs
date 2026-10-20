import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourceTrimmer,trimRange,moveTrimHandle} from '../renderer/source-trimmer.mjs';

const flush=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
class Control extends EventTarget{
  constructor(key){super();this.dataset={wb:key};this.style={};this.attributes={};this.value='0';}
  setAttribute(key,value){this.attributes[key]=value;}
}
class Video extends EventTarget{
  constructor(){super();Object.assign(this,{time:0,duration:NaN,readyState:0,seeking:false,paused:true,ended:false,muted:true,seeks:[],plays:0});}
  get currentTime(){return this.time;}
  set currentTime(value){this.time=value;this.seeks.push(value);this.seeking=true;}
  pause(){if(this.paused)return;this.paused=true;this.dispatchEvent(new Event('pause'));}
  play(){this.plays++;this.paused=false;this.ended=false;this.dispatchEvent(new Event('play'));return Promise.resolve();}
  metadata(duration){this.duration=duration;this.readyState=1;this.dispatchEvent(new Event('loadedmetadata'));}
  ready(){this.seeking=false;this.readyState=4;this.dispatchEvent(new Event('seeked'));}
  tick(time){this.time=time;this.dispatchEvent(new Event('timeupdate'));}
}
function harness(){
  const video=new Video(),first=new Control('trim-in'),last=new Control('trim-out'),region=new Control(),label=new Control(),button=new Control(),frames=new Map(),errors=[];let seq=0,pauses=0;
  const controls={'[data-wb="trim-in"]':first,'[data-wb="trim-out"]':last,'.trim-selection':region,'#source-range-label':label,'[data-action="wb-source-loop"]':button};
  const trimmer=createSourceTrimmer({video,root:{querySelector:selector=>controls[selector]},onPlay:()=>pauses++,onError:error=>errors.push(error),requestFrame:fn=>{frames.set(++seq,fn);return seq;},cancelFrame:id=>frames.delete(id)});
  const frame=()=>{const current=[...frames.values()];frames.clear();for(const fn of current)fn();};
  return {trimmer,video,first,last,region,label,button,errors,frame,pauses:()=>pauses};
}

test('metadata restores both handle values and selection in the actual media domain',()=>{
  const h=harness();h.trimmer.update({start:78.3,end:102.5,duration:103});
  // A stale native slider value must never become the source of truth.
  h.first.value='60';h.last.value='60';h.video.metadata(137.044);h.frame();
  assert.equal(Number(h.first.max),137.044);assert.equal(Number(h.last.max),137.044);
  assert.equal(Number(h.first.value),78.3);assert.equal(Number(h.last.value),102.5);
  assert.equal(parseFloat(h.region.style.left),78.3/137.044*100);
  assert.ok(Math.abs(parseFloat(h.region.style.width)-(102.5-78.3)/137.044*100)<1e-12);
  assert.equal(h.label.textContent,'78.300 → 102.500 / 137.044 秒');assert.deepEqual(h.video.seeks,[78.3]);h.trimmer.dispose();
});

test('editing preserves exact cut times even if metadata reports a shorter recording',()=>{
  const h=harness();h.trimmer.update({start:55.123,end:65.456,duration:80});h.video.metadata(60);h.frame();h.video.ready();
  assert.equal(h.label.textContent,'55.123 → 65.456 / 60.000 秒（超出原片范围）');
  assert.equal(Number(h.last.value),60);h.trimmer.update({start:42.001,end:50.002});
  assert.equal(Number(h.first.value),42.001);assert.equal(Number(h.last.value),50.002);assert.equal(Number(h.last.max),60);h.trimmer.dispose();
});

test('later duration notifications refresh geometry without rewinding a playing source',async()=>{
  const h=harness();h.trimmer.update({start:20,end:30});h.video.metadata(120);h.frame();h.video.ready();await h.video.play();h.video.time=25;
  const count=h.video.seeks.length;h.video.duration=120.04;h.video.dispatchEvent(new Event('durationchange'));h.frame();
  assert.equal(h.video.currentTime,25);assert.equal(h.video.seeks.length,count);assert.equal(Number(h.last.max),120.04);h.trimmer.dispose();
});

test('handle constraints prevent inverted ranges and preserve the half-second minimum',()=>{
  assert.deepEqual(moveTrimHandle(trimRange(10,20,120),'trim-in',30),{start:19.5,end:20});
  assert.deepEqual(moveTrimHandle(trimRange(10,20,120),'trim-out',1),{start:10,end:10.5});
  assert.deepEqual(moveTrimHandle(trimRange(10,20,120),'trim-out',500),{start:10,end:120});
  assert.deepEqual(moveTrimHandle(trimRange(1,3,1000),'trim-out',900),{start:1,end:601});
});

test('fast scrubbing merges seeks and waits for the decoder before the latest request',()=>{
  const h=harness();h.trimmer.update({start:10,end:30});h.video.metadata(120);h.frame();
  for(let n=0;n<40;n++){h.first.value=String(11+n*.1);h.first.dispatchEvent(new Event('input'));h.frame();}
  assert.deepEqual(h.video.seeks,[10]);h.video.ready();h.frame();assert.deepEqual(h.video.seeks,[10,14.9]);h.video.ready();
  assert.equal(Number(h.first.value),14.9);assert.equal(Number(h.last.value),30);assert.equal(h.trimmer.looping,false);h.trimmer.dispose();
});

test('loop rewinds once per boundary, never while paused or awaiting a seek',async()=>{
  const h=harness();h.trimmer.update({start:20.5,end:22.5});h.video.metadata(120);h.frame();h.video.ready();
  h.trimmer.toggleLoop();h.frame();await flush();assert.equal(h.video.paused,false);assert.equal(h.button.textContent,'停止循环');
  h.video.tick(22.5);h.frame();const count=h.video.seeks.length;
  for(let n=0;n<50;n++)h.video.tick(20.499);
  h.frame();assert.equal(h.video.seeks.length,count);h.video.ready();await flush();assert.equal(h.video.currentTime,20.499);
  h.video.tick(22.5);h.frame();assert.equal(h.video.seeks.length,count+1);h.video.ready();
  h.trimmer.toggleLoop();assert.equal(h.video.paused,true);assert.equal(h.button.textContent,'循环选区');
  h.video.tick(24);h.frame();assert.equal(h.video.seeks.length,count+1);h.trimmer.dispose();
});

test('native pause cancels looping, and native play only pauses the main preview',async()=>{
  const h=harness();h.video.metadata(120);h.frame();h.video.ready();h.trimmer.update({start:0,end:5});h.trimmer.toggleLoop();h.frame();await flush();
  h.video.pause();assert.equal(h.trimmer.looping,false);const before=h.pauses();await h.video.play();
  assert.equal(h.pauses(),before+1);assert.equal(h.video.paused,false);assert.equal(h.trimmer.looping,false);h.trimmer.dispose();
});

test('stopping before the scheduled first seek prevents playback from starting late',async()=>{
  const h=harness();h.video.metadata(120);h.frame();h.video.ready();h.trimmer.update({start:20,end:23});
  h.trimmer.toggleLoop();h.trimmer.pause();h.frame();h.video.ready();await flush();
  assert.equal(h.video.plays,0);assert.equal(h.video.paused,true);assert.equal(h.trimmer.looping,false);h.trimmer.dispose();
});

test('disposing during an unresolved play cancels the late playback and old listeners',async()=>{
  const h=harness();h.video.metadata(120);h.frame();h.video.ready();h.trimmer.update({start:0,end:5});let finish;
  h.video.play=()=>new Promise(resolve=>{finish=()=>{h.video.paused=false;resolve();};});
  h.trimmer.toggleLoop();h.frame();h.trimmer.dispose();finish();await flush();
  assert.equal(h.video.paused,true);const count=h.video.seeks.length;h.video.tick(10);h.frame();h.video.ready();assert.equal(h.video.seeks.length,count);assert.deepEqual(h.errors,[]);
});

test('a late play from a previous toggle cannot pause a newly requested loop',async()=>{
  const h=harness();h.video.metadata(120);h.frame();h.video.ready();h.trimmer.update({start:0,end:5});const finishes=[];
  h.video.play=()=>new Promise(resolve=>finishes.push(()=>{h.video.paused=false;resolve();}));
  h.trimmer.toggleLoop();h.frame();h.trimmer.toggleLoop();h.trimmer.toggleLoop();h.frame();
  assert.equal(finishes.length,2);finishes[0]();await flush();finishes[1]();await flush();
  assert.equal(h.video.paused,false);assert.equal(h.trimmer.looping,true);h.trimmer.dispose();
});

test('looping at the physical end of a recording restarts after the ended event',async()=>{
  const h=harness();h.video.metadata(5);h.frame();h.video.ready();h.trimmer.update({start:1,end:5});h.trimmer.toggleLoop();h.frame();h.video.ready();await flush();
  h.video.time=5;h.video.ended=true;h.video.pause();h.video.dispatchEvent(new Event('ended'));h.frame();h.video.ready();await flush();
  assert.equal(h.trimmer.looping,true);assert.equal(h.video.currentTime,1);assert.equal(h.video.paused,false);h.trimmer.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewVideoPool,createVideoSynchronizer} from '../renderer/preview-video.mjs';

const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
class Video extends EventTarget{
  constructor(){super();Object.assign(this,{value:0,duration:200,readyState:0,seeking:false,paused:true,playbackRate:1,seeks:[],plays:0,pauses:0,loads:0,removed:false});}
  get currentTime(){return this.value;}set currentTime(value){this.value=value;this.seeks.push(value);this.seeking=true;}
  pause(){this.paused=true;this.pauses++;}play(){this.plays++;this.paused=false;return Promise.resolve();}
  load(){this.loads++;}removeAttribute(name){if(name==='src')this.src='';}remove(){this.removed=true;}
  metadata(){this.readyState=1;this.dispatchEvent(new Event('loadedmetadata'));}
  ready(){this.seeking=false;this.readyState=4;this.dispatchEvent(new Event('seeked'));this.dispatchEvent(new Event('canplay'));}
}
function poolHarness(maxEntries=3){
  const videos=[],held=[];const pool=createPreviewVideoPool({maxEntries,createVideo:()=>{const video=new Video();videos.push(video);return video;},hold:video=>held.push(video)});
  return {pool,videos,held,async ready(promise,index=videos.length-1){videos[index].metadata();await flush();videos[index].ready();return promise;}};
}

test('pool shares an upcoming 100-second seek and resolves only when its first frame is playable',async()=>{
  const h=poolHarness(),pending=h.pool.prepare({key:'future',src:'local.mp4',time:100});
  assert.equal(h.pool.prepare({key:'future',src:'local.mp4',time:100}),pending);assert.equal(h.videos.length,1);
  const video=h.videos[0];assert.equal(video.muted,true);assert.equal(video.playsInline,true);assert.equal(video.preload,'auto');assert.equal(h.held[0],video);
  video.metadata();await flush();assert.deepEqual(video.seeks,[100]);let resolved=false;pending.then(()=>{resolved=true;});await flush();assert.equal(resolved,false);
  video.ready();const entry=await pending;assert.equal(entry.ready,true);assert.equal(entry.time,100);assert.equal(h.pool.activate('future'),entry);h.pool.clear();
});

test('a small live cut tolerance reuses the preheated decoder while explicit precise seek replaces it',async()=>{
  const h=poolHarness(),pending=h.pool.prepare({key:'a',src:'a.mp4',time:100});
  const tolerant=h.pool.prepare({key:'a',src:'a.mp4',time:100.025,tolerance:.15});assert.equal(tolerant,pending);await h.ready(pending);assert.equal(h.videos.length,1);assert.deepEqual(h.videos[0].seeks,[100]);
  const precise=h.pool.prepare({key:'a',src:'a.mp4',time:100.025});assert.notEqual(precise,pending);assert.equal(h.videos[0].removed,true);await h.ready(precise);assert.equal(h.videos.length,2);assert.deepEqual(h.videos[1].seeks,[100.025]);h.pool.clear();
});

test('replaying a cached video from its old start reuses its decoder but awaits a fresh exact seek',async()=>{
  const h=poolHarness(),first=h.pool.prepare({key:'a',src:'a.mp4',time:100});await h.ready(first);const entry=await first,video=entry.video;h.pool.activate('a');video.value=125;
  const replay=h.pool.prepare({key:'a',src:'a.mp4',time:100});assert.notEqual(replay,first);assert.equal(h.videos.length,1);assert.equal(entry.ready,false);await flush();assert.deepEqual(video.seeks,[100,100]);
  let resolved=false;replay.then(()=>{resolved=true;});await flush();assert.equal(resolved,false);video.ready();assert.equal(await replay,entry);assert.equal(entry.ready,true);assert.equal(video.currentTime,100);h.pool.clear();
});

test('clearing during a cached rewind cancels its new readiness wait and releases the original decoder',async()=>{
  const h=poolHarness(),first=h.pool.prepare({key:'a',src:'a.mp4',time:100});await h.ready(first);h.videos[0].value=150;
  const rewind=h.pool.prepare({key:'a',src:'a.mp4',time:100}),rejected=assert.rejects(rewind,{name:'AbortError'});await flush();h.pool.clear();await rejected;h.videos[0].ready();await flush();assert.equal(h.pool.size,0);assert.equal(h.videos[0].removed,true);
});

test('pool protects the active decoder, evicts least-recently-used preparation, and releases resources',async()=>{
  const h=poolHarness(3),a=h.pool.prepare({key:'a',src:'a.mp4'});await h.ready(a);h.pool.activate('a');
  const b=h.pool.prepare({key:'b',src:'b.mp4'});await h.ready(b);
  const c=h.pool.prepare({key:'c',src:'c.mp4'});await h.ready(c);
  const d=h.pool.prepare({key:'d',src:'d.mp4'});await h.ready(d);
  assert.equal(h.pool.size,3);assert.equal(h.videos[0].removed,false);assert.equal(h.videos[1].removed,true);assert.equal(h.videos[1].src,'');assert.ok(h.videos[1].loads>=2);
  assert.equal(h.pool.activate('b'),null);h.pool.activate('d');assert.equal(h.videos[0].paused,true);assert.equal(h.held.at(-1),h.videos[0]);h.pool.deactivate();assert.equal(h.held.at(-1),h.videos[3]);h.pool.clear();assert.equal(h.pool.size,0);
});

test('evicting or clearing pending preparations rejects them with AbortError and cannot resurrect a decoder',async()=>{
  const h=poolHarness(1),a=h.pool.prepare({key:'a',src:'a.mp4',time:150}),rejected=assert.rejects(a,{name:'AbortError'});
  const b=h.pool.prepare({key:'b',src:'b.mp4',time:100});await rejected;const rejectedB=assert.rejects(b,{name:'AbortError'});h.pool.clear();await rejectedB;
  h.videos[0].metadata();h.videos[1].ready();await flush();assert.equal(h.videos.every(video=>video.removed),true);assert.equal(h.pool.size,0);
});

test('preparation clamps to the final playable frame and replaces a changed source under the same key',async()=>{
  const h=poolHarness(),first=h.pool.prepare({key:'a',src:'a.mp4',time:999});await h.ready(first);assert.equal((await first).time,199.999);
  const replacement=h.pool.prepare({key:'a',src:'b.mp4',time:20});await h.ready(replacement);assert.equal(h.videos[0].removed,true);assert.equal((await replacement).video,h.videos[1]);h.pool.clear();
});

test('small playback drift uses bounded rate correction and never generates a seek storm',async()=>{
  let clock=0;const sync=createVideoSynchronizer({now:()=>clock}),video=new Video();video.ready();
  for(let i=0;i<40;i++){video.value=10+i*.1;sync.sync(video,video.value+.15,{playing:true});clock+=100;}
  assert.equal(video.seeks.length,0);assert.equal(video.plays,1);assert.ok(video.playbackRate>1&&video.playbackRate<=1.03);assert.equal(video.muted,true);await flush();
});

test('large drift must persist before correction and pending seeks are never reissued',async()=>{
  let clock=0;const sync=createVideoSynchronizer({now:()=>clock}),video=new Video();video.ready();video.value=10;
  sync.sync(video,12,{playing:true});clock=249;sync.sync(video,12.2,{playing:true});assert.deepEqual(video.seeks,[]);
  clock=250;sync.sync(video,12.25,{playing:true});assert.deepEqual(video.seeks,[12.25]);
  for(let i=0;i<20;i++){clock+=100;sync.sync(video,15+i,{playing:true});}assert.equal(video.seeks.length,1,'pending decoder seek is left alone');
  video.ready();clock+=1;sync.sync(video,16,{playing:true});clock+=249;sync.sync(video,16,{playing:true});assert.equal(video.seeks.length,1);clock+=1;sync.sync(video,16,{playing:true});assert.equal(video.seeks.length,2);await flush();
});

test('pause cancels a late play promise and stopped previews seek precisely without duplicating pending seeks',async()=>{
  const sync=createVideoSynchronizer(),video=new Video();video.ready();let finish;
  video.play=function(){this.plays++;return new Promise(resolve=>{finish=()=>{this.paused=false;resolve();};});};
  sync.sync(video,0,{playing:true});sync.sync(video,0,{playing:true});assert.equal(video.plays,1);sync.pause(video);finish();await flush();assert.equal(video.paused,true);assert.equal(video.playbackRate,1);
  sync.sync(video,25,{playing:false});assert.deepEqual(video.seeks,[25]);sync.sync(video,26,{playing:false});assert.deepEqual(video.seeks,[25]);video.ready();sync.sync(video,26,{playing:false});assert.deepEqual(video.seeks,[25,26]);sync.reset(video);assert.equal(video.paused,true);
});

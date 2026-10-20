import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry,buildTimeline} from '../shared/core.mjs';
import {createTimelinePlayer} from '../renderer/timeline-player.mjs';

const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
function harness(t,{count=4,deferDecode=false,normalize=false,duration=2}={}){
  const names=['Audio','AudioContext','window','fetch','performance','requestAnimationFrame','cancelAnimationFrame','addEventListener','removeEventListener'];
  const saved=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const audios=[],contexts=[],sources=[],decodes=[],pendingDecodes=[],requests=[],fetches=[],scenes=[],errors=[],callbacks=new Map(),listeners=new Map(),cacheFiles=new Map();let stamp=0,rafId=0,fileId=0;
  class AudioStub extends EventTarget{
    constructor(){super();Object.assign(this,{duration:1000,readyState:4,paused:true,ended:false,seeking:false,value:0,plays:0,pauses:0,seeks:[],released:false});audios.push(this);}
    get currentTime(){return this.value;}set currentTime(value){this.value=value;this.seeks.push(value);}
    pause(){this.paused=true;this.pauses++;}play(){this.paused=false;this.plays++;return Promise.resolve();}
    load(){}removeAttribute(name){if(name==='src'){this.src='';this.released=true;}}
  }
  class Param{
    constructor(context,value=1){this.context=context;this.value=value;this.events=[];}
    setValueAtTime(value,time){this.events.push({type:'set',value,time});if(time<=this.context.currentTime)this.value=value;return this;}
    linearRampToValueAtTime(value,time){this.events.push({type:'ramp',value,time});return this;}
    cancelScheduledValues(time){this.events.push({type:'cancel',time});return this;}
  }
  class Context{
    constructor(){this.currentTime=60;this.destination={};contexts.push(this);}
    resume(){return Promise.resolve();}close(){return Promise.resolve();}
    createGain(){return {gain:new Param(this),connect(target){this.destination=target;},disconnect(){this.disconnected=true;}};}
    createDynamicsCompressor(){return {threshold:new Param(this),knee:new Param(this),ratio:new Param(this),attack:new Param(this),release:new Param(this),connect(){},disconnect(){}};}
    createMediaElementSource(el){return {el,connect(){},disconnect(){}};}
    createBufferSource(){
      const node={buffer:null,starts:[],stops:0,onended:null,connect(target){this.destination=target;},disconnect(){this.disconnected=true;},start(when,offset){this.starts.push({when,offset});},stop(){this.stops++;}};
      sources.push(node);return node;
    }
    decodeAudioData(bytes){
      const track=JSON.parse(new TextDecoder().decode(bytes)),buffer={duration:track.duration,trackId:track.id};decodes.push(track);
      if(deferDecode)return new Promise(resolve=>pendingDecodes.push(()=>resolve(buffer)));
      return Promise.resolve(buffer);
    }
  }
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>stamp}});
  globalThis.Audio=AudioStub;globalThis.AudioContext=Context;
  globalThis.window={arc:{
    async previewAudio(tracks,id){
      requests.push({id,tracks:structuredClone(tracks)});
      return tracks.map(track=>{const file='C:\\preview-cache\\'+(++fileId)+'.wav';cacheFiles.set(file,track);return {id:track.id,file,start:0,duration:track.duration,sourceStart:track.start,loop:false};});
    },
    async cancelPreviewAudio(){},async cancelLoudness(){},
    async loudness(tracks){return tracks.map(track=>({id:track.id,gain:2,previewGain:.5}));}
  }};
  globalThis.fetch=async url=>{
    const file=new URL(url).searchParams.get('path'),track=cacheFiles.get(file);assert.ok(track,'only extracted local preview audio is fetched');fetches.push(file);
    return {ok:true,arrayBuffer:async()=>new TextEncoder().encode(JSON.stringify({id:track.id,duration:track.duration})).buffer};
  };
  globalThis.requestAnimationFrame=fn=>{callbacks.set(++rafId,fn);return rafId;};globalThis.cancelAnimationFrame=id=>callbacks.delete(id);
  globalThis.addEventListener=(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);};
  globalThis.removeEventListener=(name,fn)=>listeners.get(name)?.delete(fn);
  const p=newProject();Object.assign(p.settings,{overview:0,segmentGap:0,transition:0,audioTransition:0,normalizeAudio:normalize,volume:.75});
  p.entries=Array.from({length:count},(_,i)=>newEntry({id:String(i),title:'Independent original '+i,constant:10,score:9900000,duration,video:'video-'+i+'.mp4',start:100+i*10,audioMode:'video'}));
  p.sequence=p.entries.map(entry=>({id:'song:'+entry.id,type:'song',entryId:entry.id}));
  let current=buildTimeline(p).scenes[0];
  const player=createTimelinePlayer({project:()=>p,current:()=>current,frame:()=>null,scene:scene=>{current=scene;scenes.push(scene);},time:()=>{},state:()=>{},error:error=>errors.push(error)});
  t.after(()=>{player.destroy();for(const[key,descriptor]of saved)descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];});
  return {p,player,audios,contexts,sources,decodes,pendingDecodes,requests,fetches,scenes,errors,callbacks,setStamp:value=>{stamp=value;},
    async step(seconds){stamp=seconds*1000;contexts[0].currentTime=60+seconds;const callback=callbacks.entries().next().value;if(callback){callbacks.delete(callback[0]);callback[1]();}await flush();}
  };
}

test('buffer preview waits for initial decoding instead of consuming the selected original-audio range',async t=>{
  const h=harness(t,{deferDecode:true}),pending=h.player.play({all:true});await flush();
  assert.equal(h.pendingDecodes.length,3,'only the current track and two successors decode initially');assert.equal(h.sources.length,0);assert.equal(h.audios.reduce((sum,a)=>sum+a.plays,0),0);
  h.setStamp(9000);assert.equal(h.player.cursor,0,'extraction and decoding must not consume nine seconds of the clip');
  h.pendingDecodes.splice(0).forEach(resolve=>resolve());await pending;await flush();
  assert.equal(h.sources.length,3);assert.deepEqual(h.sources.map(node=>node.starts[0].when),[60,62,64]);assert.deepEqual(h.sources.map(node=>node.starts[0].offset),[0,0,0]);assert.equal(h.player.cursor,0);assert.deepEqual(h.errors,[]);
});

test('user pause during pending decoding discards late results without scheduling any source',async t=>{
  const h=harness(t,{deferDecode:true}),pending=h.player.play({all:true});await flush();
  assert.equal(h.pendingDecodes.length,3);assert.equal(h.sources.length,0);
  h.player.pause();assert.equal(h.player.running,false);assert.equal(h.callbacks.size,0);
  h.pendingDecodes.splice(0).forEach(resolve=>resolve());await pending;await flush();
  assert.equal(h.sources.length,0,'decoding completed after cancellation must never create or schedule a buffer source');
  assert.equal(h.audios.every(audio=>audio.plays===0),true,'cancellation must not fall back to starting the original media');
  assert.equal(h.player.running,false);assert.equal(h.player.cursor,0);assert.equal(h.callbacks.size,0);assert.deepEqual(h.errors,[]);
});

test('independent original tracks cross the picture seam using pre-scheduled buffers without another HTMLAudio play or seek',async t=>{
  const h=harness(t);await h.player.play({all:true});await flush();const incoming=h.sources[1],future=h.sources[2];
  const htmlSeeks=h.audios.reduce((sum,a)=>sum+a.seeks.length,0);assert.equal(incoming.starts.length,1);assert.equal(incoming.starts[0].when,62);
  await h.step(1);assert.equal(incoming.stops,0,'the per-frame inactive-track cleanup must keep a future scheduled source');assert.equal(future.stops,0);
  await h.step(2.025);assert.equal(h.scenes.at(-1).clipId,'song:1');assert.equal(incoming.starts.length,1);assert.equal(incoming.stops,0);
  assert.equal(h.audios.reduce((sum,a)=>sum+a.plays,0),0,'the seam must not fall back to HTML media startup');
  assert.equal(h.audios.slice(0,3).reduce((sum,a)=>sum+a.seeks.length,0),htmlSeeks,'the already decoded independent sources must not be sought at the seam');
  assert.ok(Math.abs(h.player.cursor-2.025)<1e-7);assert.deepEqual(h.errors,[]);
});

test('user pause cancels every future scheduled source and later seek starts a fresh precise schedule',async t=>{
  const h=harness(t);await h.player.play({all:true});await h.step(.4);const old=h.sources.slice();h.player.pause();
  assert.equal(h.player.running,false);assert.ok(old.length>=3);assert.equal(old.every(node=>node.stops===1),true);assert.equal(h.callbacks.size,0);
  h.player.seek(.25);assert.equal(h.player.cursor,.25);assert.equal(h.sources.length,old.length,'seeking while paused does not create live sources');
  await h.player.play({all:true,from:.25});await flush();const restarted=h.sources.slice(old.length);
  assert.equal(restarted[0].starts[0].offset,.25,'the original-source clock is translated once into the decoded short buffer');assert.equal(restarted[0].starts[0].when,60.4);
  assert.ok(Math.abs(restarted[1].starts[0].when-62.15)<1e-7);assert.deepEqual(h.errors,[]);
});

test('the decoded original-source timeline cannot jump backward when stale HTML media clocks change at a cut',async t=>{
  const h=harness(t);await h.player.play({all:true});await h.step(2.1);const before=h.player.cursor;
  for(const audio of h.audios)audio.value=0;await h.step(2.2);assert.ok(h.player.cursor>=before);assert.ok(Math.abs(h.player.cursor-2.2)<1e-7);
  await h.step(2.15);assert.ok(h.player.cursor>=2.2,'committed picture time remains monotonic even if a sampled clock settles briefly backward');
  assert.deepEqual(h.scenes.map(scene=>scene.clipId),['song:0','song:1']);assert.deepEqual(h.errors,[]);
});

test('decoded stereo cache applies loudness gain without the HTML mono preview compensation',async t=>{
  const h=harness(t,{normalize:true});await h.player.play({all:true});await flush();
  assert.ok(h.sources.length>=3);
  for(const source of h.sources.slice(0,3)){
    const when=source.starts[0].when,events=source.destination.gain.events;
    assert.ok(events.some(event=>event.type==='set'&&event.time===when&&Math.abs(event.value-1.5)<1e-7),'volume .75 × offline gain 2 must schedule 1.5');
    assert.equal(events.some(event=>Math.abs((event.value??0)-.375)<1e-7),false,'previewGain .5 is only applicable to HTML mono routing');
  }
  assert.deepEqual(h.errors,[]);
});

test('buffer extraction follows a nearby bounded window instead of predecoding the entire Best50',async t=>{
  const h=harness(t,{count:12});await h.player.play({all:true});await flush();assert.equal(h.fetches.length,3);assert.equal(h.requests[0].tracks.length,3);
  for(let index=1;index<=5;index++){await h.step(index*2+.01);assert.ok(h.fetches.length<=3+index,'only one newly adjacent source needs decoding at each seam');}
  assert.equal(h.requests.every(request=>request.tracks.length<=3),true);assert.ok(h.fetches.length<12);assert.equal(h.audios.reduce((sum,a)=>sum+a.plays,0),0);assert.deepEqual(h.errors,[]);
});

test('a buffering long streaming fallback cancels future buffers before the old audio anchor can play them early',async t=>{
  const h=harness(t,{count:3});h.p.entries[1].duration=181;
  await h.player.play({all:true});await flush();assert.equal(h.sources.length,2,'the long original track keeps streaming while its short neighbors decode');
  const future=h.sources[1],stream=h.audios.find(audio=>audio.src?.includes('video-1.mp4'));
  assert.ok(stream);assert.equal(future.starts[0].when,243,'the third song was initially scheduled after 2 + 181 seconds');
  stream.readyState=0;await h.step(2);assert.equal(h.scenes.at(-1).clipId,'song:1');assert.equal(stream.plays,0);
  assert.equal(future.stops,1,'the long source must cancel the old pre-scheduled successor before waiting for its own data');
  await h.step(190);assert.equal(h.player.cursor,2,'stream buffering freezes the selected song instead of letting the old anchor advance');assert.equal(future.stops,1);
  stream.readyState=4;stream.dispatchEvent(new Event('loadedmetadata'));stream.dispatchEvent(new Event('canplay'));await flush();
  assert.equal(stream.plays,1);assert.equal(h.sources.length,2,'the future buffer must not be rescheduled against the obsolete anchor after the long source resumes');
  assert.equal(h.player.cursor,2);assert.equal(h.requests.every(request=>request.tracks.every(track=>track.duration<=180)),true);assert.deepEqual(h.errors,[]);
});

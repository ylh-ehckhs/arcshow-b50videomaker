import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry,buildTimeline} from '../shared/core.mjs';
import {createTimelinePlayer} from '../renderer/timeline-player.mjs';

const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function harness(t,{count=3,frame=false,coldEffects=false}={}){
  const names=['Audio','performance','requestAnimationFrame','cancelAnimationFrame','addEventListener','removeEventListener'];
  const saved=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const callbacks=new Map(),listeners=new Map(),audios=[],scenes=[],messages=[],errors=[];let stamp=0,id=0;
  class AudioStub extends EventTarget{
    constructor(){super();Object.assign(this,{duration:1000,readyState:4,paused:true,ended:false,seeking:false,plays:0,pauses:0,seeks:[],released:false});this.value=0;audios.push(this);}
    get currentTime(){return this.value;}set currentTime(value){this.value=value;this.seeks.push(value);}
    pause(){this.paused=true;this.pauses++;}play(){this.paused=false;this.plays++;return Promise.resolve();}
    load(){if(coldEffects&&this.src?.includes('fx.wav'))this.readyState=0;}
    removeAttribute(name){if(name==='src'){this.src='';this.released=true;}}
    ready(){this.readyState=4;this.dispatchEvent(new Event('loadedmetadata'));this.dispatchEvent(new Event('canplay'));}
  }
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>stamp}});
  globalThis.Audio=AudioStub;globalThis.requestAnimationFrame=fn=>{callbacks.set(++id,fn);return id;};globalThis.cancelAnimationFrame=key=>callbacks.delete(key);
  globalThis.addEventListener=(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);};
  globalThis.removeEventListener=(name,fn)=>listeners.get(name)?.delete(fn);
  const p=newProject();Object.assign(p.settings,{overview:0,segmentGap:0,transition:0,audioTransition:0,normalizeAudio:false});
  p.entries=Array.from({length:count},(_,i)=>newEntry({id:String(i),title:'Song '+i,constant:10+i/100,score:9900000,duration:2,audio:'track-'+i+'.wav',audioStart:100+i*10}));
  p.sequence=p.entries.map(e=>({id:'song:'+e.id,type:'song',entryId:e.id}));
  const contentWindow={postMessage:data=>messages.push(data)},iframe=frame?{contentWindow}:null;
  let current=buildTimeline(p).scenes[0];
  const player=createTimelinePlayer({project:()=>p,current:()=>current,frame:()=>iframe,waitForSceneReady:frame,scene:s=>{current=s;scenes.push(s);},time:()=>{},state:()=>{},error:error=>errors.push(error)});
  const emit=data=>{for(const fn of [...listeners.get('message')||[]])fn({source:contentWindow,data});};
  t.after(()=>{player.destroy();for(const[key,descriptor]of saved)descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];});
  return {p,player,audios,scenes,messages,errors,emit,setStamp:value=>{stamp=value;},step:async()=>{stamp+=17;const next=callbacks.entries().next().value;if(next){callbacks.delete(next[0]);next[1]();}await flush();}};
}

test('preview pre-seeks upcoming independent tracks and bounds live local media to a nearby window',async t=>{
  const h=harness(t,{count:12});await h.player.play({all:true});await flush();
  assert.equal(h.audios.length,3,'only current and next two tracks load at startup');
  assert.equal(h.audios[1].currentTime,110,'distant next source is sought before the current song finishes');
  assert.equal(h.audios[2].currentTime,120);
  h.audios[0].value=102;await h.step();
  assert.equal(h.scenes.at(-1).clipId,'song:1');assert.equal(h.audios[1].plays,1);
  assert.deepEqual(h.audios[1].seeks,[110],'preheated source is not sought again at the splice');
  h.audios[1].value=112;await h.step();
  assert.equal(h.audios[0].released,true,'older source is removed and its decoder released');
  assert.ok(h.audios.filter(audio=>!audio.released).length<=4);
  assert.deepEqual(h.errors,[]);
});

test('a late animation overlay never pauses, seeks or restarts the still-valid common music',async t=>{
  const h=harness(t,{count:2,coldEffects:true});
  h.p.sequence.splice(1,0,{id:'animation:fx',type:'animation',file:'fx-video.mp4',duration:2,start:0,audioMode:'silent',effectFile:'fx.wav',effectStart:2,effectVolume:1});
  h.p.audioGroups=[{id:'common',clipIds:['song:0','animation:fx','song:1'],source:'common.wav',sourceStart:10,volume:1,offsets:{}}];
  await h.player.play({all:true});const main=h.audios.find(audio=>audio.src.includes('common.wav')),effect=h.audios.find(audio=>audio.src.includes('fx.wav'));
  const pauses=main.pauses,seeks=main.seeks.length;main.value=12.1;await h.step();
  assert.equal(main.pauses,pauses);assert.equal(main.plays,1);assert.equal(main.seeks.length,seeks);
  main.value=12.4;effect.ready();await flush();
  assert.equal(main.pauses,pauses);assert.equal(main.plays,1);assert.equal(main.seeks.length,seeks);
  assert.ok(Math.abs(h.player.cursor-2.4)<1e-7,'overlay readiness does not rewind the ongoing common track');
  assert.equal(effect.plays,1);assert.deepEqual(h.errors,[]);
});

test('real preview waits for its first displayable scene without consuming the selected duration',async t=>{
  const h=harness(t,{frame:true}),pending=h.player.play({all:true});await flush();
  assert.equal(h.audios[0].plays,0);h.setStamp(8000);assert.equal(h.player.cursor,0);
  const prepared=h.messages.filter(message=>message.type==='prepare-scene');assert.deepEqual(prepared.map(message=>message.payload.scene.clipId),['song:1','song:2']);
  h.emit({type:'scene-ready',clipId:'song:0'});await pending;
  assert.equal(h.audios[0].plays,1);assert.equal(h.player.cursor,0);
  assert.equal(h.messages.filter(message=>message.type==='sync').at(-1).playing,true);
  assert.deepEqual(h.errors,[]);
});

test('pausing while the first scene loads cancels visual and audio waits without starting later',async t=>{
  const h=harness(t,{frame:true}),pending=h.player.play({all:true});await flush();h.player.pause();await pending;
  h.emit({type:'scene-ready',clipId:'song:0'});await flush();
  assert.equal(h.player.running,false);assert.equal(h.audios.every(audio=>audio.plays===0),true);assert.deepEqual(h.errors,[]);
});

test('a buffering common track waits for readiness without a seek, restart or recursive retry',async t=>{
  const h=harness(t,{count:1});await h.player.play({all:true});const main=h.audios[0],pauses=main.pauses,seeks=main.seeks.length;
  main.readyState=2;main.value=100.4;await h.step();
  assert.equal(main.plays,1);assert.equal(main.pauses,pauses);assert.equal(main.seeks.length,seeks);
  h.setStamp(10000);assert.ok(Math.abs(h.player.cursor-.4)<1e-7);
  main.ready();await flush();assert.equal(main.plays,1);assert.equal(main.seeks.length,seeks);assert.deepEqual(h.errors,[]);
});

test('a cold independent splice freezes its clock while loading and preserves the full new selection',async t=>{
  const h=harness(t);await h.player.play({all:true});const next=h.audios[1];next.readyState=0;h.audios[0].value=102;await h.step();
  assert.equal(next.plays,0);h.setStamp(60000);assert.equal(h.player.cursor,2,'cold-load waiting cannot skip part of the incoming song');
  next.ready();await flush();assert.equal(next.plays,1);assert.equal(h.player.cursor,2);assert.equal(next.currentTime,110);assert.deepEqual(h.errors,[]);
});

test('visual readiness ignores a future scene error and a recoverable background image error',async t=>{
  const h=harness(t,{frame:true}),pending=h.player.play({all:true});
  h.emit({type:'media-error',clipId:'song:1',kind:'video',message:'future video failed'});
  h.emit({type:'media-error',clipId:'song:0',kind:'background',message:'background failed'});
  await flush();assert.equal(h.audios[0].plays,0);assert.deepEqual(h.errors,[]);
  h.emit({type:'scene-ready',clipId:'song:0'});await pending;assert.equal(h.audios[0].plays,1);assert.deepEqual(h.errors,[]);
});

test('an early current-video failure is retained until the first-frame waiter is installed',async t=>{
  const h=harness(t,{frame:true}),pending=h.player.play({all:true});
  h.emit({type:'media-error',sceneId:'0',kind:'video',message:'current video failed'});await pending;
  assert.equal(h.player.running,false);assert.deepEqual(h.errors,['current video failed']);assert.equal(h.audios[0].plays,0);
});

test('a natural cut arriving 25ms late starts the preheated source without seeking and preserves its beginning',async t=>{
  const h=harness(t);await h.player.play({all:true});const next=h.audios[1];assert.deepEqual(next.seeks,[110]);
  h.audios[0].value=102.025;await h.step();assert.equal(next.plays,1);assert.deepEqual(next.seeks,[110]);assert.equal(h.player.cursor,2,'the short renderer scheduling delay must not eat the new selection');
  assert.equal(h.scenes.at(-1).clipId,'song:1');assert.deepEqual(h.errors,[]);
});

test('an explicit preview start 25ms into a card still seeks to the exact requested source time',async t=>{
  const h=harness(t);await h.player.play({all:true,from:2.025});
  const next=h.audios.find(audio=>audio.src.includes('track-1.wav'));assert.equal(next.currentTime,110.025);assert.ok(Math.abs(h.player.cursor-2.025)<1e-7);assert.deepEqual(h.errors,[]);
});

test('a newly playing independent audio clock settling behind its seek target cannot return to the outgoing card',async t=>{
  const h=harness(t);await h.player.play({all:true});
  h.audios[0].value=102;await h.step();assert.equal(h.scenes.at(-1).clipId,'song:1');
  const incoming=h.audios[1],outgoing=h.audios[0],outgoingPlays=outgoing.plays;
  incoming.value=109.98;await h.step();
  assert.equal(h.scenes.at(-1).clipId,'song:1','a 20 ms media clock correction must not select the old card');
  assert.equal(outgoing.plays,outgoingPlays,'the outgoing original audio must not restart');
  assert.ok(h.player.cursor>=2);
  incoming.value=110.2;await h.step();
  assert.deepEqual(h.scenes.map(scene=>scene.clipId),['song:0','song:1']);
  assert.ok(Math.abs(h.player.cursor-2.2)<1e-7);assert.deepEqual(h.errors,[]);
});

test('scene and audio boundaries use the same tolerance during a direct independent cut',async t=>{
  const h=harness(t);await h.player.play({all:true});
  h.audios[0].value=101.9999995;await h.step();
  assert.equal(h.scenes.at(-1).clipId,'song:0','the picture must not enter the next scene while the outgoing audio still owns the clock');
  h.audios[0].value=102;await h.step();
  assert.equal(h.scenes.at(-1).clipId,'song:1');assert.equal(h.audios[1].plays,1);
  assert.deepEqual(h.errors,[]);
});

test('an intentional seek and explicit preview restart can still move backwards',async t=>{
  const h=harness(t);await h.player.play({all:true});
  h.audios[0].value=101.5;await h.step();assert.equal(h.player.cursor,1.5);
  h.player.seek(.25);assert.equal(h.player.cursor,.25);
  await h.player.play({all:true,from:.125});assert.equal(h.player.cursor,.125);
  assert.equal(h.audios[0].currentTime,100.125);assert.deepEqual(h.errors,[]);
});

test('an independent cut waits for its incoming clock before syncing a predecoded first frame',async t=>{
  const h=harness(t,{frame:true}),pending=h.player.play({all:true});await flush();
  h.emit({type:'scene-ready',clipId:'song:0'});await pending;
  h.audios[0].value=102.025;await h.step();assert.equal(h.scenes.at(-1).clipId,'song:1');
  const marker=h.messages.length;
  h.emit({type:'scene-ready',clipId:'song:1'});await flush();
  const sync=h.messages.slice(marker).filter(message=>message.type==='sync');
  assert.ok(sync.length>0);assert.equal(sync.some(message=>!message.playing),false,'readiness must not issue a paused seek using the unsettled outgoing clock');
  assert.equal(sync[0].seconds,0);assert.equal(h.audios[1].plays,1);assert.deepEqual(h.errors,[]);
});

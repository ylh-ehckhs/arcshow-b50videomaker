import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry,buildTimeline} from '../shared/core.mjs';
import {createTimelinePlayer} from '../renderer/timeline-player.mjs';

function harness(t){
  const names=['Audio','requestAnimationFrame','cancelAnimationFrame','addEventListener','removeEventListener','performance'];
  const saved=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const callbacks=new Map(),listeners=new Map(),messages=[],scenes=[],audios=[],errors=[];let stamp=0,nextId=0;
  class AudioStub extends EventTarget{
    constructor(){super();Object.assign(this,{currentTime:0,duration:100,readyState:4,paused:true,ended:false,seeking:false,plays:0});audios.push(this);}
    pause(){this.paused=true;}play(){this.paused=false;this.plays++;return Promise.resolve();}load(){}removeAttribute(){}
  }
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>stamp}});
  globalThis.Audio=AudioStub;
  globalThis.requestAnimationFrame=fn=>{callbacks.set(++nextId,fn);return nextId;};
  globalThis.cancelAnimationFrame=id=>callbacks.delete(id);
  globalThis.addEventListener=(name,fn)=>listeners.set(name,fn);
  globalThis.removeEventListener=name=>listeners.delete(name);
  const p=newProject();Object.assign(p.settings,{overview:0,transition:.8,audioTransition:0,sceneTransitions:{'song:b':{mode:'black',duration:.8}}});
  p.entries=[newEntry({id:'a',title:'A',constant:10,score:9900000,duration:2,audio:'same.wav',audioStart:10}),newEntry({id:'b',title:'B',constant:11,score:9900000,duration:2,audio:'same.wav',audioStart:12})];
  p.sequence=p.entries.map(e=>({id:'song:'+e.id,type:'song',entryId:e.id}));
  const contentWindow={postMessage:data=>messages.push(data)},frame={contentWindow};
  let current=buildTimeline(p).scenes[0];
  const player=createTimelinePlayer({project:()=>p,current:()=>current,frame:()=>frame,scene:s=>{current=s;scenes.push(s);},time:()=>{},state:()=>{},error:e=>errors.push(e)});
  t.after(()=>{player.destroy();for(const [key,descriptor] of saved)descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];});
  return {p,player,scenes,audios,messages,errors,ready:()=>listeners.get('message')({source:contentWindow,data:{type:'scene-ready',clipId:scenes.at(-1).clipId}}),step:seconds=>{audios[0].currentTime=10+seconds;stamp+=17;const next=callbacks.entries().next().value;if(next){callbacks.delete(next[0]);next[1]();}}};
}

test('preview sends smooth whole-frame black opacity while continuous music stays alive across the cut',async t=>{
  const h=harness(t);await h.player.play({all:true});
  assert.equal(h.scenes[0].blackOpacity,0);assert.equal(h.scenes[0].visualTransition.fadeIn,0);
  h.ready();h.step(1.8);assert.ok(Math.abs(h.messages.at(-1).blackOpacity-.5)<1e-9);
  h.step(1.9);assert.ok(Math.abs(h.messages.at(-1).blackOpacity-.75)<1e-9,'fade updates even before the 100 ms audio-sync interval');
  h.step(2);assert.equal(h.scenes.at(-1).clipId,'song:b');assert.equal(h.scenes.at(-1).blackOpacity,1);
  h.ready();assert.equal(h.messages.at(-1).blackOpacity,1);
  h.step(2.2);assert.ok(Math.abs(h.messages.at(-1).blackOpacity-.5)<1e-9);
  h.step(2.5);assert.equal(h.messages.at(-1).blackOpacity,0);
  assert.equal(h.audios.length,1);assert.equal(h.audios[0].plays,1);assert.deepEqual(h.errors,[]);
});

test('seek and scene-ready initialize the exact fade position; a zero-second cut never inserts black',t=>{
  const h=harness(t);h.player.seek(2.2);
  assert.ok(Math.abs(h.scenes.at(-1).previewSeconds-.2)<1e-9);
  assert.ok(Math.abs(h.scenes.at(-1).blackOpacity-.5)<1e-9);
  h.ready();assert.ok(Math.abs(h.messages.at(-1).blackOpacity-.5)<1e-9);
  h.p.settings.sceneTransitions={'song:b':{mode:'black',duration:0}};
  h.player.seek(2);assert.equal(h.scenes.at(-1).blackOpacity,0);assert.equal(h.scenes.at(-1).visualTransition.fadeIn,0);
  h.ready();assert.equal(h.messages.at(-1).blackOpacity,0);assert.equal(h.audios.length,1);
});

test('connected difficulty changes blur for 0.3 seconds while the audio element plays once',async t=>{
  const h=harness(t);h.p.settings.sceneTransitions={};await h.player.play({all:true});h.ready();
  h.step(1.925);assert.ok(Math.abs(h.messages.at(-1).blurOpacity-.5)<1e-8);assert.equal(h.messages.at(-1).blackOpacity,0);
  h.step(2);assert.equal(h.scenes.at(-1).blurOpacity,1);h.ready();assert.equal(h.messages.at(-1).blurOpacity,1);
  h.step(2.075);assert.ok(Math.abs(h.messages.at(-1).blurOpacity-.5)<1e-8);
  h.step(2.2);assert.equal(h.messages.at(-1).blurOpacity,0);assert.equal(h.audios.length,1);assert.equal(h.audios[0].plays,1);assert.deepEqual(h.errors,[]);
});

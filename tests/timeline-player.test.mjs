import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry,buildTimeline} from '../shared/core.mjs';
import {createTimelinePlayer} from '../renderer/timeline-player.mjs';

function setup(t){
  const saved=new Map(['Audio','requestAnimationFrame','cancelAnimationFrame','addEventListener','removeEventListener','performance'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const callbacks=new Map(),audios=[],states=[],errors=[],scenes=[];let stamp=0,id=0;
  class AudioStub extends EventTarget{
    constructor(src){super();this.src=src;this.currentTime=0;this.duration=100;this.readyState=0;this.paused=true;this.ended=false;this.seeking=false;this.plays=0;audios.push(this);}
    pause(){this.paused=true;}play(){this.paused=false;this.plays++;return Promise.resolve();}load(){}removeAttribute(){}ready(){this.readyState=4;this.dispatchEvent(new Event('loadedmetadata'));this.dispatchEvent(new Event('canplay'));}
  }
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>stamp}});
  globalThis.Audio=AudioStub;globalThis.requestAnimationFrame=fn=>{callbacks.set(++id,fn);return id;};globalThis.cancelAnimationFrame=n=>callbacks.delete(n);globalThis.addEventListener=()=>{};globalThis.removeEventListener=()=>{};
  const p=newProject();Object.assign(p.settings,{intro:0,overview:0,audioTransition:0,volume:.8});
  p.entries=[newEntry({id:'a',title:'A',constant:10,score:9900000,clear:'NC',duration:.7,audio:'song.wav',audioStart:10}),newEntry({id:'b',title:'B',constant:11,score:9900000,clear:'NC',duration:.7,audio:'song.wav',audioStart:10.7})];p.sequence=p.entries.map(e=>({id:'song:'+e.id,type:'song',entryId:e.id}));
  let current=buildTimeline(p).scenes[0];const player=createTimelinePlayer({project:()=>p,current:()=>current,frame:()=>null,scene:s=>{current=s;scenes.push(s.clipId);},time:()=>{},state:s=>states.push(s),error:e=>errors.push(e)});
  t.after(()=>{player.destroy();for(const[k,d]of saved)d?Object.defineProperty(globalThis,k,d):delete globalThis[k];});
  return{player,p,audios,states,errors,scenes,setStamp:n=>{stamp=n;},step:()=>{const next=callbacks.entries().next().value;if(next){callbacks.delete(next[0]);next[1]();}}};
}
test('preview waits for canplay, follows audio time and keeps a continuous source alive across cuts',async t=>{
  const h=setup(t),pending=h.player.play({all:true});assert.equal(h.audios.length,1);h.setStamp(5000);assert.equal(h.player.cursor,0,'loading time must not consume the movie');h.audios[0].ready();await pending;
  assert.equal(h.audios[0].volume,.8);assert.equal(h.audios[0].plays,1);
  h.setStamp(10000);h.audios[0].currentTime=10.4;h.step();assert.ok(Math.abs(h.player.cursor-.4)<1e-8,'audio time, not elapsed wall time');
  h.audios[0].currentTime=10.9;h.step();assert.equal(h.scenes.at(-1),'song:b');assert.equal(h.audios[0].plays,1,'picture cuts must not restart the shared audio');
  h.player.pause();h.setStamp(20000);assert.ok(Math.abs(h.player.cursor-.9)<1e-8);await h.player.play({all:true});assert.equal(h.audios.length,1);assert.ok(Math.abs(h.player.cursor-.9)<1e-8);assert.deepEqual(h.errors,[]);
});
test('pausing a loading preview cancels its pending media wait cleanly',async t=>{
  const h=setup(t),pending=h.player.play({all:true});assert.equal(h.player.running,true);h.player.pause();await pending;assert.equal(h.player.running,false);assert.equal(h.audios[0].plays,0);assert.deepEqual(h.errors,[]);
});
test('negative source ranges are reported instead of clamped into a misleading preview',async t=>{
  const h=setup(t);h.p.entries[0].audioStart=-1;await h.player.play({all:true,from:0});assert.equal(h.player.running,false);assert.equal(h.audios.every(a=>a.plays===0),true);assert.equal(h.errors.length,1);assert.match(h.errors[0],/音源开始之前/);
});

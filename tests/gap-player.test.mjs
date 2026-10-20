import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry,buildTimeline} from '../shared/core.mjs';
import {createTimelinePlayer} from '../renderer/timeline-player.mjs';

function harness(t){
  const names=['Audio','requestAnimationFrame','cancelAnimationFrame','addEventListener','removeEventListener','performance'];
  const saved=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const callbacks=new Map(),audios=[],scenes=[],errors=[];let stamp=0,nextId=0;
  class AudioStub extends EventTarget{
    constructor(src){super();Object.assign(this,{src,currentTime:0,duration:100,readyState:4,paused:true,ended:false,seeking:false,plays:0});audios.push(this);}
    pause(){this.paused=true;}play(){this.paused=false;this.plays++;return Promise.resolve();}load(){}removeAttribute(){}
  }
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>stamp}});
  globalThis.Audio=AudioStub;
  globalThis.requestAnimationFrame=fn=>{callbacks.set(++nextId,fn);return nextId;};
  globalThis.cancelAnimationFrame=id=>callbacks.delete(id);
  globalThis.addEventListener=()=>{};globalThis.removeEventListener=()=>{};
  const p=newProject();Object.assign(p.settings,{overview:0,segmentGap:1,transition:.4,audioTransition:.2});
  p.entries=[newEntry({id:'a',title:'A',constant:10,score:9900000,duration:.7,audio:'a.wav',audioStart:0}),newEntry({id:'b',title:'B',constant:11,score:9900000,duration:.7,audio:'b.wav',audioStart:0})];
  p.sequence=p.entries.map(e=>({id:'song:'+e.id,type:'song',entryId:e.id}));
  let current=buildTimeline(p).scenes[0];
  const player=createTimelinePlayer({project:()=>p,current:()=>current,frame:()=>null,scene:s=>{current=s;scenes.push(s);},time:()=>{},state:()=>{},error:e=>errors.push(e)});
  t.after(()=>{player.destroy();for(const [key,descriptor] of saved)descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];});
  return {p,player,scenes,audios,errors,advance:async ms=>{stamp+=ms;const next=callbacks.entries().next().value;if(next){callbacks.delete(next[0]);next[1]();}for(let i=0;i<10;i++)await Promise.resolve();}};
}

test('continuous preview pauses media during a silent gap and advances on wall time before starting the next song',async t=>{
  const h=harness(t),plan=buildTimeline(h.p);
  assert.deepEqual(plan.scenes.map(s=>s.type),['song','gap','song']);
  assert.deepEqual(plan.issues,[],'source beginning at zero must remain valid with fades');
  await h.player.play({all:true});
  h.audios[0].currentTime=.6;await h.advance(600);
  assert.ok(Math.abs(h.player.cursor-.6)<1e-7);
  h.audios[0].currentTime=.7;await h.advance(100);
  assert.equal(h.scenes.at(-1).type,'gap');
  assert.equal(h.audios.every(a=>a.paused),true,'the black gap contains no playing media');
  await h.advance(500);
  assert.equal(h.scenes.at(-1).type,'gap');
  assert.ok(Math.abs(h.player.cursor-1.2)<1e-7,'no audio clock is needed during silence');
  await h.advance(500);
  assert.equal(h.scenes.at(-1).clipId,'song:b');
  assert.equal(h.audios[0].plays,1);assert.equal(h.audios[1].plays,1);
  assert.equal(h.audios[1].currentTime,0,'the next song begins at its chosen source position');
  assert.deepEqual(h.errors,[]);
});

test('seek can land inside the gap; playback continues through its remaining duration',async t=>{
  const h=harness(t);h.player.seek(.9);
  assert.equal(h.scenes.at(-1).type,'gap');
  await h.player.play({all:true,from:.9});
  assert.equal(h.audios.every(a=>a.plays===0),true);
  await h.advance(400);
  assert.ok(Math.abs(h.player.cursor-1.3)<1e-7);assert.equal(h.scenes.at(-1).type,'gap');
  await h.advance(400);
  assert.equal(h.scenes.at(-1).clipId,'song:b');assert.equal(h.audios[1].plays,1);
  assert.deepEqual(h.errors,[]);
});

test('single-clip playback from a selected gap resolves to the incoming song and excludes the gap',async t=>{
  const h=harness(t);h.player.seek(.9);h.scenes.length=0;
  await h.player.play({from:.7});
  assert.equal(h.scenes[0].clipId,'song:b');
  assert.ok(Math.abs(h.player.cursor-1.7)<1e-7);
  assert.equal(h.audios[0].plays,0);assert.equal(h.audios[1].plays,1);
  assert.equal(h.scenes.some(s=>s.type==='gap'),false);assert.deepEqual(h.errors,[]);
});

test('an explicit splice-audition range includes the previous song and its silent gap',async t=>{
  const h=harness(t);h.player.seek(1.9);h.scenes.length=0;
  await h.player.play({from:.5,to:2});
  assert.equal(h.scenes[0].clipId,'song:a');near(h.player.cursor,.5);
  h.audios[0].currentTime=.7;await h.advance(200);assert.equal(h.scenes.at(-1).type,'gap');
  await h.advance(1000);assert.equal(h.scenes.at(-1).clipId,'song:b');assert.equal(h.audios[1].plays,1);
  h.audios[1].currentTime=.3;await h.advance(300);assert.equal(h.player.running,false);near(h.player.cursor,2);
  assert.deepEqual(h.errors,[]);
});

function near(actual,expected){assert.ok(Math.abs(actual-expected)<1e-7,`${actual} differs from ${expected}`);}

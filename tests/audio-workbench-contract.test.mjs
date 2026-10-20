import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry,buildTimeline} from '../shared/core.mjs';
import {bindWorkbench,resetWorkbenchHistory,workbenchView,mountWorkbench,syncWorkbench,pauseWorkbench,disposeWorkbench} from '../renderer/workbench.mjs';
import {transitionFor} from '../shared/transitions.mjs';

function harness({video=null}={}){
  const p=newProject();Object.assign(p.settings,{intro:0,overview:0,audioTransition:0});
  p.entries=[newEntry({id:'a',title:'A',constant:10,score:9900000,clear:'NC',video:'a.mp4',audio:'master.wav',start:8,audioStart:40,duration:15}),newEntry({id:'b',title:'B',constant:11,score:9900000,clear:'NC',video:'b.mp4',audio:'master.wav',start:20.5,audioStart:55,duration:15})];
  p.sequence=p.entries.map(e=>({id:'song:'+e.id,type:'song',entryId:e.id}));
  const handlers={},errors=[],listens=[];let selected='song:b',project=p;
  globalThis.confirm=()=>true;
  globalThis.window={arc:{align:async()=>({status:'matched',candidates:[{offset:-34.5,matchedWindows:7}],reason:'test'}),pick:async()=>'',probe:async()=>({duration:120,video:true,audio:true})}};
  const root={addEventListener:(name,handler)=>{handlers[name]=handler;},querySelector:selector=>selector==='#source-video'?video:null};
  resetWorkbenchHistory();
  bindWorkbench(root,{project:()=>project,selected:()=>selected,select:id=>{selected=id;},stop:()=>pauseWorkbench(),refresh:()=>syncWorkbench(root),changed:()=>{},replace:p=>{project=p;},error:e=>errors.push(e),listen:(...args)=>listens.push(args),edit:()=>{}});
  if(video){globalThis.requestAnimationFrame=fn=>setTimeout(fn,0);globalThis.cancelAnimationFrame=clearTimeout;mountWorkbench(root);}
  return{p,errors,listens,get:()=>project,selected:()=>selected,select:id=>{selected=id;},change:(key,value)=>handlers.change({target:{dataset:{wb:key},value,tagName:'INPUT'}}),click:(action,dataset={})=>handlers.click({preventDefault(){},target:{closest:()=>({dataset:{action:'wb-'+action,...dataset}})}})};
}
test('per-card visual and audio controls preserve explicit zero and independent inheritance',()=>{
  const h=harness();h.p.settings.transition=0;h.p.settings.audioTransition=.3;
  h.change('transitionMode','black');
  assert.deepEqual(h.p.settings.sceneTransitions['song:b'],{mode:'black',duration:0});
  h.change('transitionDuration','1.25');h.change('transitionAudioDuration','0');
  assert.deepEqual(h.p.settings.sceneTransitions['song:b'],{mode:'black',duration:1.25,audioDuration:0});
  h.change('transitionMode','cut');
  assert.equal(transitionFor(h.p,'song:b').duration,0);
  assert.equal(h.p.settings.sceneTransitions['song:b'].audioDuration,0);
  h.change('transitionMode','inherit');
  assert.deepEqual(h.p.settings.sceneTransitions['song:b'],{audioDuration:0});
  h.p.settings.transition=2;
  assert.deepEqual(transitionFor(h.p,'song:b'),{mode:'black',duration:2,inherited:true});
  h.change('transitionAudioDuration','');
  assert.equal(h.p.settings.sceneTransitions['song:b'],undefined);
  h.select('overview:3');h.change('transitionAudioDuration','.125');
  assert.deepEqual(h.p.settings.sceneTransitions['overview:1'],{audioDuration:.125});
  assert.equal(h.p.settings.sceneTransitions['overview:3'],undefined);
  assert.deepEqual(h.errors,[]);
});
test('animation edits remain in the project through repeated timeline planning',()=>{
  const h=harness();h.p.sequence.splice(1,0,{id:'animation:test',type:'animation',file:'unlock.mp4',start:1,duration:3,audioMode:'silent',originalVolume:0});h.select('animation:test');
  h.change('duration','5');h.change('originalVolume','.35');h.change('start','2');
  const animation=h.p.sequence.find(x=>x.id==='animation:test');assert.equal(animation.start,2);assert.equal(animation.duration,4);assert.equal(animation.originalVolume,.35);assert.deepEqual(h.errors,[]);assert.equal(buildTimeline(h.p).scenes.find(s=>s.clipId===animation.id).duration,4);
});
test('connecting a chart respects an explicitly selected recording audio mode',async()=>{
  const h=harness();h.p.entries[0].audioMode='video';await h.click('connect');assert.equal(h.p.audioGroups.length,1);assert.equal(h.p.audioGroups[0].source,'a.mp4');assert.equal(h.p.audioGroups[0].sourceStart,8);assert.deepEqual(h.errors,[]);
});
test('extending an existing group removes its gap without shifting the newly connected recording',async()=>{
  const h=harness();h.p.settings.segmentGap=1;
  h.p.entries.push(newEntry({id:'c',title:'C',constant:10,score:9900000,clear:'NC',video:'c.mp4',audio:'different.wav',start:90,audioStart:0,duration:15}));
  h.p.sequence.push({id:'song:c',type:'song',entryId:'c'});
  h.p.audioGroups=[{id:'g',clipIds:['song:a','song:b'],source:'master.wav',sourceStart:40,offsets:{'song:a':-32,'song:b':-34.5},pendingClipIds:[],volume:1}];
  const before=buildTimeline(h.p);assert.equal(before.scenes.find(s=>s.clipId==='song:c').at,31);
  h.select('song:c');await h.click('connect');const plan=buildTimeline(h.p),connected=plan.scenes.find(s=>s.clipId==='song:c');
  assert.equal(connected.at,30);assert.equal(connected.sourceTime,70);assert.equal(connected.entry.start,90);
  assert.equal(h.p.audioGroups[0].offsets['song:c'],20);assert.deepEqual(h.p.audioGroups[0].pendingClipIds,['song:c']);
  assert.equal(plan.scenes.some(s=>s.type==='gap'),false);assert.deepEqual(h.errors,[]);
});
test('common source removal targets the group instead of an unrelated entry property',async()=>{
  const h=harness();h.p.audioGroups=[{id:'g',clipIds:['song:a','song:b'],source:'master.wav',sourceStart:40,offsets:{'song:a':-32,'song:b':-34.5},volume:1}];
  await h.click('clear',{key:'groupSource'});assert.equal(h.p.audioGroups[0].source,'');assert.deepEqual(h.p.audioGroups[0].offsets,{});assert.equal(h.p.entries[1].groupSource,undefined);assert.deepEqual(h.errors,[]);
});
test('candidate audition uses a draft; adopting uses target-minus-source offset',async()=>{
  const h=harness();h.p.audioGroups=[{id:'g',clipIds:['song:a','song:b'],source:'master.wav',sourceStart:40,offsets:{'song:a':-32,'song:b':0},volume:1}];
  await h.click('align');await h.click('audition',{index:'0'});assert.equal(h.listens.length,1);const draft=h.listens[0][2];assert.equal(draft.audioGroups[0].offsets['song:b'],-34.5);assert.equal(h.p.audioGroups[0].offsets['song:b'],0);
  await h.click('adopt',{index:'0'});assert.equal(h.p.audioGroups[0].offsets['song:b'],-34.5);const scene=buildTimeline(h.p).scenes.find(s=>s.clipId==='song:b');assert.equal(scene.sourceTime,55);assert.equal(scene.entry.start,20.5);assert.deepEqual(h.errors,[]);
});

test('inserting before the first song keeps its shared music group and original source position',async()=>{
  const h=harness();h.select('song:a');window.arc.pick=async()=> 'unlock.mp4';
  h.p.audioGroups=[{id:'g',clipIds:['song:a','song:b'],source:'master.wav',sourceStart:40,offsets:{'song:a':-32,'song:b':-34.5},volume:1}];
  await h.click('insert');const [animation]=h.p.sequence,group=h.p.audioGroups[0],plan=buildTimeline(h.p);
  assert.equal(animation.type,'animation');assert.equal(animation.audioMode,'next');assert.deepEqual(group.clipIds,[animation.id,'song:a','song:b']);assert.equal(group.sourceStart,37);
  assert.equal(plan.scenes.find(s=>s.clipId==='song:a').sourceTime,40);assert.deepEqual(plan.issues,[]);assert.deepEqual(h.errors,[]);
  await h.click('undo');assert.deepEqual(h.get().sequence.map(c=>c.id),['song:a','song:b']);assert.deepEqual(h.get().audioGroups[0].clipIds,['song:a','song:b']);
});

test('inserting at any fixed overview page appends an animation that continues the last song music',async()=>{
  for(const id of ['overview:1','overview:3']){
    const h=harness();h.select(id);window.arc.pick=async()=> 'unlock.mp4';
    h.p.audioGroups=[{id:'g',clipIds:['song:a','song:b'],source:'master.wav',sourceStart:40,offsets:{'song:a':-32,'song:b':-34.5},volume:1}];
    await h.click('insert');const animation=h.p.sequence.at(-1),plan=buildTimeline(h.p);
    assert.equal(animation.type,'animation');assert.equal(animation.audioMode,'previous');assert.deepEqual(h.p.audioGroups[0].clipIds,['song:a','song:b']);assert.deepEqual(plan.issues,[]);
    const sound=plan.audio.find(a=>a.clipIds.includes(animation.id));assert.equal(sound.file,'master.wav');assert.equal(sound.start,40);assert.equal(sound.duration,33);assert.deepEqual(h.errors,[]);
  }
});

test('tail insertion without a shared group uses the preceding song rather than requiring a missing next song',async()=>{
  const h=harness();h.select('overview:1');window.arc.pick=async()=> 'unlock.mp4';await h.click('insert');
  const animation=h.p.sequence.at(-1),plan=buildTimeline(h.p);assert.equal(animation.audioMode,'previous');assert.deepEqual(plan.issues,[]);assert.ok(plan.audio.some(a=>a.clipIds.includes(animation.id)));assert.deepEqual(h.errors,[]);
});

test('time editing keeps typed millisecond precision instead of replacing it with rounded frame time',()=>{
  const h=harness();h.change('duration','15.001');
  assert.equal(h.p.entries[1].duration,15.001);
  assert.equal(buildTimeline(h.p).scenes.find(s=>s.clipId==='song:b').duration,15);
  assert.match(workbenchView(h.p,'song:b'),/data-wb="duration"[^>]*value="15\.001"/);
  h.change('duration','15.002');assert.equal(h.p.entries[1].duration,15.002);
  h.change('duration','');assert.equal(h.p.entries[1].duration,15.002);
  assert.equal(h.errors.length,1);
});

test('volume steps are defined once and time labels describe the source file plainly',()=>{
  const h=harness();h.p.sequence.push({id:'animation:test',type:'animation',file:'unlock.mp4',start:1,duration:3,audioMode:'silent',originalVolume:0});
  const html=workbenchView(h.p,'animation:test');
  const volume=html.match(/<input data-wb="originalVolume"[^>]*>/)[0];
  assert.equal((volume.match(/\bstep=/g)||[]).length,1);assert.match(volume,/step="\.05"/);
  assert.match(html,/视频开始时间（秒）/);assert.match(html,/视频结束时间（秒）/);
  assert.doesNotMatch(html,/入点|出点/);
});

test('a negative typed start is bounded before calculating the remaining duration',()=>{
  const h=harness();h.change('start','-1');
  assert.equal(h.p.entries[1].start,0);assert.equal(h.p.entries[1].duration,35.5);
  assert.deepEqual(h.errors,[]);
});

const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
class SourceVideo extends EventTarget{
  constructor(){super();Object.assign(this,{time:0,duration:120,readyState:4,paused:true,seeking:false,muted:true,ended:false});}
  get currentTime(){return this.time;}set currentTime(value){this.time=value;this.seeking=true;queueMicrotask(()=>{this.seeking=false;this.dispatchEvent(new Event('seeked'));});}
  pause(){if(!this.paused){this.paused=true;this.dispatchEvent(new Event('pause'));}}
  async play(){this.paused=false;this.dispatchEvent(new Event('play'));}
  tick(time){this.time=time;this.dispatchEvent(new Event('timeupdate'));}
}
test('source looping uses edited cut boundaries and stops cleanly during editing',async()=>{
  const video=new SourceVideo();
  const h=harness({video});await h.click('source-loop');await settle();
  assert.equal(video.currentTime,20.5);
  h.change('duration','2');assert.equal(video.paused,true);await h.click('source-loop');await settle();video.tick(23);await settle();
  assert.equal(video.currentTime,20.5);
  h.change('start','21');await h.click('source-loop');await settle();
  assert.equal(video.currentTime,21);
  h.change('end','23');await h.click('source-loop');await settle();video.tick(23);await settle();
  assert.equal(video.currentTime,21);assert.deepEqual(h.errors,[]);
  disposeWorkbench();video.tick(24);await settle();assert.equal(video.paused,true);assert.equal(video.currentTime,24);
});

test('source looping follows the current linked recording start after common audio moves',async()=>{
  const video=new SourceVideo();
  const h=harness({video});
  h.p.audioGroups=[{id:'g',clipIds:['song:a','song:b'],source:'master.wav',sourceStart:40,offsets:{'song:a':-32,'song:b':-34.5},volume:1}];
  await h.click('source-loop');await settle();assert.equal(video.currentTime,20.5);
  h.change('groupStart','42');await h.click('source-loop');await settle();
  assert.equal(video.currentTime,22.5);
  video.tick(37.5);await settle();assert.equal(video.currentTime,22.5);
  assert.deepEqual(h.errors,[]);disposeWorkbench();
});

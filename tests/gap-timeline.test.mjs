import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry,buildTimeline,validateProject} from '../shared/core.mjs';
import {withSceneTransitions,blackOpacity} from '../shared/transitions.mjs';

const near=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-8,message||`${actual} differs from ${expected}`);
function project(count=3){
  const p=newProject();Object.assign(p.settings,{overview:0,segmentGap:1,audioTransition:.35,transition:.8,fps:60});
  p.entries=Array.from({length:count},(_,index)=>{const id=String.fromCharCode(97+index);return newEntry({id,title:'Song '+id,constant:10,score:9900000-index,duration:10,audio:id+'.wav',audioStart:0});});
  p.sequence=p.entries.map(e=>({id:'song:'+e.id,type:'song',entryId:e.id}));
  return p;
}
const gaps=plan=>plan.scenes.filter(s=>s.type==='gap');

test('independent songs insert real one-second gaps and shift timeline audio without shifting any source trim',()=>{
  const p=project(),original=structuredClone(p.entries),plan=buildTimeline(p);
  assert.deepEqual(plan.issues,[]);assert.equal(plan.duration,32);
  assert.deepEqual(plan.scenes.map(s=>[s.type,s.at,s.duration]),[['song',0,10],['gap',10,1],['song',11,10],['gap',21,1],['song',22,10]]);
  assert.deepEqual(gaps(plan).map(s=>[s.clipId,s.incomingClipId]),[['gap:song:b','song:b'],['gap:song:c','song:c']]);
  assert.deepEqual(plan.audio.map(a=>[a.at,a.start,a.duration]),[[0,0,10],[11,0,10],[22,0,10]]);
  assert.deepEqual(p.entries,original,'planning does not rewrite the user\'s cuts');
  for(const gap of gaps(plan))assert.equal(plan.audio.some(a=>a.at<gap.at+gap.duration-1e-7&&a.at+a.duration>gap.at+1e-7),false);
});

test('per-card gap overrides preserve zero and are aligned to output frames; visual cuts suppress the hold',()=>{
  for(const fps of [30,60]){
    const p=project();p.settings.fps=fps;
    p.settings.sceneTransitions={'song:b':{gapDuration:.555},'song:c':{gapDuration:0}};
    const plan=buildTimeline(p),expected=Math.round(.555*fps)/fps;
    assert.equal(gaps(plan).length,1);near(gaps(plan)[0].duration,expected);near(plan.duration,30+expected);
    for(const scene of plan.scenes){near(scene.at*fps,Math.round(scene.at*fps));near(scene.duration*fps,Math.round(scene.duration*fps));}
    p.settings.sceneTransitions['song:b']={mode:'cut',duration:0,gapDuration:4};
    assert.equal(gaps(buildTimeline(p)).length,0,'a direct cut has no black hold even with a stored gap override');
    p.settings.segmentGap=0;p.settings.sceneTransitions={'song:b':{gapDuration:1.2}};
    const override=buildTimeline(p);assert.equal(gaps(override).length,1);near(gaps(override)[0].duration,1.2);
  }
});

test('contained music envelopes allow source zero, never extend source ranges, and honor per-boundary zero',()=>{
  const p=project();p.settings.audioTransition=1.25;p.settings.sceneTransitions={'song:b':{audioDuration:0},'song:c':{audioDuration:.7}};
  const plan=buildTimeline(p),[a,b,c]=plan.audio;
  assert.deepEqual(plan.issues,[]);
  assert.deepEqual(plan.audio.map(track=>[track.start,track.duration,track.fadeOffset,track.fadeDuration]),[[0,10,0,10],[0,10,0,10],[0,10,0,10]]);
  assert.equal(a.fadeOut,0);assert.equal(b.fadeIn,0);near(b.fadeOut,.7);near(c.fadeIn,.7);
  delete p.settings.sceneTransitions['song:b'].audioDuration;
  const restored=buildTimeline(p);near(restored.audio[0].fadeOut,1.25);near(restored.audio[1].fadeIn,1.25);
  p.entries[1].duration=.5;
  const short=buildTimeline(p).audio.find(track=>track.clipIds.includes('song:b'));
  near(short.fadeIn,.25);near(short.fadeOut,.25);assert.ok(short.fadeIn+short.fadeOut<=short.duration);
});

test('silent songs still receive independent visual breathing room without acquiring an audio track',()=>{
  const p=project();p.entries.forEach(e=>e.audioMode='silent');
  const plan=buildTimeline(p);assert.deepEqual(plan.issues,[]);assert.equal(plan.audio.length,0);assert.equal(gaps(plan).length,2);assert.equal(plan.duration,32);
});

test('a truly contiguous source keeps two difficulty charts connected despite inherited gap and fade settings',()=>{
  const p=project(2);Object.assign(p.entries[0],{audio:'same.wav',audioStart:15});Object.assign(p.entries[1],{audio:'same.wav',audioStart:25});
  const plan=buildTimeline(p);assert.deepEqual(plan.issues,[]);assert.equal(gaps(plan).length,0);assert.equal(plan.duration,20);
  assert.equal(plan.audio.length,1);assert.deepEqual([plan.audio[0].at,plan.audio[0].start,plan.audio[0].duration],[0,15,20]);
  assert.equal(plan.scenes[1].connectedFromPrevious,true);assert.equal(plan.audio[0].fadeIn,0);assert.equal(plan.audio[0].fadeOut,0);
  assert.deepEqual(withSceneTransitions(p,plan.scenes).map(s=>s.visualTransition),[{fadeIn:0,fadeOut:0,blurOut:.15},{fadeIn:0,fadeOut:0,blurIn:.15}]);
});

test('next/previous borrowing and a grouped unlock animation remain one uninterrupted block, with gaps only outside it',()=>{
  const p=project(4),[outside,a,b,tail]=p.entries;
  p.sequence=[{id:'song:'+outside.id,type:'song',entryId:outside.id},{id:'before',type:'animation',file:'before.mp4',duration:2,audioMode:'next',originalVolume:0},{id:'song:'+a.id,type:'song',entryId:a.id},{id:'unlock',type:'animation',file:'unlock.mp4',duration:3,audioMode:'previous',originalVolume:0},{id:'song:'+b.id,type:'song',entryId:b.id},{id:'after',type:'animation',file:'after.mp4',duration:2,audioMode:'previous',originalVolume:0},{id:'song:'+tail.id,type:'song',entryId:tail.id}];
  p.audioGroups=[{id:'connected',clipIds:['song:'+a.id,'unlock','song:'+b.id],source:'shared.wav',sourceStart:20,offsets:{},volume:1}];
  const plan=buildTimeline(p);assert.deepEqual(plan.issues,[]);
  assert.deepEqual(gaps(plan).map(s=>s.incomingClipId),['before','song:'+tail.id]);
  const connected=plan.audio.find(track=>track.groupId==='connected');
  assert.deepEqual([connected.at,connected.start,connected.duration],[11,18,27]);
  for(const id of ['song:'+a.id,'unlock','song:'+b.id,'after'])assert.equal(plan.scenes.find(s=>s.clipId===id).connectedFromPrevious,true,id);
  assert.equal(plan.scenes.find(s=>s.clipId==='song:'+b.id).sourceTime,33,'the new gap shifts film time, not shared source time');
  const faded=withSceneTransitions(p,plan.scenes);
  assert.deepEqual(faded.find(s=>s.clipId==='unlock').visualTransition,{fadeIn:0,fadeOut:0,blurOut:.15});
  assert.deepEqual(faded.find(s=>s.clipId==='song:'+b.id).visualTransition,{fadeIn:0,fadeOut:0,blurIn:.15});
});

test('ungrouped borrowed animations join their chosen neighboring song without inserting an internal gap',()=>{
  for(const mode of ['next','previous']){
    const p=project(2);p.entries[1].audioStart=20;
    p.sequence.splice(1,0,{id:'unlock',type:'animation',file:'unlock.mp4',duration:3,audioMode:mode,originalVolume:0});
    const plan=buildTimeline(p);assert.deepEqual(plan.issues,[]);
    assert.deepEqual(gaps(plan).map(s=>s.incomingClipId),mode==='next'?['unlock']:['song:b']);
    const joined=plan.audio.find(track=>track.clipIds.includes('unlock'));
    assert.deepEqual(joined.clipIds,mode==='next'?['unlock','song:b']:['song:a','unlock']);assert.equal(joined.duration,13);
  }
});

test('overview pages continue the final source without additional gaps, seeks or fades',()=>{
  const p=project(23);p.settings.overview=2;
  const plan=buildTimeline(p),pages=plan.scenes.filter(s=>s.type==='overview'),lastSong=plan.scenes.filter(s=>s.type==='song').at(-1);
  assert.deepEqual(plan.issues,[]);assert.equal(gaps(plan).length,22);assert.equal(pages.length,3);
  assert.deepEqual(pages.map(s=>s.at),[lastSong.at+10,lastSong.at+12,lastSong.at+14]);
  assert.ok(pages.every(s=>s.connectedFromPrevious));
  const track=plan.audio.find(a=>a.clipIds.includes('overview:3'));
  assert.equal(track.at,lastSong.at);assert.equal(track.start,0);assert.equal(track.duration,16);
  assert.equal(track.clipIds.filter(id=>id.startsWith('overview:')).length,3);
  const visual=withSceneTransitions(p,plan.scenes);assert.ok(visual.filter(s=>s.type==='overview').every(s=>s.visualTransition.fadeIn===0&&s.visualTransition.fadeOut===0));
});

test('visual fades straddle the actual hold while the gap itself has no transition envelope or card content',()=>{
  const p=project(2),plan=buildTimeline(p),visual=withSceneTransitions(p,plan.scenes),[a,gap,b]=visual;
  assert.deepEqual(a.visualTransition,{fadeIn:0,fadeOut:.4});assert.deepEqual(gap.visualTransition,{fadeIn:0,fadeOut:0});assert.deepEqual(b.visualTransition,{fadeIn:.4,fadeOut:0});
  near(blackOpacity(a.visualTransition,9.8,a.duration),.5);assert.equal(blackOpacity(a.visualTransition,10,a.duration),1);
  assert.equal(blackOpacity(b.visualTransition,0,b.duration),1);near(blackOpacity(b.visualTransition,.2,b.duration),.5);
  assert.equal(gap.type,'gap');assert.equal(gap.entry,undefined);assert.equal(gap.entries,undefined);assert.equal(gap.file,undefined);assert.equal(gap.duration,1);
});

test('single-song extraction excludes adjacent holds and preserves audio source and envelope positions',()=>{
  const p=project();p.entries[1].audioStart=17;
  const plan=buildTimeline(p),fullSong=plan.scenes.find(s=>s.clipId==='song:b'),single=buildTimeline(p,{singleId:'b'});
  assert.equal(fullSong.at,11);assert.equal(single.duration,10);assert.equal(single.scenes.length,1);assert.equal(single.scenes[0].type,'song');assert.equal(single.scenes[0].at,0);
  assert.deepEqual(single.issues,[]);assert.equal(single.audio.length,1);
  assert.deepEqual([single.audio[0].at,single.audio[0].start,single.audio[0].duration,single.audio[0].fadeOffset,single.audio[0].fadeDuration],[0,17,10,0,10]);
  near(single.audio[0].fadeIn,.35);near(single.audio[0].fadeOut,.35);
});

test('gap settings survive save and reload, and malformed values are rejected instead of silently clamped',()=>{
  const p=project();p.settings.segmentGap=0;p.settings.sceneTransitions={'song:b':{gapDuration:0},'song:c':{gapDuration:1.25,audioDuration:0}};
  const recovered=validateProject(JSON.parse(JSON.stringify(p)));
  assert.equal(recovered.settings.segmentGap,0);assert.deepEqual(recovered.settings.sceneTransitions,p.settings.sceneTransitions);
  assert.deepEqual(gaps(buildTimeline(recovered)).map(s=>s.duration),[1.25]);
  for(const value of [-1,5.01,NaN,null,'',false]){
    const bad=project();bad.settings.segmentGap=value;assert.throws(()=>validateProject(bad),/segmentGap/);
    bad.settings.segmentGap=1;bad.settings.sceneTransitions={'song:b':{gapDuration:value}};assert.throws(()=>validateProject(bad),/留白/);
  }
});

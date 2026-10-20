import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry,validateProject,ranked} from '../shared/core.mjs';
import {ensureSequence,resetSequence,buildTimeline} from '../shared/timeline.mjs';

function project(){
  const p=newProject();p.settings.intro=0;p.settings.overview=0;p.settings.segmentGap=0;
  p.entries=[newEntry({id:'ftr',title:'Same Song',difficulty:'FTR',constant:10,score:9900000,clear:'NC',video:'ftr.mp4',audio:'song.wav',audioStart:40,start:8,duration:15}),newEntry({id:'byd',title:'Same Song',difficulty:'BYD',constant:11,score:9900000,clear:'NC',video:'byd.mp4',audio:'song.wav',audioStart:55,start:20.5,duration:15})];
  resetSequence(p,'countdown');return p;
}

test('sequence and animation identities remain stable across timeline reads and asynchronous editors',()=>{
  const p=project(),animation={id:'unlock',type:'animation',file:'first.mp4',start:0,duration:3,audioMode:'next',originalVolume:0};
  p.sequence.splice(1,0,animation);const originalSequence=p.sequence;
  const editorClip=ensureSequence(p)[1];buildTimeline(p);buildTimeline(p,{singleId:'ftr'});
  assert.equal(p.sequence,originalSequence);assert.equal(p.sequence[1],animation);assert.equal(editorClip,animation);
  editorClip.file='chosen-later.mp4';editorClip.duration=5;
  const plan=buildTimeline(p);assert.equal(plan.scenes.find(s=>s.clipId==='unlock').file,'chosen-later.mp4');assert.equal(plan.scenes.find(s=>s.clipId==='unlock').duration,5);
});

test('v1 projects migrate clip order and media without changing rank, source cuts or override',()=>{
  const p=project();delete p.sequence;p.version=1;p.entries[0].ratingOverride=13.1234;
  const q=validateProject(JSON.parse(JSON.stringify(p)));
  assert.equal(q.version,2);assert.deepEqual(q.sequence.map(c=>c.entryId),['byd','ftr']);
  assert.equal(q.entries[0].start,8);assert.equal(q.entries[0].audioStart,40);assert.equal(q.entries[0].duration,15);assert.equal(q.entries[0].ratingOverride,13.1234);
});

test('custom sequence survives imports and removes invalid charts; exclusion keeps Best ranking',()=>{
  const p=project();p.sequence.reverse();
  const before=ranked(p).map(e=>e.id);
  p.entries.push(newEntry({id:'third',title:'Third',constant:9,score:9900000,clear:'NC'}));
  assert.deepEqual(ensureSequence(p).map(c=>c.entryId),['byd','ftr','third']);
  p.excludedEntryIds=['ftr'];
  assert.deepEqual(ensureSequence(p).map(c=>c.entryId),['byd','third']);
  assert.deepEqual(ranked(p).filter(e=>e.id!=='third').map(e=>e.id),before);
  p.entries=p.entries.filter(e=>e.id!=='byd');assert.deepEqual(ensureSequence(p).map(c=>c.entryId),['third']);
});

test('a continuous group takes one source across FTR, animation, BYD and overview; legacy intro is ignored',()=>{
  const p=project();p.settings.intro=3;p.settings.overview=4;
  p.sequence.splice(1,0,{id:'unlock',type:'animation',file:'unlock.mp4',start:2,duration:3,audioMode:'previous',originalVolume:.25});
  p.audioGroups=[{id:'same',clipIds:['song:ftr','unlock','song:byd'],source:'song.wav',sourceStart:40,offsets:{'song:ftr':-32,'song:byd':-34.5},volume:1}];
  const plan=buildTimeline(p);
  assert.equal(plan.issues.length,0);assert.equal(plan.duration,37);
  const track=plan.audio.find(a=>a.groupId==='same');assert.equal(track.start,40);assert.equal(track.at,0);assert.equal(track.duration,37);
  assert.equal(plan.audio.filter(a=>a.file==='song.wav').length,1);
  const byd=plan.scenes.find(s=>s.entry?.id==='byd');assert.equal(byd.sourceTime,58);assert.equal(byd.entry.start,23.5);
  assert.equal(p.entries.find(e=>e.id==='byd').start,20.5,'planning must never overwrite original source cut');
  const overlay=plan.audio.find(a=>a.kind==='animation-original');assert.equal(overlay.at,15);assert.equal(overlay.start,2);assert.equal(overlay.duration,3);assert.equal(overlay.volume,.2);
});

test('next animation merges with following song; overview continues without per-page restart',()=>{
  const p=project();p.entries=p.entries.slice(0,1);p.settings.intro=4;p.settings.overview=5;
  p.sequence=[{id:'unlock',type:'animation',file:'unlock.mp4',start:0,duration:3,audioMode:'next',originalVolume:0},{id:'song:ftr',type:'song',entryId:'ftr'}];
  const plan=buildTimeline(p);assert.equal(plan.issues.length,0);
  assert.equal(plan.audio.length,1);assert.equal(plan.audio[0].start,37);assert.equal(plan.audio[0].duration,23);assert.equal(plan.audio[0].at,0);
});

test('short pre-roll and shifted video positions are actionable errors',()=>{
  const p=project();p.entries[0].audioStart=-1;p.entries[0].start=-1;
  const plan=buildTimeline(p);assert.ok(plan.issues.some(i=>i.code==='audio-start'));assert.ok(plan.issues.some(i=>i.code==='video-start'));
});

test('reordering a connected group is blocked rather than silently reconnecting different audio',()=>{
  const p=project();p.audioGroups=[{id:'g',clipIds:['song:ftr','song:byd'],source:'song.wav',sourceStart:40,offsets:{}}];
  p.sequence.reverse();assert.ok(buildTimeline(p).issues.some(i=>i.code==='group-order'));
});

test('single-clip preview crops a shared source at precisely the same song position',()=>{
  const p=project();p.settings.intro=3;p.audioGroups=[{id:'g',clipIds:['song:ftr','song:byd'],source:'song.wav',sourceStart:40,offsets:{'song:ftr':-32,'song:byd':-34.5}}];
  const plan=buildTimeline(p,{singleId:'byd'});assert.equal(plan.scenes.length,1);assert.equal(plan.scenes[0].at,0);assert.equal(plan.audio.length,1);assert.equal(plan.audio[0].start,55);assert.equal(plan.audio[0].duration,15);assert.equal(plan.duration,15);
});

test('explicit silent segments do not acquire legacy BGM and groups do not double legacy audio',()=>{
  const p=project();p.settings.globalBgm='old.mp3';p.settings.intro=3;p.settings.overview=4;
  p.audioGroups=[{id:'g',clipIds:['song:ftr','song:byd'],source:'song.wav',sourceStart:40,offsets:{}}];
  const plan=buildTimeline(p);assert.equal(plan.audio.length,1);assert.equal(plan.audio[0].duration,34);
  p.audioGroups=[];p.entries.forEach(e=>e.audioMode='silent');assert.equal(buildTimeline(p).audio.length,0);
});

test('independent music fades inside its selected source range and accepts a zero source start',()=>{
  const p=project();p.entries[1].audioStart=80;p.settings.audioTransition=.2;
  const plan=buildTimeline(p),[a,b]=plan.audio;
  assert.equal(a.duration,15);assert.equal(a.fadeOut,.2);
  assert.equal(b.at,15);assert.equal(b.start,80);assert.equal(b.duration,15);assert.equal(b.fadeIn,.2);
  assert.equal(plan.duration,30,'contained music fades must not change picture timing');
  const single=buildTimeline(p,{singleId:'byd'}),incoming=single.audio.find(x=>x.id===b.id);
  assert.equal(incoming.fadeOffset,0);assert.equal(incoming.fadeDuration,b.duration);assert.equal(incoming.start,80);
  p.entries[1].audioStart=0;assert.ok(!buildTimeline(p).issues.some(i=>i.code==='audio-start'));
  p.settings.audioTransition=0;assert.ok(!buildTimeline(p).issues.some(i=>i.code==='audio-start'));
});

test('overview pages all advance the final song source rather than restarting each page',()=>{
  const p=project();p.entries=Array.from({length:23},(_,i)=>newEntry({id:`song${i}`,title:`Song ${i}`,constant:10,score:9900000-i,clear:'NC',audio:`source${i}.wav`,audioStart:40,duration:1}));
  p.settings.intro=0;p.settings.overview=2;p.settings.audioTransition=0;resetSequence(p,'ascending');
  const plan=buildTimeline(p),pages=plan.scenes.filter(s=>s.type==='overview');
  assert.equal(pages.length,3);assert.deepEqual(pages.map(s=>s.page),[1,2,3]);
  const tail=plan.audio.find(a=>a.clipIds.includes('overview:3'));
  assert.equal(tail.file,'source22.wav');assert.equal(tail.start,40);assert.equal(tail.duration,7);assert.equal(tail.clipIds.filter(id=>id.startsWith('overview:')).length,3);
});

test('a zero music override disables only its independent join and clearing it restores the global fade',()=>{
  const p=project();p.settings.audioTransition=.2;p.entries[1].audioStart=80;
  p.entries.push(newEntry({id:'third',title:'Third',constant:10,score:9900000,clear:'NC',audio:'third.wav',audioStart:40,duration:15}));
  p.sequence.push({id:'song:third',type:'song',entryId:'third'});
  p.settings.sceneTransitions={'song:byd':{mode:'cut',duration:0,audioDuration:0}};
  const plan=buildTimeline(p),[a,b,c]=plan.audio;
  assert.equal(a.duration,15);assert.equal(a.fadeOut,0);
  assert.equal(b.at,15);assert.equal(b.start,80);assert.equal(b.fadeIn,0);
  assert.equal(b.fadeOut,.2);assert.equal(c.fadeIn,.2);
  delete p.settings.sceneTransitions['song:byd'].audioDuration;
  const inherited=buildTimeline(p);assert.equal(inherited.audio[0].fadeOut,.2);assert.equal(inherited.audio[1].fadeIn,.2);
  assert.equal(inherited.duration,45);assert.deepEqual(inherited.issues,[]);
});

test('per-card fades never split contiguous music or restart a connected group',()=>{
  for(const grouped of [false,true]){
    const p=project();p.settings.audioTransition=.5;p.settings.sceneTransitions={'song:byd':{mode:'black',duration:2,audioDuration:1}};
    if(grouped)p.audioGroups=[{id:'same',clipIds:['song:ftr','song:byd'],source:'song.wav',sourceStart:40,offsets:{}}];
    const plan=buildTimeline(p);assert.deepEqual(plan.issues,[]);assert.equal(plan.audio.length,1);
    assert.equal(plan.audio[0].start,40);assert.equal(plan.audio[0].duration,30);
    assert.equal(plan.audio[0].fadeIn,0);assert.equal(plan.audio[0].fadeOut,0);
  }
});

test('scene transition serialization preserves zeros, audio-only inheritance and rejects malformed durations',()=>{
  const p=project();p.settings.sceneTransitions={'song:ftr':{mode:'black',duration:0,audioDuration:0},'song:byd':{audioDuration:.125},'overview:1':{mode:'cut',duration:0},empty:{}};
  const expected=structuredClone(p.settings.sceneTransitions);delete expected.empty;
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(p))).settings.sceneTransitions,expected);
  for(const transition of [null,[],false,{mode:'bad',duration:1},{mode:'black'},{duration:1},{mode:'black',duration:-1},{mode:'cut',duration:6},{mode:'black',duration:false},{mode:'black',duration:''},{audioDuration:null},{audioDuration:''},{audioDuration:false},{audioDuration:NaN},{audioDuration:-1},{audioDuration:2.1}]){
    const bad=project();bad.settings.sceneTransitions={'song:byd':transition};assert.throws(()=>validateProject(bad),/转场|淡入淡出/);
  }
});

test('ungrouped next/previous animations extend grouped music through overview',()=>{
  const p=project();p.settings.intro=3;p.settings.overview=4;
  p.sequence.unshift({id:'before',type:'animation',file:'before.mp4',start:0,duration:2,audioMode:'next',originalVolume:0});
  p.sequence.push({id:'after',type:'animation',file:'after.mp4',start:0,duration:2,audioMode:'previous',originalVolume:0});
  p.audioGroups=[{id:'g',clipIds:['song:ftr','song:byd'],source:'song.wav',sourceStart:40,offsets:{}}];
  const plan=buildTimeline(p);assert.equal(plan.issues.length,0);assert.equal(plan.audio.length,1);assert.equal(plan.audio[0].at,0);assert.equal(plan.audio[0].start,38);assert.equal(plan.audio[0].duration,38);
});

test('new pending video alignment blocks export planning until explicitly confirmed',()=>{
  const p=project();p.audioGroups=[{id:'g',clipIds:['song:ftr','song:byd'],source:'song.wav',sourceStart:40,offsets:{},pendingClipIds:['song:byd']}];
  assert.ok(buildTimeline(p).issues.some(i=>i.code==='calibration-pending'&&i.clipId==='song:byd'));
  p.audioGroups[0].pendingClipIds=[];assert.ok(!buildTimeline(p).issues.some(i=>i.code==='calibration-pending'));
  delete p.audioGroups[0].pendingClipIds;assert.ok(!buildTimeline(p).issues.some(i=>i.code==='calibration-pending'));
});

test('pending alignment persists through save/recover and reorder, while stale members are cleaned',()=>{
  const p=project();p.audioGroups=[{id:'g',clipIds:['song:ftr','song:byd'],source:'song.wav',sourceStart:40,offsets:{'song:ftr':-32,'song:byd':-34.5},pendingClipIds:['song:byd','song:byd','song:deleted']}];
  const q=validateProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(q.audioGroups[0].pendingClipIds,['song:byd']);assert.equal(q.audioGroups[0].offsets['song:byd'],-34.5);
  q.sequence.reverse();assert.ok(buildTimeline(q).issues.some(i=>i.code==='group-order'));assert.deepEqual(q.audioGroups[0].pendingClipIds,['song:byd']);
  q.sequence.reverse();assert.ok(buildTimeline(q).issues.some(i=>i.code==='calibration-pending'));
  q.audioGroups[0].clipIds=['song:ftr'];ensureSequence(q);assert.deepEqual(q.audioGroups[0].pendingClipIds,[]);
});

test('removing a video clears only its pending flag and shifting music retains confirmed offsets',()=>{
  const p=project();p.audioGroups=[{id:'g',clipIds:['song:ftr','song:byd'],source:'song.wav',sourceStart:40,offsets:{'song:ftr':-32,'song:byd':-34.5},pendingClipIds:['song:ftr','song:byd']}];
  p.entries[1].video='';buildTimeline(p);assert.deepEqual(p.audioGroups[0].pendingClipIds,['song:ftr']);
  p.audioGroups[0].pendingClipIds=[];p.audioGroups[0].sourceStart=43;
  const plan=buildTimeline(p);assert.ok(!plan.issues.some(i=>i.code==='calibration-pending'));assert.equal(plan.scenes.find(s=>s.entry?.id==='ftr').entry.start,11);assert.equal(p.audioGroups[0].offsets['song:ftr'],-32);
});

test('duplicate group ids cannot collide in the preview audio map and malformed pending flags are rejected',()=>{
  const p=project();p.audioGroups=[{id:'duplicate',clipIds:['song:ftr'],source:'song.wav',sourceStart:40,offsets:{}},{id:'duplicate',clipIds:['song:byd'],source:'song.wav',sourceStart:70,offsets:{}}];
  const q=validateProject(JSON.parse(JSON.stringify(p)));assert.notEqual(q.audioGroups[0].id,q.audioGroups[1].id);
  p.audioGroups[0].pendingClipIds='song:ftr';assert.throws(()=>validateProject(p),/待校准列表/);assert.ok(buildTimeline(p).issues.some(i=>i.code==='calibration-state'));
});

test('explicit invalid animation effect duration is reported and never produces invalid audio',()=>{
  for(const value of [-1,0,NaN,Infinity,null,'bad','',false]){
    const p=project();p.sequence.splice(1,0,{id:'unlock',type:'animation',file:'unlock.mp4',start:0,duration:3,audioMode:'silent',originalVolume:0,effectFile:'effect.wav',effectDuration:value});
    const plan=buildTimeline(p);assert.ok(plan.issues.some(i=>i.code==='animation-effect'&&i.clipId==='unlock'),String(value));
    assert.equal(plan.audio.some(a=>a.kind==='animation-effect'),false);assert.ok(plan.audio.every(a=>Number.isFinite(a.duration)&&a.duration>0));
    assert.throws(()=>validateProject(p),/effectDuration/);
  }
  const p=project();p.sequence.splice(1,0,{id:'unlock',type:'animation',file:'unlock.mp4',duration:3,audioMode:'silent',effectFile:'effect.wav'});
  assert.equal(buildTimeline(p).audio.find(a=>a.kind==='animation-effect').duration,3,'omitted duration still uses animation length');
  p.sequence[1].effectDuration=1.25;assert.equal(buildTimeline(p).audio.find(a=>a.kind==='animation-effect').duration,1.25);
  p.sequence[1].effectDuration=0;p.sequence[1].effectVolume=0;assert.ok(buildTimeline(p).issues.some(i=>i.code==='animation-effect'),'muting must not conceal malformed timing');
});

test('explicit invalid animation timing and volume survive normalization as actionable issues',()=>{
  for(const value of [-1,0,NaN,Infinity,null,'bad','',false]){
    const p=project();p.sequence.splice(1,0,{id:'unlock',type:'animation',file:'unlock.mp4',duration:value,audioMode:'own',originalVolume:1});
    const plan=buildTimeline(p);assert.ok(plan.issues.some(i=>i.code==='duration'&&i.clipId==='unlock'),String(value));assert.equal(plan.scenes.some(s=>s.clipId==='unlock'),false);
    assert.ok(buildTimeline(p,{singleId:'unlock'}).issues.some(i=>i.code==='duration'));assert.throws(()=>validateProject(p),/duration/);
  }
  for(const [field,value,code] of [['start',NaN,'animation-range'],['start',-1,'animation-range'],['originalVolume',Infinity,'animation-volume'],['originalVolume',-1,'animation-volume'],['originalVolume',2,'animation-volume'],['effectStart',NaN,'animation-effect'],['effectVolume',NaN,'animation-effect']]){
    const p=project();p.settings.audioTransition=0;p.sequence.splice(1,0,{id:'unlock',type:'animation',file:'unlock.mp4',start:0,duration:3,audioMode:'own',originalVolume:1,effectFile:'effect.wav',[field]:value});
    const plan=buildTimeline(p);assert.ok(plan.issues.some(i=>i.code===code),`${field} ${value}`);assert.throws(()=>validateProject(p),new RegExp(field));
    assert.ok(plan.audio.every(a=>Number.isFinite(a.start)&&a.start>=0&&Number.isFinite(a.volume)&&a.volume>=0&&a.volume<=1));
  }
});

test('invalid shared source positions, volumes and offsets cannot be defaulted into valid data',()=>{
  for(const field of ['sourceStart','volume'])for(const value of [-1,NaN,Infinity,null,'bad','',false,...field==='volume'?[2]:[]]){
    const p=project();p.audioGroups=[{id:'g',clipIds:['song:ftr','song:byd'],source:'song.wav',sourceStart:40,volume:1,offsets:{},[field]:value}];
    assert.ok(buildTimeline(p).issues.some(i=>i.code==='group-range'),`${field} ${value}`);assert.throws(()=>validateProject(p),new RegExp(field));
  }
  for(const value of [NaN,Infinity,null,'bad','',false]){
    const p=project();p.audioGroups=[{id:'g',clipIds:['song:ftr','song:byd'],source:'song.wav',sourceStart:40,offsets:{'song:ftr':value}}];
    const plan=buildTimeline(p);assert.ok(plan.issues.some(i=>i.code==='group-offset'));assert.ok(plan.scenes.every(s=>!s.entry||Number.isFinite(s.entry.start)));assert.throws(()=>validateProject(p),/偏移/);
  }
  for(const value of [null,[],42]){
    const p=project();p.audioGroups=[{id:'g',clipIds:['song:ftr','song:byd'],source:'song.wav',sourceStart:40,offsets:value}];
    assert.ok(buildTimeline(p).issues.some(i=>i.code==='group-offset'));assert.throws(()=>validateProject(p),/偏移/);
  }
});

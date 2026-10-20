import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry,ranked,validateProject,buildTimeline,overviewEntries,ensureSequence} from '../shared/core.mjs';
import {sceneTransitions,ffmpegVisualFilters} from '../shared/transitions.mjs';

function fixture(){
  const p=newProject();
  Object.assign(p.settings,{overview:4,segmentGap:0,order:'custom'});
  p.entries=Array.from({length:50},(_,i)=>newEntry({id:'chart-'+i,title:'Chart '+i,constant:10,score:9900000-i,ratingOverride:10+i/100,duration:.5,audioMode:'silent'}));
  const best=ranked(p);
  p.sequence=[best[24],...best.filter(e=>e.id!==best[24].id)].map(e=>({id:'song:'+e.id,type:'song',entryId:e.id}));
  return p;
}

test('legacy projects receive overview defaults and persist explicit order and zero blur',()=>{
  const raw=fixture();delete raw.settings.overviewBlur;delete raw.settings.overviewOrder;
  const migrated=validateProject(raw);
  assert.equal(migrated.settings.overviewBlur,.5);
  assert.equal(migrated.settings.overviewOrder,'descending');
  migrated.settings.overviewBlur=0;migrated.settings.overviewOrder='ascending';
  const restored=validateProject(JSON.parse(JSON.stringify(migrated)));
  assert.equal(restored.settings.overviewBlur,0);assert.equal(restored.settings.overviewOrder,'ascending');
  for(const value of [-1,5.1,null,'',true,'bad']){
    const invalid=fixture();invalid.settings.overviewBlur=value;
    assert.throws(()=>validateProject(invalid),/overviewBlur/);
  }
  const invalid=fixture();invalid.settings.overviewOrder='score';
  assert.throws(()=>validateProject(invalid),/Potential/);
});

test('Potential order controls every overview page while preserving ranks, edits and movie order',()=>{
  const p=fixture();p.excludedEntryIds=[p.entries[0].id];ensureSequence(p);
  const before=JSON.stringify({sequence:p.sequence,entries:p.entries,excluded:p.excludedEntryIds});
  for(const order of ['descending','ascending']){
    p.settings.overviewOrder=order;
    const plan=buildTimeline(p),pages=plan.scenes.filter(s=>s.type==='overview');
    const expected=Array.from({length:50},(_,i)=>order==='descending'?i+1:50-i);
    assert.equal(pages.length,5);assert.deepEqual(plan.issues,[]);
    assert.deepEqual(pages.flatMap(s=>s.entries.map(e=>e.rank)),expected);
    assert.deepEqual(overviewEntries(p).map(e=>e.rank),expected);
    for(const index of [0,2,4]){
      assert.equal(pages[index].page,index+1);
      assert.deepEqual(pages[index].entries.map(e=>e.rank),expected.slice(index*10,index*10+10));
    }
    assert.equal(JSON.stringify({sequence:p.sequence,entries:p.entries,excluded:p.excludedEntryIds}),before);
    assert.equal(pages.reduce((sum,s)=>sum+s.duration,0),20);
  }
});

test('overview page turns use half-second full-frame blur, without black fades or extra duration',()=>{
  for(const fps of [30,60]){
    const p=fixture();p.settings.fps=fps;
    p.settings.sceneTransitions={'overview:1':{mode:'black',duration:.8}};
    const scenes=[{type:'song',clipId:'song:last',duration:4},...Array.from({length:5},(_,i)=>({type:'overview',clipId:'overview:'+(i+1),duration:4,connectedFromPrevious:true}))];
    const effects=sceneTransitions(p,scenes);
    assert.equal(effects[0].fadeOut,.4);assert.equal(effects[1].fadeIn,.4);
    assert.equal(effects[1].blurIn,undefined);assert.equal(effects.at(-1).blurOut,undefined);
    for(let i=2;i<scenes.length;i++){
      assert.equal(effects[i-1].blurOut+effects[i].blurIn,Math.round(.5*fps)/fps);
      assert.equal(effects[i-1].fadeOut,0);assert.equal(effects[i].fadeIn,0);
      assert.ok(ffmpegVisualFilters(effects[i],4).some(s=>s.includes('gblur=')));
    }
    assert.equal(scenes.reduce((sum,s)=>sum+s.duration,0),24);
    p.settings.overviewBlur=0;
    const disabled=sceneTransitions(p,scenes);
    assert.ok(disabled.every(s=>s.blurIn===undefined&&s.blurOut===undefined));
    assert.ok(disabled.slice(2).every(s=>s.fadeIn===0&&s.fadeOut===0));
  }
});

test('short overview pages bound blur to half a page and legacy rendering defaults to 0.5 seconds',()=>{
  const p=fixture();delete p.settings.overviewBlur;
  let scenes=[1,2].map(page=>({type:'overview',clipId:'overview:'+page,duration:4}));
  assert.equal(sceneTransitions(p,scenes)[0].blurOut,.25);
  p.settings.overviewBlur=5;
  scenes=[1,2,3].map(page=>({type:'overview',clipId:'overview:'+page,duration:.1}));
  const effects=sceneTransitions(p,scenes);
  for(const effect of effects)assert.ok((effect.blurIn||0)+(effect.blurOut||0)<=.1);
});

test('the final song and all five overview pages remain one uninterrupted source ending within one frame',()=>{
  const p=fixture(),last=p.entries.find(e=>e.id===p.sequence.at(-1).entryId);
  Object.assign(last,{video:'ending.mp4',audioMode:'video',start:40.261,duration:118.045-40.261});
  p.settings.sceneTransitions={['song:'+last.id]:{mode:'cut',duration:0,audioDuration:0},'overview:1':{mode:'cut',duration:0,audioDuration:0}};
  const plan=buildTimeline(p),track=plan.audio.find(a=>a.file==='ending.mp4');
  assert.deepEqual(plan.issues,[]);assert.equal(plan.audio.length,1);
  assert.equal(track.clipIds.filter(id=>id.startsWith('overview:')).length,5);
  assert.equal(track.fadeIn,0);assert.equal(track.fadeOut,0);
  assert.ok(Math.abs(track.start+track.duration-138.047667)<1/p.settings.fps);
  assert.ok(Math.abs(track.at+track.duration-plan.duration)<1e-7);
  const before=JSON.stringify(plan.audio);
  sceneTransitions(p,plan.scenes);
  assert.equal(JSON.stringify(plan.audio),before,'page blur never edits music timing');
});

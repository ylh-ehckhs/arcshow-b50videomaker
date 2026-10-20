import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry,validateProject,importRecords} from '../shared/core.mjs';
import {getLayout,normalizeLayout} from '../shared/layout.mjs';
import * as impression from '../shared/impression.mjs';
import {checkTimelineMedia} from '../shared/media-check.mjs';
import {buildTimeline} from '../shared/timeline.mjs';

test('character palettes stay distinct while explicit layout colours survive impression changes',()=>{
  for(const theme of ['dusk','dawn']){
    const seen=new Set();
    for(const name of impression.IMPRESSIONS){
      const palette=impression.scenePalette(name,theme);
      assert.ok(Object.values(palette).every(value=>/^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(value)));
      assert.ok(!seen.has(palette.accent),`${theme} ${name} must have its own accent`);seen.add(palette.accent);
    }
    assert.notDeepEqual(impression.scenePalette('tairitsu',theme),impression.scenePalette('sakuya',theme));
  }
  const p=newProject();p.settings.componentLayout=normalizeLayout();
  p.settings.componentLayout.song.title.color='#d9ad78';p.settings.componentLayout.overview.grid.background='#10203080';
  for(const name of impression.IMPRESSIONS){
    p.settings.impression=name;const restored=validateProject(JSON.parse(JSON.stringify(p)));
    assert.equal(restored.settings.impression,name);assert.equal(restored.settings.componentLayout.song.title.color,'#d9ad78');
    assert.equal(restored.settings.componentLayout.overview.grid.background,'#10203080');
    assert.equal(restored.settings.componentLayout.song.rating.color,'');
  }
});

test('impression helpers expose colour palettes without obsolete artwork sources',()=>{
  assert.deepEqual(impression.IMPRESSIONS,['hikari','tairitsu','sakuya','luna']);
  for(const name of impression.IMPRESSIONS)assert.equal(impression.normalizeImpression(name),name);
  assert.equal(impression.normalizeImpression('unknown'),'luna');
  assert.deepEqual(impression.scenePalette('unknown'),impression.scenePalette('luna','dusk'));
  assert.deepEqual(impression.scenePalette('hikari','unknown'),impression.scenePalette('hikari','dusk'));
  const palette=impression.scenePalette('hikari');palette.accent='#000000';
  assert.notEqual(impression.scenePalette('hikari').accent,'#000000');
  for(const key of ['PARTNER_ARTWORKS','artworkUrl','isBundledArtwork'])assert.equal(Object.hasOwn(impression,key),false);
});

test('Potential import column names preserve the existing score override field',()=>{
  for(const key of ['potential','Potential','potentialOverride','单曲Potential','单曲 Potential','rating','ratingOverride','单曲Rating']){
    const [entry]=importRecords(JSON.stringify([{title:'A',score:9900000,constant:10,[key]:12.3456}]));assert.equal(entry.ratingOverride,12.3456,key);
  }
});

test('legacy intro and artwork are removed on load without replacing retained layout or reading obsolete files',async()=>{
  const p=newProject();p.format='arc-reel';p.version=1;
  p.entries=[newEntry({title:'A',score:9900000,constant:10,clear:'NC',audioMode:'silent',duration:2})];
  const custom=normalizeLayout();custom.song.title.x=150;custom.song.title.color='#abc123';custom.overview.grid.fontSize=36;
  custom.intro={artwork:{x:1100,y:100,w:700,h:850,visible:true},title:{visible:true}};
  Object.assign(p.settings,{intro:999,introArtwork:'missing-legacy-art.png',impression:'sakuya',overview:0,componentLayout:custom});
  p.sequence=[{id:'intro',type:'intro'},{id:'song:'+p.entries[0].id,type:'song',entryId:p.entries[0].id}];
  const before=structuredClone(p),restored=validateProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(p,before);assert.equal(Object.hasOwn(restored.settings,'intro'),false);
  assert.equal(Object.hasOwn(restored.settings,'introArtwork'),false);assert.equal(restored.settings.componentLayout.intro,undefined);
  assert.equal(restored.settings.impression,'sakuya');
  assert.equal(getLayout(restored).song.title.x,150);assert.equal(getLayout(restored).song.title.color,'#abc123');
  assert.equal(getLayout(restored).overview.grid.fontSize,36);
  assert.ok(restored.sequence.every(clip=>clip.type!=='intro'));
  const plan=buildTimeline(restored);assert.deepEqual(plan.scenes.map(scene=>scene.type),['song']);assert.equal(plan.duration,2);
  for(const project of [p,restored]){
    const calls=[];const result=await checkTimelineMedia(project,async file=>{calls.push(file);throw new Error('obsolete artwork must never be probed');});
    assert.deepEqual(calls,[]);assert.equal(result.files,0);assert.deepEqual(result.issues,[]);
  }
  const fresh=newProject();assert.equal(Object.hasOwn(fresh.settings,'intro'),false);assert.equal(Object.hasOwn(fresh.settings,'introArtwork'),false);
});

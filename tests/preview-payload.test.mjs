import test from 'node:test';
import assert from 'node:assert/strict';
import {previewPayload} from '../renderer/preview-payload.mjs';

test('preview transfer keeps presentation and visible score but excludes OCR and unused project tracks',()=>{
  const entry={id:'a',title:'Testify',score:9900000,video:'local.mp4',background:'local.jpg',rank:1,rating:12,sourceThumbnail:'large OCR image',ocrRaw:'raw OCR',titleOptions:['other'],warnings:['review']};
  const project={name:'Saved project',player:'Player',date:'2026-10-19',settings:{theme:'dawn',componentLayout:{song:{}}},entries:[entry],sequence:[{entryId:'a'}],audioGroups:[{source:'music.wav'}],excludedEntryIds:[]};
  const input=structuredClone(project);
  const payload=previewPayload(project,{type:'song',clipId:'song:a',entry,previewSeconds:.02},{playing:true});
  assert.equal(payload.playing,true);assert.deepEqual(payload.project.settings,project.settings);assert.equal(payload.project.player,'Player');
  for(const key of ['entries','sequence','audioGroups','excludedEntryIds'])assert.equal(key in payload.project,false);
  for(const key of ['sourceThumbnail','ocrRaw','titleOptions','warnings'])assert.equal(key in payload.scene.entry,false);
  assert.equal(payload.scene.entry.video,'local.mp4');assert.equal(payload.scene.entry.background,'local.jpg');assert.equal(payload.scene.entry.score,9900000);assert.equal(payload.scene.entry.rating,12);assert.equal(payload.scene.previewSeconds,.02);
  assert.deepEqual(project,input,'preview messages must not remove review data from the editable project');
});

test('overview transfers exactly its visible page and keeps the original entries intact',()=>{
  const entries=Array.from({length:10},(_,i)=>({title:'Song '+i,rank:i+1,sourceThumbnail:'large',ocrRaw:'raw'}));
  const scene={type:'overview',clipId:'overview:1',page:1,pages:5,entries};
  const payload=previewPayload({name:'Overview',settings:{},entries},scene);
  assert.equal(payload.scene.entries.length,10);assert.equal(payload.scene.entries[9].rank,10);assert.equal('sourceThumbnail' in payload.scene.entries[0],false);
  assert.equal(entries[0].sourceThumbnail,'large');assert.equal(scene.entries,entries);
});

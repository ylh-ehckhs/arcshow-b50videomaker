import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateProject,buildTimeline,issues} from '../shared/core.mjs';
import media from '../main/project-media.cjs';

const folder=new URL('../examples/full-b50-tutorial/',import.meta.url);
const raw=fs.readFileSync(new URL('example.arcshow',folder),'utf8');
const manifest=JSON.parse(fs.readFileSync(new URL('assets-required.json',folder),'utf8'));

test('public example keeps the final complete timeline without OCR images, personal paths or hidden missing references',()=>{
  const project=validateProject(JSON.parse(raw)),timeline=buildTimeline(project);
  assert.equal(project.entries.length,50);
  assert.equal(project.sequence.filter(c=>c.type==='animation').length,6);
  assert.equal(timeline.scenes.filter(s=>s.type==='overview').length,5);
  assert.equal(timeline.scenes.filter(s=>s.type==='gap').length,46);
  assert.ok(Math.abs(timeline.duration-1433.8666666666666)<1e-8);
  assert.deepEqual(timeline.issues,[]);
  assert.deepEqual(project.entries.flatMap(e=>issues(e,project)),[]);
  assert.doesNotMatch(raw,/sourceThumbnail|ocrRaw|data:image|[A-Za-z]:[\\/]|AppData|FileRecv/);
  assert.equal(project.player,'示例玩家');assert.equal(project.potential,'');
  const used=new Set();
  media.visitMedia(project,file=>{assert.match(file,/^assets\/(?:gameplay|unlocks|backgrounds|audio|images)\//);assert.ok(!file.includes('..'));used.add(file);return file;});
  assert.equal(used.size,64);assert.deepEqual([...used].sort(),manifest.map(m=>m.file).sort());
  for(const track of timeline.audio){
    const asset=manifest.find(m=>m.file===track.file);
    assert.ok(asset.minimumDuration+1e-6>=track.start+track.duration,track.file);
  }
});

test('public tutorial retains original audio direct cuts, final chart ranges and five-page music continuation',()=>{
  const project=validateProject(JSON.parse(raw)),timeline=buildTimeline(project);
  assert.deepEqual(project.audioGroups,[]);
  for(const c of project.sequence.filter(c=>c.type==='animation'))assert.equal(c.audioMode,'own');
  const testify=project.entries.find(e=>e.title==='Testify'&&e.difficulty==='BYD');
  assert.equal(testify.start,122.097);
  const transition=project.settings.sceneTransitions['song:'+testify.id];
  assert.equal(transition.mode,'cut');assert.equal(transition.audioDuration,0);
  const last=timeline.audio.at(-1);
  assert.equal(last.clipIds.filter(id=>id.startsWith('overview:')).length,5);
  assert.ok(Math.abs(last.at+last.duration-timeline.duration)<1e-8);
});

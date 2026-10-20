import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry} from '../shared/core.mjs';
import {checkTimelineMedia} from '../shared/media-check.mjs';
import {getLayout,makeImage} from '../shared/layout.mjs';
function project(){const p=newProject();Object.assign(p.settings,{intro:0,overview:0,audioTransition:0});p.entries=[newEntry({id:'a',title:'A',constant:10,score:9900000,clear:'NC',video:'a.mp4',audio:'music.wav',start:2,audioStart:4,duration:5})];p.sequence=[{id:'song:a',type:'song',entryId:'a'}];return p;}
const av={video:true,audio:true,duration:100,videoDuration:100,audioDuration:100,videoStart:0,audioStart:0};
test('preflight checks unique actual media with at most two concurrent probes and does not mutate the project',async()=>{
  const p=project();p.settings.background='unused.png';p.entries[0].background='custom.png';p.entries[0].jacket='jacket.png';const layout=getLayout(p);layout.images.song=[makeImage('cover','本曲图片',{source:'jacket'})];p.settings.componentLayout=layout;p.sequence.unshift({id:'animation',type:'animation',file:'unlock.mp4',start:0,duration:2,audioMode:'own',originalVolume:1,effectFile:'effect.wav'});
  const before=JSON.stringify(p),calls=[];let active=0,maximum=0;const result=await checkTimelineMedia(p,async file=>{calls.push(file);active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,5));active--;return av;});
  assert.deepEqual(result.issues,[]);assert.equal(result.files,6);assert.equal(calls.length,new Set(calls).size);assert.equal(calls.includes('unused.png'),false);assert.equal(maximum,2);assert.equal(JSON.stringify(p),before);
});
test('video and audio limits are checked independently instead of using the container duration',async()=>{
  const p=project(),result=await checkTimelineMedia(p,async file=>file==='a.mp4'?{...av,videoDuration:6,audioDuration:100}:{...av,audioDuration:7});
  assert.equal(result.issues.length,2);assert.match(result.issues.find(i=>i.code==='video-short').message,/缺少 1\.000 秒/);assert.match(result.issues.find(i=>i.code==='audio-short').message,/缺少 2\.000 秒/);
});
test('stream start delays identify the exact missing leading duration',async()=>{
  const result=await checkTimelineMedia(project(),async file=>file==='a.mp4'?{...av,videoStart:3.5}:{...av,audioStart:6});
  assert.match(result.issues.find(i=>i.code==='video-delayed').message,/缺少 1\.500 秒/);assert.match(result.issues.find(i=>i.code==='audio-delayed').message,/缺少 2\.000 秒/);
});
test('unreadable files, missing streams and invalid images report actionable issues',async()=>{
  const p=project();p.settings.background='bad.png';p.entries[0].jacket='bad.png';const result=await checkTimelineMedia(p,async file=>{if(file==='a.mp4')throw new Error('文件不存在');if(file==='music.wav')return{...av,audio:false};return{...av,video:false};});
  assert.equal(result.files,3);assert.equal(result.issues.filter(i=>i.code==='media-unreadable').length,1);assert.ok(result.issues.some(i=>i.code==='audio-missing'));assert.equal(result.issues.filter(i=>i.code==='image-invalid').length,1);
});
test('images need a decodable frame but no timed duration; a zero stream duration stays invalid',async()=>{
  const p=project();p.settings.background='image.png';const result=await checkTimelineMedia(p,async file=>file==='image.png'?{video:true,duration:0,videoDuration:0}:file==='music.wav'?{...av,audioDuration:0}:av);
  assert.equal(result.issues.length,1);assert.equal(result.issues[0].code,'audio-duration');
});
test('legacy looping BGM only requires an audio stream, while ordinary negative starts remain errors',async()=>{
  const p=project();p.entries[0].audio='';p.entries[0].video='';p.settings.globalBgm='legacy.wav';const result=await checkTimelineMedia(p,async()=>({audio:true,duration:0,audioDuration:0}));assert.deepEqual(result.issues,[]);
  const q=project();q.entries[0].audioStart=-2;const bad=await checkTimelineMedia(q,async()=>av);assert.equal(bad.issues.filter(i=>i.code==='audio-start').length,1);assert.ok(bad.issues.some(i=>i.message.includes('2.000')));
});
test('single-clip preflight checks only the selected media and its clipped common audio range',async()=>{
  const p=project();p.entries.push(newEntry({id:'b',title:'B',constant:11,score:9900000,clear:'NC',video:'b.mp4',start:0,duration:5}));p.sequence.push({id:'song:b',type:'song',entryId:'b'});p.audioGroups=[{id:'g',clipIds:['song:a','song:b'],source:'music.wav',sourceStart:4,offsets:{'song:a':-2,'song:b':-9},volume:1}];
  const calls=[],result=await checkTimelineMedia(p,async file=>{calls.push(file);return av;},{singleId:'b'});assert.deepEqual(result.issues,[]);assert.equal(result.files,2);assert.deepEqual(calls.sort(),['b.mp4','music.wav']);
});

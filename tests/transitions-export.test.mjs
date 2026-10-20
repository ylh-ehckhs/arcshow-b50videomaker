import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {newProject,newEntry} from '../shared/core.mjs';
import exporter from '../main/exporter.cjs';

const root=fileURLToPath(new URL('../',import.meta.url)),directory=path.join(root,'verification','transitions');
function ffmpeg(args){
  const result=spawnSync(exporter.binary('ffmpeg'),['-hide_banner','-loglevel','error',...args],{windowsHide:true,maxBuffer:8*1024*1024});
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stderr?.toString());return result.stdout;
}
function pixels(file,frames){
  const select=frames.map(n=>`eq(n\\,${n})`).join('+');
  const data=ffmpeg(['-i',file,'-vf',`select=${select},scale=1:1:flags=area`,'-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','-']);
  assert.equal(data.length,frames.length*3);
  return frames.map((frame,index)=>({frame,r:data[index*3],g:data[index*3+1],b:data[index*3+2]}));
}

test('real export fades every visual layer and animations to black, supports direct cuts and preserves uninterrupted audio',{skip:!existsSync(exporter.binary('ffmpeg')),timeout:120000},async()=>{
  await fs.mkdir(directory,{recursive:true});
  const background=path.join(directory,'blue.png'),animation=path.join(directory,'red.mp4'),audio=path.join(directory,'continuous.wav'),output=path.join(directory,'black-and-cut.mp4');
  ffmpeg(['-y','-f','lavfi','-i','color=c=blue:s=1280x720:r=30:d=0.1','-frames:v','1','-threads','1',background]);
  ffmpeg(['-y','-f','lavfi','-i','color=c=red:s=320x180:r=30:d=2','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',animation]);
  ffmpeg(['-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-c:a','pcm_s16le',audio]);
  const p=newProject();Object.assign(p.settings,{intro:0,overview:0,width:1280,fps:30,encoder:'software',transition:.4,audioTransition:0,sceneTransitions:{'animation:x':{mode:'black',duration:.8},'song:b':{mode:'cut',duration:0}}});
  p.entries=[newEntry({id:'a',title:'Blue A',constant:10,score:9900000,duration:1,audio,audioStart:0}),newEntry({id:'b',title:'Blue B',constant:11,score:9900000,duration:1,audio,audioStart:2})];
  p.sequence=[{id:'song:a',type:'song',entryId:'a'},{id:'animation:x',type:'animation',file:animation,start:0,duration:1,audioMode:'next',originalVolume:0},{id:'song:b',type:'song',entryId:'b'}];
  p.audioGroups=[{id:'continuous',clipIds:p.sequence.map(c=>c.id),source:audio,sourceStart:0,offsets:{},volume:1}];
  await fs.writeFile(path.join(directory,'fixture.arcshow'),JSON.stringify(p,null,2));
  const png=await fs.readFile(background),render=async()=>png;
  const result=await exporter.exportMovie({project:p,output,render});
  assert.equal(result.segments,3);assert.equal(result.audioTracks,1);assert.equal(result.duration,3);
  const samples=pixels(output,[0,24,30,36,42,59,60,89]);
  const byFrame=new Map(samples.map(s=>[s.frame,s]));
  assert.ok(byFrame.get(0).b>220,'the first movie frame has no outer fade');
  assert.ok(byFrame.get(24).b>80&&byFrame.get(24).b<180,'the complete outgoing frame fades to black');
  assert.ok(Math.max(byFrame.get(30).r,byFrame.get(30).g,byFrame.get(30).b)<8,'the incoming animation starts at black');
  assert.ok(byFrame.get(36).r>80&&byFrame.get(36).r<180,'the animation fades up from black');
  assert.ok(byFrame.get(42).r>220&&byFrame.get(59).r>220,'the animation reaches full brightness and has no fade at the direct cut');
  assert.ok(byFrame.get(60).b>220&&byFrame.get(89).b>220,'zero seconds cuts straight to the next scene, with no final film fade');
  const sound=ffmpeg(['-i',output,'-vn','-ac','1','-ar','48000','-f','f32le','-']);
  const jointRms=[1,2].map(seconds=>{
    const left=Math.round((seconds-.02)*48000),right=Math.round((seconds+.02)*48000);let sum=0;
    for(let sample=left;sample<right;sample++){const value=sound.readFloatLE(sample*4);sum+=value*value;}
    return Math.sqrt(sum/(right-left));
  });
  assert.ok(jointRms.every(rms=>rms>.04),'visual transitions never silence or restart common audio');
  const singleOutput=path.join(directory,'animation-single.mp4');
  const single=await exporter.exportMovie({project:p,output:singleOutput,singleId:'animation:x',render});
  const singleSamples=pixels(singleOutput,[0,12,29]);
  assert.equal(single.duration,1);assert.equal(single.segments,1);
  assert.ok(Math.max(singleSamples[0].r,singleSamples[0].g,singleSamples[0].b)<8,'selected-clip export keeps the full-film incoming transition');
  assert.ok(singleSamples[1].r>220&&singleSamples[2].r>220);
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({result,samples,jointRms,single,singleSamples},null,2));
});

test('exported overview page turns blur the frame for 0.5 seconds while source audio and page durations stay continuous',{skip:!existsSync(exporter.binary('ffmpeg')),timeout:120000},async()=>{
  const dir=path.join(root,'verification','overview-export');await fs.mkdir(dir,{recursive:true});
  const grid=path.join(dir,'grid.png'),audio=path.join(dir,'continuous.wav'),output=path.join(dir,'overview-turn.mp4');
  ffmpeg(['-y','-f','lavfi','-i','color=c=white:s=1280x720:r=30:d=0.1,drawgrid=w=16:h=16:t=2:c=black','-frames:v','1','-threads','1',grid]);
  ffmpeg(['-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-c:a','pcm_s16le',audio]);
  const p=newProject();Object.assign(p.settings,{overview:1,overviewBlur:.5,overviewOrder:'ascending',width:1280,fps:30,encoder:'software',segmentGap:0,transition:1,audioTransition:0,normalizeAudio:false,volume:1});
  p.entries=Array.from({length:11},(_,i)=>newEntry({id:'overview-export-'+i,title:'Score '+i,constant:10,score:9900000,ratingOverride:10+i/100,duration:.5,audioMode:'silent'}));
  Object.assign(p.entries[0],{audio,audioStart:0,audioMode:'audio'});
  p.excludedEntryIds=p.entries.slice(1).map(e=>e.id);
  p.settings.sceneTransitions={'overview:1':{mode:'cut',duration:0,audioDuration:0}};
  const png=await fs.readFile(grid),pages=[];
  const result=await exporter.exportMovie({project:p,output,render:async({scene})=>{if(scene.type==='overview')pages.push(scene.entries.map(e=>e.rank));return png;}});
  assert.equal(result.duration,2.5);assert.equal(result.segments,3);assert.equal(result.audioTracks,1);
  assert.deepEqual(pages,[[11,10,9,8,7,6,5,4,3,2],[1]]);
  const frames=[30,44,45,60],selected=frames.map(n=>`eq(n\\,${n})`).join('+');
  const raw=ffmpeg(['-i',output,'-vf',`select=${selected},scale=320:180:flags=area`,'-fps_mode','passthrough','-pix_fmt','gray','-f','rawvideo','-']);
  assert.equal(raw.length,frames.length*320*180);
  const measures=frames.map((frame,index)=>{
    const data=raw.subarray(index*320*180,(index+1)*320*180);let edge=0,mean=0,count=0;
    for(let y=0;y<180;y++)for(let x=0;x<320;x++){const i=y*320+x;mean+=data[i];if(x){edge+=Math.abs(data[i]-data[i-1]);count++;}if(y){edge+=Math.abs(data[i]-data[i-320]);count++;}}
    return {frame,edge:edge/count,mean:mean/data.length};
  });
  assert.ok(measures[1].edge<measures[0].edge*.6,'outgoing overview page becomes blurred');
  assert.ok(measures[2].edge<measures[3].edge*.6,'incoming overview page begins blurred');
  assert.ok(measures.every(s=>s.mean>100),'page turns do not insert black frames');
  const sound=ffmpeg(['-i',output,'-vn','-ac','1','-ar','48000','-f','f32le','-']);
  const joins=[.5,1.5].map(time=>{let energy=0;const from=Math.round((time-.02)*48000),to=Math.round((time+.02)*48000);for(let i=from;i<to;i++)energy+=sound.readFloatLE(i*4)**2;return Math.sqrt(energy/(to-from));});
  assert.ok(joins.every(rms=>rms>.06),'music continues through the first overview and subsequent page turn');
  await fs.writeFile(path.join(dir,'report.json'),JSON.stringify({result,pages,measures,joins},null,2));
});

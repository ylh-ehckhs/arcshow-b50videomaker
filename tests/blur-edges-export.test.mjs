import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {newProject,newEntry} from '../shared/core.mjs';
import exporter from '../main/exporter.cjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.join(root,'verification','blur-edges-export');
const width=1280,height=720,fps=30;
function ffmpeg(args){
  const result=spawnSync(exporter.binary('ffmpeg'),['-hide_banner','-loglevel','error',...args],{windowsHide:true,maxBuffer:64*1024*1024});
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stderr?.toString());
  return result.stdout;
}
function measure(data){
  // A wide white rim separates real texture blur from unwanted dark/transparent
  // sampling outside the canvas. Inspect every boundary pixel, not a frame mean.
  const edges={top:255,bottom:255,left:255,right:255};
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    if(y>=4&&y<height-4&&x>=4&&x<width-4)continue;
    const offset=(y*width+x)*3,value=Math.min(data[offset],data[offset+1],data[offset+2]);
    if(y<4)edges.top=Math.min(edges.top,value);
    if(y>=height-4)edges.bottom=Math.min(edges.bottom,value);
    if(x<4)edges.left=Math.min(edges.left,value);
    if(x>=width-4)edges.right=Math.min(edges.right,value);
  }
  let variation=0,count=0;
  for(let y=96;y<height-96;y+=2)for(let x=96;x<width-96;x+=2){
    const offset=(y*width+x)*3;
    variation+=Math.abs(data[offset]-data[offset-3])+Math.abs(data[offset]-data[offset-width*3]);count+=2;
  }
  const corners=[[0,0],[width-1,0],[0,height-1],[width-1,height-1]].map(([x,y])=>[...data.subarray((y*width+x)*3,(y*width+x)*3+3)]);
  return {edges,corners,textureVariation:variation/count};
}

test('real blur exports preserve all frame edges at animation, song and overview joins without changing timing or audio',{skip:!existsSync(exporter.binary('ffmpeg')),timeout:120000},async()=>{
  await fs.mkdir(directory,{recursive:true});
  const picture=path.join(directory,'white-rim-grid.png'),animation=path.join(directory,'animation.mp4');
  const audio=path.join(directory,'continuous.wav'),output=path.join(directory,'blur-edges.mp4');
  ffmpeg(['-y','-f','lavfi','-i',`color=c=white:s=${width}x${height}:r=${fps}:d=0.1,drawgrid=w=16:h=16:t=2:c=black,drawbox=x=0:y=0:w=iw:h=ih:c=white:t=64`,'-frames:v','1','-threads','1',picture]);
  ffmpeg(['-y','-loop','1','-i',picture,'-t','0.5','-r',String(fps),'-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',animation]);
  ffmpeg(['-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-c:a','pcm_s16le',audio]);
  const project=newProject();
  Object.assign(project.settings,{overview:.5,overviewBlur:.5,cutBlur:.3,width,fps,encoder:'software',segmentGap:0,transition:0,audioTransition:0,normalizeAudio:false,volume:1});
  project.entries=Array.from({length:11},(_,i)=>newEntry({id:`blur-edge-${i}`,title:`Edge ${i}`,constant:10,score:9900000,duration:.5,audioMode:'silent'}));
  project.excludedEntryIds=project.entries.slice(3).map(entry=>entry.id);
  project.sequence=[
    {id:'song:blur-edge-0',type:'song',entryId:'blur-edge-0'},
    {id:'animation:blur-edge',type:'animation',file:animation,start:0,duration:.5,audioMode:'silent',originalVolume:0},
    {id:'song:blur-edge-1',type:'song',entryId:'blur-edge-1'},
    {id:'song:blur-edge-2',type:'song',entryId:'blur-edge-2'}
  ];
  project.audioGroups=[{id:'blur-edge-continuous',clipIds:project.sequence.map(clip=>clip.id),source:audio,sourceStart:0,offsets:{},volume:1}];
  const png=await fs.readFile(picture);
  const result=await exporter.exportMovie({project,output,render:async()=>png});
  assert.equal(result.duration,3,'blur does not add or subtract film time');
  assert.equal(result.segments,6);
  assert.equal(result.audioTracks,1,'the common audio source remains one uninterrupted track');
  const media=await exporter.probe(output);
  assert.equal(media.width,width);assert.equal(media.height,height);
  assert.equal(media.videoFrames,90,'all six half-second scenes preserve their exact frames');
  assert.ok(Math.abs(media.videoDuration-3)<1/fps);
  const frameNumbers=[0,29,30,37,44,45,52,60,67,74,75,84,89];
  const select=frameNumbers.map(frame=>`eq(n\\,${frame})`).join('+');
  const raw=ffmpeg(['-i',output,'-vf',`select=${select}`,'-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','-']);
  const bytes=width*height*3;
  assert.equal(raw.length,frameNumbers.length*bytes);
  const samples=frameNumbers.map((frame,index)=>({frame,...measure(raw.subarray(index*bytes,(index+1)*bytes))}));
  for(const sample of samples){
    for(const [edge,minimum] of Object.entries(sample.edges))assert.ok(minimum>=245,`frame ${sample.frame} ${edge} darkened to ${minimum}`);
    for(const [index,pixel] of sample.corners.entries())assert.ok(pixel.every(channel=>channel>=245),`frame ${sample.frame} corner ${index} darkened: ${pixel}`);
  }
  const byFrame=new Map(samples.map(sample=>[sample.frame,sample]));
  for(const [blurred,sharp,label] of [[30,37,'animation to song'],[45,52,'song to song'],[75,84,'overview page turn']]){
    assert.ok(byFrame.get(blurred).textureVariation<byFrame.get(sharp).textureVariation*.65,`${label} is actually blurred at its maximum, rather than disabling the effect`);
  }
  const sound=ffmpeg(['-i',output,'-vn','-ac','1','-ar','48000','-f','f32le','-']);
  assert.ok(sound.length/4/48000>=2.99,'audio covers the whole film');
  const joins=[.5,1,1.5,2,2.5].map(time=>{
    const from=Math.round((time-.02)*48000),to=Math.round((time+.02)*48000);let energy=0;
    for(let sample=from;sample<to;sample++)energy+=sound.readFloatLE(sample*4)**2;
    return {time,rms:Math.sqrt(energy/(to-from))};
  });
  assert.ok(joins.every(join=>join.rms>.055),'picture transitions do not insert audio gaps or fades');
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({result,media,samples,joins},null,2));
});

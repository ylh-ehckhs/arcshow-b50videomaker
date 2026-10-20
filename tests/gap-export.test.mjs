import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {newProject,newEntry,buildTimeline} from '../shared/core.mjs';
import exporter from '../main/exporter.cjs';

const root=fileURLToPath(new URL('../',import.meta.url)),directory=path.join(root,'verification','gap-transitions');
function ffmpeg(args){
  const result=spawnSync(exporter.binary('ffmpeg'),['-hide_banner','-loglevel','error',...args],{windowsHide:true,maxBuffer:8*1024*1024});
  if(result.error)throw result.error;assert.equal(result.status,0,result.stderr?.toString());return result.stdout;
}
function frame(file,number){
  const data=ffmpeg(['-i',file,'-vf',`select=eq(n\\,${number}),scale=1:1:flags=area`,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-']);
  assert.equal(data.length,3);return [...data];
}
function rms(sound,at,radius=.04){
  const left=Math.round((at-radius)*48000),right=Math.round((at+radius)*48000);let sum=0;
  for(let sample=left;sample<right;sample++){const value=sound.readFloatLE(sample*4);sum+=value*value;}
  return Math.sqrt(sum/(right-left));
}

test('real export inserts an exact silent black gap, keeps source-zero fades valid and excludes the gap in a single-song export',{skip:!existsSync(exporter.binary('ffmpeg')),timeout:120000},async()=>{
  await fs.mkdir(directory,{recursive:true});
  const blue=path.join(directory,'blue.png'),red=path.join(directory,'red.png'),audioA=path.join(directory,'a.wav'),audioB=path.join(directory,'b.wav'),output=path.join(directory,'black-gap.mp4');
  ffmpeg(['-y','-f','lavfi','-i','color=c=blue:s=1280x720:r=30:d=0.1','-frames:v','1','-threads','1',blue]);
  ffmpeg(['-y','-f','lavfi','-i','color=c=red:s=1280x720:r=30:d=0.1','-frames:v','1','-threads','1',red]);
  for(const [file,frequency]of [[audioA,440],[audioB,660]])ffmpeg(['-y','-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=48000:duration=1`,'-c:a','pcm_s16le',file]);
  const p=newProject();Object.assign(p.settings,{overview:0,width:1280,fps:30,encoder:'software',segmentGap:1,transition:.4,audioTransition:.2});
  p.entries=[newEntry({id:'a',title:'Blue',constant:10,score:9900000,duration:1,audio:audioA,audioStart:0}),newEntry({id:'b',title:'Red',constant:11,score:9900000,duration:1,audio:audioB,audioStart:0})];
  p.sequence=p.entries.map(e=>({id:'song:'+e.id,type:'song',entryId:e.id}));
  const plan=buildTimeline(p);assert.deepEqual(plan.issues,[]);assert.equal(plan.duration,3);
  const colors={a:await fs.readFile(blue),b:await fs.readFile(red)},rendered=[];
  const render=async({scene})=>{rendered.push(scene.clipId);assert.notEqual(scene.type,'gap','gap exports must not render score chrome');return colors[scene.entry.id];};
  const result=await exporter.exportMovie({project:p,output,render});
  assert.equal(result.segments,3);assert.equal(result.duration,3);assert.equal(rendered.length,2);
  const samples=Object.fromEntries([0,24,30,45,59,60,63,69,89].map(n=>[n,frame(output,n)]));
  assert.ok(samples[0][2]>220);assert.ok(samples[24][2]>220,'full brightness until outgoing fade starts');
  for(const n of [30,45,59,60])assert.ok(Math.max(...samples[n])<8,`frame ${n} should be black`);
  assert.ok(samples[63][0]>80&&samples[63][0]<180,'incoming scene fades up after silence');
  assert.ok(samples[69][0]>220&&samples[89][0]>220);
  const sound=ffmpeg(['-i',output,'-vn','-ac','1','-ar','48000','-f','f32le','-']);
  const levels={first:rms(sound,.5),gap:rms(sound,1.5),second:rms(sound,2.5),outgoing:rms(sound,.95,.01),incoming:rms(sound,2.05,.01)};
  assert.ok(levels.first>.04&&levels.second>.04);assert.ok(levels.gap<.00001,'the entire gap is intentionally silent');
  assert.ok(levels.outgoing<levels.first*.7&&levels.incoming<levels.second*.7,'each source fades within its existing trim');
  const singleOutput=path.join(directory,'single-red.mp4');
  const single=await exporter.exportMovie({project:p,output:singleOutput,singleId:'song:b',render});
  assert.equal(single.segments,1);assert.equal(single.duration,1);assert.ok(frame(singleOutput,9)[0]>220);
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({result,samples,levels,single},null,2));
});

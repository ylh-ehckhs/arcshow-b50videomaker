import {existsSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {newProject,newEntry,buildTimeline} from '../shared/core.mjs';
import exporter from '../main/exporter.cjs';
import loudness from '../main/loudness.cjs';

const folder=fileURLToPath(new URL('../.work/export-check/',import.meta.url));
function ffmpeg(args){const result=spawnSync(exporter.binary('ffmpeg'),['-hide_banner','-loglevel','error',...args],{windowsHide:true,maxBuffer:12*1024*1024});assert.equal(result.status,0,result.stderr?.toString());return result.stdout;}

test('short real export equalizes source volume, retains global gain, blurs direct cuts and adds no frames',{skip:!existsSync(exporter.binary('ffmpeg')),timeout:60000},async()=>{
  await fs.mkdir(folder,{recursive:true});
  const image=path.join(folder,'stripes.png'),files=[path.join(folder,'loud.wav'),path.join(folder,'quiet.wav')],output=path.join(folder,'check.mp4');
  ffmpeg(['-y','-f','lavfi','-i',"nullsrc=s=1280x720,geq=lum='if(lt(mod(X,24),12),235,16)':cb=128:cr=128",'-frames:v','1','-threads','1',image]);
  for(const [i,file]of files.entries())ffmpeg(['-y','-f','lavfi','-i',`aevalsrc=${i?.04:.4}*sin(2*PI*440*t)|${i?.04:.4}*sin(2*PI*440*t):s=48000:d=4`,'-c:a','pcm_s16le',file]);
  ffmpeg(['-y','-f','lavfi','-i','aevalsrc=0.04*sin(2*PI*440*t):s=48000:d=4','-c:a','pcm_s16le',path.join(folder,'mono.wav')]);
  const p=newProject();Object.assign(p.settings,{overview:0,width:1280,fps:30,encoder:'software',segmentGap:0,audioTransition:0,volume:.5,sceneTransitions:{'song:b':{mode:'cut',duration:0}}});
  p.entries=files.map((audio,i)=>newEntry({id:i?'b':'a',title:i?'Quiet recording':'Loud recording',difficulty:i?'BYD':'FTR',constant:10+i,score:9900000,audio,duration:3}));
  p.sequence=p.entries.map(e=>({id:'song:'+e.id,type:'song',entryId:e.id}));
  const png=await fs.readFile(image),result=await exporter.exportMovie({project:p,output,render:async()=>png});
  const meta=await exporter.probe(output);assert.equal(result.duration,6);assert.equal(meta.videoFrames,180);assert.equal(result.segments,2);
  const raw=ffmpeg(['-i',output,'-vn','-ac','2','-ar','48000','-f','f32le','-']);
  const rms=at=>{let sum=0;for(let i=at*48000;i<(at+1)*48000;i++){const v=raw.readFloatLE(i*8);sum+=v*v;}return Math.sqrt(sum/48000);};
  const sound=[rms(1),rms(4)],dbDifference=20*Math.log10(sound[0]/sound[1]);assert.ok(Math.abs(dbDifference)<.2,`difference ${dbDifference} dB`);
  const measured=await loudness.analyze(buildTimeline(p).audio[0]),expected=.4/Math.SQRT2*measured.gain*.5;
  assert.ok(Math.abs(20*Math.log10(sound[0]/expected))<.3,'global 0.5 volume applies after normalization');
  const frameNumbers=[30,89,90,96],picture=ffmpeg(['-i',output,'-vf',`select='${frameNumbers.map(n=>`eq(n,${n})`).join('+')}',scale=128:72`,'-fps_mode','passthrough','-pix_fmt','gray','-f','rawvideo','-']);
  const pixels=128*72,variances=frameNumbers.map((_,index)=>{const bytes=picture.subarray(index*pixels,(index+1)*pixels),mean=bytes.reduce((a,b)=>a+b,0)/pixels;return bytes.reduce((a,b)=>a+(b-mean)**2,0)/pixels;});
  assert.equal(picture.length,pixels*4);assert.ok(variances[1]<variances[0]*.7);assert.ok(variances[2]<variances[0]*.3);assert.ok(variances[3]>variances[0]*.9);
  await fs.writeFile(path.join(folder,'report.json'),JSON.stringify({result,videoFrames:meta.videoFrames,soundRms:sound,dbDifference,measured,expected,frameNumbers,variances},null,2));
});

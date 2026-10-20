/* Offline audio inspection. source = common/master audio; target = recording.
 * offset = targetTime - sourceTime, so recordingTime = musicTime + offset.
 * CPU analysis runs in alignment-worker.cjs. Nothing is uploaded or persisted.
 */
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {Worker}=require('node:worker_threads');
const SAMPLE_RATE=4000,MAX_SECONDS=1800,MAX_BYTES=MAX_SECONDS*SAMPLE_RATE*4+65536;
const root=path.join(__dirname,'..');
const binary=name=>path.join(root,'resources','bin',name+(process.platform==='win32'?'.exe':''));
const decoded=new Map(),results=new Map();let cacheBytes=0;
function aborted(){const e=new Error('已取消音频分析');e.name='AbortError';return e;}
function check(signal){if(signal?.aborted)throw aborted();}
function remember(map,key,value,limit=32){map.delete(key);map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value);return value;}
function exec(tool,args,{signal,maxBytes=1048576}={}){
  check(signal);
  return new Promise((resolve,reject)=>{
    const child=spawn(binary(tool),args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let chunks=[],bytes=0,stderr='',failed;
    const cancel=()=>child.kill();signal?.addEventListener('abort',cancel,{once:true});
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){failed=new Error('音频分析输出超过安全上限');child.kill();}else chunks.push(chunk);});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8000);});
    child.on('error',error=>{failed=error;});
    child.on('close',code=>{signal?.removeEventListener('abort',cancel);if(signal?.aborted)reject(aborted());else if(failed)reject(failed);else if(code!==0)reject(new Error(`${tool} 无法读取音轨 (${code})：${stderr.trim()}`));else resolve(Buffer.concat(chunks,bytes));});
  });
}
async function identity(file,signal){
  check(signal);if(typeof file!=='string'||!file.trim())throw new Error('请选择本地音频或录像文件');
  const absolute=path.resolve(file),stat=await fs.stat(absolute);check(signal);
  if(!stat.isFile())throw new Error('音频素材不是普通文件');
  return {file:absolute,key:`${absolute}\0${stat.size}\0${stat.mtimeMs}`};
}
async function readAudio(id,{signal,onProgress}={}){
  check(signal);if(decoded.has(id.key)){const v=decoded.get(id.key);decoded.delete(id.key);decoded.set(id.key,v);return v;}
  onProgress?.({stage:'读取音轨信息',file:id.file});
  const info=JSON.parse((await exec('ffprobe',['-v','error','-show_entries','stream=codec_type,duration:format=duration','-of','json',id.file],{signal})).toString());
  const stream=info.streams?.find(x=>x.codec_type==='audio');if(!stream)throw new Error(`素材没有可用音轨：${path.basename(id.file)}`);
  const duration=Number(info.format?.duration)||Number(stream.duration);
  if(!Number.isFinite(duration)||duration<=0)throw new Error('无法确定音频长度');
  if(duration>MAX_SECONDS)throw new Error(`音频分析支持不超过 ${MAX_SECONDS/60} 分钟的单个素材，请先裁短素材`);
  onProgress?.({stage:'解码本地音轨',file:id.file});
  const buffer=await exec('ffmpeg',['-v','error','-nostdin','-i',id.file,'-map','0:a:0','-vn','-ac','1','-ar',String(SAMPLE_RATE),'-f','f32le','pipe:1'],{signal,maxBytes:MAX_BYTES});
  check(signal);const bytes=buffer.byteLength-buffer.byteLength%4;
  if(bytes<4)throw new Error('音轨解码后没有有效采样');
  // Copy once into an aligned backing store; avoid a per-sample JS loop on the
  // Electron main thread. Supported desktop targets use little-endian floats.
  const samples=new Float32Array(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+bytes));
  const audio={samples,sampleRate:SAMPLE_RATE,duration:samples.length/SAMPLE_RATE};
  while(decoded.size&&(cacheBytes+bytes>96*1024*1024||decoded.size>=6)){const first=decoded.keys().next().value;cacheBytes-=decoded.get(first).samples.byteLength;decoded.delete(first);}
  decoded.set(id.key,audio);cacheBytes+=bytes;return audio;
}
function analyze(task,payload,{signal,onProgress}={}){
  check(signal);
  return new Promise((resolve,reject)=>{
    const worker=new Worker(path.join(__dirname,'alignment-worker.cjs'),{workerData:{task,...payload}});let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);worker.terminate();error?reject(error):resolve(value);};
    const cancel=()=>finish(aborted());signal?.addEventListener('abort',cancel,{once:true});
    worker.on('message',message=>{try{if(message.progress)onProgress?.(message.progress);else if(message.error)finish(new Error(message.error));else finish(null,message.result);}catch(error){finish(error);}});
    worker.on('error',error=>finish(error));worker.on('exit',code=>{if(!settled)finish(new Error(`音频分析进程意外退出 (${code})`));});
  });
}
async function waveform(file,{points=1200,start=0,end,signal,onProgress}={}){
  const id=await identity(file,signal),audio=await readAudio(id,{signal,onProgress});
  points=Math.max(32,Math.min(5000,Math.round(Number(points)||1200)));start=Math.max(0,Number(start)||0);end=end==null?audio.duration:Number(end);
  if(!Number.isFinite(end)||end<=start||start>=audio.duration||end>audio.duration+.001)throw new Error('波形范围超出音频长度');
  end=Math.min(end,audio.duration);const key=`wave\0${id.key}\0${points}\0${start}\0${end}`;check(signal);
  if(results.has(key))return remember(results,key,results.get(key)).value;
  const value=await analyze('waveform',{samples:audio.samples,sampleRate:SAMPLE_RATE,points,start,end},{signal,onProgress});
  return remember(results,key,{files:[id.file],value}).value;
}
async function align({source,target}={},options={}){
  const {signal,onProgress}=options;const [masterId,videoId]=await Promise.all([identity(source,signal),identity(target,signal)]);
  const key=`align-v1\0${masterId.key}\0${videoId.key}`;check(signal);if(results.has(key))return remember(results,key,results.get(key)).value;
  const master=await readAudio(masterId,options),video=await readAudio(videoId,options);
  onProgress?.({stage:'比较音轨与多个时间窗口'});
  const value=await analyze('align',{master:master.samples,video:video.samples,sampleRate:SAMPLE_RATE},options);
  const result={...value,source:masterId.file,target:videoId.file,sourceDuration:master.duration,targetDuration:video.duration,offsetConvention:'targetTime - sourceTime'};
  return remember(results,key,{files:[masterId.file,videoId.file],value:result}).value;
}
function clearCache({file}={}){
  const selected=file?path.resolve(file):null;
  for(const [key,audio]of decoded)if(!selected||key.startsWith(`${selected}\0`)){cacheBytes-=audio.samples.byteLength;decoded.delete(key);}
  for(const [key,result]of results)if(!selected||result.files.includes(selected))results.delete(key);
}
module.exports={waveform,align,clearCache,SAMPLE_RATE,MAX_SECONDS};

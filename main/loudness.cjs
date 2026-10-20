// Offline EBU R128 measurement followed by one static gain per continuous
// track. Musical dynamics and shared-source joins are never re-compressed.
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createHash,randomUUID}=require('node:crypto');
const TARGET_LUFS=-16,TRUE_PEAK_DB=-1.5,MAX_BOOST_DB=30;
const binary=path.join(__dirname,'../resources/bin',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
const cache=new Map();let cacheDirectory='';
function configureCache(directory){cacheDirectory=directory||'';}
function aborted(){return Object.assign(new Error('已取消响度分析'),{name:'AbortError'});}
function check({signal,job}={}){if(signal?.aborted||job?.cancelled)throw aborted();}
function gainFor(measured){
  const integrated=Number(measured.input_i),peak=Number(measured.input_tp);
  // Silence and near-silent recordings must not become amplified noise.
  if(!Number.isFinite(integrated)||!Number.isFinite(peak)||integrated<-60)return {gain:1,gainDb:0,silent:true,integrated:Number.isFinite(integrated)?integrated:null,truePeak:Number.isFinite(peak)?peak:null};
  const gainDb=Math.max(-80,Math.min(TARGET_LUFS-integrated,TRUE_PEAK_DB-peak,MAX_BOOST_DB));
  return {gain:10**(gainDb/20),gainDb,silent:false,integrated,truePeak:peak,peakLimited:gainDb<TARGET_LUFS-integrated-.01};
}
function remember(key,value){cache.delete(key);cache.set(key,value);while(cache.size>512)cache.delete(cache.keys().next().value);return value;}
function measure(file,start,duration,loop,options){
  check(options);
  return new Promise((resolve,reject)=>{
    const args=['-hide_banner','-nostdin','-nostats',...(loop?['-stream_loop','-1']:[]),'-ss',String(start),'-t',String(duration),'-i',file,'-map','0:a:0','-vn','-sn','-dn','-af',`aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DB}:LRA=11:print_format=json`,'-f','null','-'];
    const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','ignore','pipe']});
    if(options.job)options.job.child=child;
    let stderr='',failure;const cancel=()=>child.kill();options.signal?.addEventListener('abort',cancel,{once:true});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-24000);});
    child.on('error',error=>{failure=error;});
    child.on('close',code=>{
      options.signal?.removeEventListener('abort',cancel);if(options.job?.child===child)options.job.child=null;
      try{
        check(options);if(failure)throw failure;
        if(code!==0)throw new Error(`响度分析失败：${path.basename(file)}\n${stderr.slice(-3000)}`);
        const json=stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
        if(!json)throw new Error(`无法测量素材响度：${path.basename(file)}`);
        resolve(gainFor(JSON.parse(json)));
      }catch(error){reject(error);}
    });
  });
}
async function analyze(track,options={}){
  check(options);
  if(track.normalizeAudio===false||track.overlay)return {id:track.id,gain:1,gainDb:0,skipped:true};
  const file=path.resolve(String(track.file||'')),start=Number(track.loudnessRange?.start??track.start),duration=Number(track.loudnessRange?.duration??track.duration);
  if(!track.file||!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<=0||duration>21600)throw new Error('响度分析需要有效音源与取用范围（不超过 6 小时）');
  const stat=await fs.stat(file);if(!stat.isFile())throw new Error('响度分析素材不是普通文件');check(options);
  const key=createHash('sha256').update(JSON.stringify(['arcshow-loudness-v2',file,stat.size,stat.mtimeMs,start,duration,!!track.loop,TARGET_LUFS,TRUE_PEAK_DB])).digest('hex');
  let result=cache.get(key);
  const stored=cacheDirectory?path.join(cacheDirectory,key+'.json'):'';
  if(!result&&stored){
    try{const raw=JSON.parse(await fs.readFile(stored,'utf8'));if(raw.key===key&&Number.isFinite(raw.value?.gain)&&raw.value.gain>=0&&raw.value.gain<=10**(MAX_BOOST_DB/20))result=raw.value;}catch{}
  }
  if(!result){
    const {audioChannels}=await require('./exporter.cjs').probe(file);check(options);
    result=await measure(file,start,duration,!!track.loop,options);check(options);
    // FFmpeg's mono-centre -> stereo matrix uses -3 dB per side; Web Audio
    // duplicates mono at unity. Compensate that routing difference in preview.
    result={...result,audioChannels,previewGain:result.gain*(audioChannels===1?Math.SQRT1_2:1)};
    if(stored){
      const temp=stored+'.'+randomUUID()+'.tmp';
      try{await fs.mkdir(cacheDirectory,{recursive:true});await fs.writeFile(temp,JSON.stringify({key,value:result}));await fs.rename(temp,stored);}catch{await fs.rm(temp,{force:true}).catch(()=>{});}
    }
  }
  check(options);remember(key,result);
  return {id:track.id,...result,target:TARGET_LUFS,start,duration};
}
async function normalizeTracks(tracks,options={}){
  if(!Array.isArray(tracks)||tracks.length>1000)throw new Error('响度分析音轨列表无效');
  check(options);
  const parentSignal=options.signal,controller=new AbortController(),cancel=()=>controller.abort();
  parentSignal?.addEventListener('abort',cancel,{once:true});
  options={...options,signal:controller.signal};
  const result=new Array(tracks.length);let next=0,done=0;
  // Keep export cancellation attached to exactly one child process.
  const worker=async()=>{while(next<tracks.length){check(options);const index=next++,track=tracks[index];options.onProgress?.({done,total:tracks.length,file:track.file});result[index]=await analyze(track,options);done++;options.onProgress?.({done,total:tracks.length,file:track.file});}};
  const workers=Array.from({length:Math.min(options.job?1:2,tracks.length)},worker);
  try{await Promise.all(workers);return result;}
  catch(error){controller.abort();await Promise.allSettled(workers);throw error;}
  finally{parentSignal?.removeEventListener('abort',cancel);}
}
module.exports={configureCache,analyze,normalizeTracks,gainFor,TARGET_LUFS,TRUE_PEAK_DB};

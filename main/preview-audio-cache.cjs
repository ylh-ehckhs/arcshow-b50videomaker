// Preview-only PCM ranges. Source media and project/export paths are untouched.
// One successful batch stays pinned until another successful batch replaces it.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {createHash,randomUUID}=require('node:crypto');
const SAMPLE_RATE=48000,CHANNELS=2,BYTES_PER_SECOND=SAMPLE_RATE*CHANNELS*2;
const MAX_CACHE_BYTES=1024*1024*1024,MAX_CONCURRENT=2;
const DEFAULT_DIRECTORY=path.join(os.tmpdir(),'arcshow-preview-audio-cache');
const binary=path.join(__dirname,'../resources/bin',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
const states=new Map(),pending=new Map(),queue=[];
let cacheDirectory=DEFAULT_DIRECTORY,running=0,batchSerial=0;

function configureCache(directory){cacheDirectory=directory?path.resolve(directory):DEFAULT_DIRECTORY;}
function aborted(){return Object.assign(new Error('已取消预览音轨准备'),{name:'AbortError'});}
function check(signal){if(signal?.aborted)throw aborted();}
function stateFor(directory){
  let state=states.get(directory);
  if(!state){state={pinned:new Set(),leases:new Map(),latestSuccess:0,pruning:Promise.resolve()};states.set(directory,state);}
  return state;
}
function protect(state,file){state.leases.set(file,(state.leases.get(file)||0)+1);}
function unprotect(state,file){const n=(state.leases.get(file)||1)-1;if(n)state.leases.set(file,n);else state.leases.delete(file);}
function isProtected(state,file){return state.pinned.has(file)||state.leases.has(file);}

function takeSlot(signal){
  check(signal);
  return new Promise((resolve,reject)=>{
    const item={resolve,reject,signal,cancel:null};
    item.cancel=()=>{const at=queue.indexOf(item);if(at>=0){queue.splice(at,1);signal.removeEventListener('abort',item.cancel);reject(aborted());}};
    if(running<MAX_CONCURRENT){running++;resolve();}
    else{queue.push(item);signal.addEventListener('abort',item.cancel,{once:true});if(signal.aborted)item.cancel();}
  });
}
function releaseSlot(){
  running--;
  while(queue.length){const item=queue.shift();item.signal.removeEventListener('abort',item.cancel);if(item.signal.aborted){item.reject(aborted());continue;}running++;item.resolve();break;}
}

async function identity(track,directory,signal){
  check(signal);
  const start=Number(track?.start??0),duration=Number(track?.duration);
  if(!track||typeof track.file!=='string'||!track.file.trim()||!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<1/SAMPLE_RATE)
    throw new Error('预览音轨需要有效的本地文件、非负起点与正时长');
  // A single range must fit in the cache budget. Active batches can temporarily
  // exceed it; eviction must never remove media that is still being previewed.
  if(duration*BYTES_PER_SECOND+65536>MAX_CACHE_BYTES)throw new Error('单段预览音轨超过 1 GiB，请缩短试听范围');
  const file=path.resolve(track.file),stat=await fs.stat(file);check(signal);
  if(!stat.isFile()||!stat.size)throw new Error(`预览音轨不是有效文件：${path.basename(file)}`);
  const key=createHash('sha256').update(JSON.stringify(['arcshow-preview-pcm-v2',file,stat.size,stat.mtimeMs,start,duration,!!track.loop,SAMPLE_RATE,CHANNELS])).digest('hex');
  return {file,size:stat.size,mtimeMs:stat.mtimeMs,start,duration,loop:!!track.loop,key,directory,target:path.join(directory,key+'.wav')};
}

async function inspectWav(file,duration){
  const handle=await fs.open(file,'r');
  try{
    const stat=await handle.stat(),head=Buffer.alloc(Math.min(65536,stat.size));
    await handle.read(head,0,head.length,0);
    if(head.length<44||head.toString('ascii',0,4)!=='RIFF'||head.toString('ascii',8,12)!=='WAVE')throw new Error('预览音轨缓存格式无效');
    let format=false,samples=0;
    for(let at=12;at+8<=head.length;){
      const id=head.toString('ascii',at,at+4),length=head.readUInt32LE(at+4),body=at+8;
      if(id==='fmt '){
        if(length<16||body+16>head.length||head.readUInt16LE(body)!==1||head.readUInt16LE(body+2)!==CHANNELS||head.readUInt32LE(body+4)!==SAMPLE_RATE||head.readUInt16LE(body+14)!==16)throw new Error('预览音轨缓存不是立体声 48 kHz PCM');
        format=true;
      }
      if(id==='data'){
        if(!format||!length||length%4||body+length>stat.size)throw new Error('预览音轨缓存不完整');
        samples=length/4;break;
      }
      at=body+length+(length%2);
    }
    if(!samples||Math.abs(samples/SAMPLE_RATE-duration)>1/SAMPLE_RATE+.000001)throw new Error('预览音轨取用范围超过音频长度，或素材无法完整解码');
    return stat;
  }finally{await handle.close();}
}

function decode(meta,temp,signal){
  check(signal);
  return new Promise((resolve,reject)=>{
    // AAC/44.1 kHz timestamp rounding can otherwise emit a handful of samples
    // beyond -t. Align the decoded timeline at zero and trim an exact PCM count.
    // There is deliberately no tail padding: a genuinely short source must fail
    // the completeness check rather than silently acquire synthesized audio.
    const filters=`aresample=${SAMPLE_RATE}:first_pts=0,atrim=end_sample=${Math.round(meta.duration*SAMPLE_RATE)},asetpts=PTS-STARTPTS`;
    const args=['-y','-v','error','-nostdin',...(meta.loop?['-stream_loop','-1']:[]),'-ss',String(meta.start),'-i',meta.file,'-t',String(meta.duration),'-map','0:a:0','-vn','-sn','-dn','-af',filters,'-ac',String(CHANNELS),'-ar',String(SAMPLE_RATE),'-c:a','pcm_s16le','-f','wav',temp];
    const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let stderr='',failure;
    const cancel=()=>child.kill();signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-6000);});
    child.on('error',error=>{failure=error;});
    child.on('close',code=>{
      signal.removeEventListener('abort',cancel);
      if(signal.aborted)reject(aborted());
      else if(failure)reject(failure);
      else if(code!==0)reject(new Error(`无法准备预览音轨：${path.basename(meta.file)}\n${stderr.trim()}`));
      else resolve();
    });
  });
}

async function build(meta,signal){
  await takeSlot(signal);
  const temp=meta.target+'.'+randomUUID()+'.tmp';
  try{
    check(signal);await fs.mkdir(meta.directory,{recursive:true});check(signal);
    try{
      await inspectWav(meta.target,meta.duration);check(signal);
      const now=new Date();await fs.utimes(meta.target,now,now).catch(()=>{});
      return meta.target;
    }catch(error){if(signal.aborted)throw aborted();if(error.code!=='ENOENT')await fs.rm(meta.target,{force:true});}
    await decode(meta,temp,signal);check(signal);await inspectWav(temp,meta.duration);check(signal);
    const after=await fs.stat(meta.file);
    if(after.size!==meta.size||after.mtimeMs!==meta.mtimeMs)throw new Error('音频素材在预览准备期间发生变化，请重试');
    check(signal);await fs.rename(temp,meta.target);check(signal);return meta.target;
  }finally{await fs.rm(temp,{force:true}).catch(()=>{});releaseSlot();}
}

function shared(meta,signal){
  check(signal);const taskKey=meta.target;let task=pending.get(taskKey);
  if(!task||task.controller.signal.aborted){
    const controller=new AbortController();task={controller,users:0,promise:build(meta,controller.signal)};pending.set(taskKey,task);
    const clear=()=>{if(pending.get(taskKey)===task)pending.delete(taskKey);};task.promise.then(clear,clear);
  }
  task.users++;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,value)=>{
      if(settled)return;settled=true;signal.removeEventListener('abort',cancel);task.users--;
      if(!task.users&&error)task.controller.abort();error?reject(error):resolve(value);
    };
    const cancel=()=>{
      if(settled)return;settled=true;signal.removeEventListener('abort',cancel);task.users--;
      if(!task.users){task.controller.abort();task.promise.then(()=>reject(aborted()),()=>reject(aborted()));}
      else reject(aborted());
    };signal.addEventListener('abort',cancel,{once:true});
    task.promise.then(value=>finish(null,value),error=>finish(error));if(signal.aborted)cancel();
  });
}

function prune(directory,state){
  const run=async()=>{
    const files=[];let total=0;
    for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(()=>[])){
      if(!entry.isFile()||!/^([a-f0-9]{64})\.wav$/.test(entry.name))continue;
      const file=path.join(directory,entry.name),stat=await fs.stat(file).catch(()=>null);
      if(stat){total+=stat.size;files.push({file,size:stat.size,mtime:stat.mtimeMs});}
    }
    files.sort((a,b)=>a.mtime-b.mtime);
    for(const item of files){if(total<=MAX_CACHE_BYTES)break;if(isProtected(state,item.file))continue;try{await fs.unlink(item.file);total-=item.size;}catch{}}
  };
  state.pruning=state.pruning.then(run,run);return state.pruning;
}

async function prepareTracks(tracks,{signal,onProgress}={}){
  if(!Array.isArray(tracks)||tracks.length>1000)throw new Error('预览音轨列表无效');
  check(signal);
  const directory=cacheDirectory,state=stateFor(directory),serial=++batchSerial,controller=new AbortController();
  const cancel=()=>controller.abort(),leases=[],result=new Array(tracks.length);let done=0;
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)controller.abort();
  const notify=file=>onProgress?.({stage:'准备本地预览音轨',done,total:tracks.length,file});
  const workers=tracks.map(async(track,index)=>{
    const meta=await identity(track,directory,controller.signal);check(controller.signal);
    protect(state,meta.target);leases.push(meta.target);notify(meta.file);check(controller.signal);
    const file=await shared(meta,controller.signal);check(controller.signal);
    result[index]={id:track.id,file,start:0,duration:meta.duration,sourceStart:meta.start,...(meta.loop?{loop:false}:{})};done++;notify(meta.file);
  });
  try{
    await Promise.all(workers);check(controller.signal);
    if(serial>=state.latestSuccess){state.latestSuccess=serial;state.pinned=new Set(result.map(track=>track.file));}
    return result;
  }catch(error){controller.abort();await Promise.allSettled(workers);throw error;}
  finally{
    signal?.removeEventListener('abort',cancel);for(const file of leases)unprotect(state,file);
    await prune(directory,state).catch(()=>{});
  }
}

module.exports={configureCache,prepareTracks};

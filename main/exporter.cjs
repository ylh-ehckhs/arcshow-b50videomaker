const fs=require('node:fs/promises');
const {existsSync}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const root=path.join(__dirname,'..');
const binary=name=>path.join(root,'resources','bin',name+(process.platform==='win32'?'.exe':''));
class Cancelled extends Error {constructor(){super('已取消导出');}}
function execute(tool,args,job,onLine){
  return new Promise((resolve,reject)=>{
    if(job?.cancelled)return reject(new Cancelled());
    const child=spawn(binary(tool),args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    if(job)job.child=child;
    let out='',err='',pending='';
    child.stdout.on('data',chunk=>{out+=chunk;pending+=chunk;const lines=pending.split(/\r?\n/);pending=lines.pop();lines.forEach(line=>onLine?.(line));});
    child.stderr.on('data',chunk=>{err=(err+chunk).slice(-12000);});
    child.on('error',reject);
    child.on('close',code=>{if(job?.child===child)job.child=null;if(job?.cancelled)reject(new Cancelled());else if(code!==0)reject(new Error(`${tool} 失败 (${code})\n${err}`));else resolve({out,err});});
  });
}
async function probe(file){
  if(!existsSync(file))throw new Error(`素材不存在：${file}`);
  const {out}=await execute('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file]);
  const data=JSON.parse(out),v=data.streams?.find(s=>s.codec_type==='video'),a=data.streams?.find(s=>s.codec_type==='audio');
  const origin=Number(data.format?.start_time)||0;
  const streamStart=s=>Math.max(0,(Number(s?.start_time)||origin)-origin);
  const streamDuration=s=>{
    if(!s)return 0;
    if(Number.isFinite(Number(s.duration)))return Number(s.duration)+streamStart(s);
    if(s.duration_ts!=null&&s.time_base){const [n,d]=String(s.time_base).split('/').map(Number);if(d)return Number(s.duration_ts)*n/d+streamStart(s);}
    const tag=Object.entries(s.tags||{}).find(([k])=>k.toUpperCase()==='DURATION')?.[1];
    if(tag){const fields=String(tag).split(':').map(Number);if(fields.length===3&&fields.every(Number.isFinite))return fields[0]*3600+fields[1]*60+fields[2]-origin;}
    return Number(data.format?.duration)||0;
  };
  return {duration:Number(data.format?.duration)||Math.max(streamDuration(v),streamDuration(a)),videoDuration:streamDuration(v),audioDuration:streamDuration(a),videoStart:streamStart(v),audioStart:streamStart(a),audioChannels:Number(a?.channels)||0,width:v?.width,height:v?.height,videoFrames:Number(v?.nb_frames)||null,video:!!v,audio:!!a};
}
let cachedEncoder;
async function encoder(request,job){
  if(request==='software')return 'libx264';
  if(cachedEncoder)return cachedEncoder;
  for(const codec of ['h264_nvenc','h264_qsv']){
    try{await execute('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=320x180:r=30:d=0.1','-frames:v','1','-c:v',codec,'-f','null','-'],job);cachedEncoder=codec;return codec;}catch(error){if(job.cancelled)throw error;}
  }
  cachedEncoder='libx264';return cachedEncoder;
}
async function exportMovie({project,output,singleId,render,progress=()=>{},job={cancelled:false}}){
  const {validateProject,ranked,buildTimeline,issues,clock}=await import(pathToFileURL(path.join(root,'shared/core.mjs')));
  const {videoRect,getLayout,layoutImageFile}=await import(pathToFileURL(path.join(root,'shared/layout.mjs')));
  const {withSceneTransitions,ffmpegVisualFilters}=await import(pathToFileURL(path.join(root,'shared/transitions.mjs')));
  const p=validateProject(project),best=ranked(p),plan=buildTimeline(p,{singleId});
  // Resolve against the full film even for a selected-clip export, preserving
  // the same entering/exiting transition that the preview shows at that cut.
  const fullTimeline=withSceneTransitions(p,singleId?buildTimeline(p).scenes:plan.scenes);
  const transitionById=new Map(fullTimeline.map(scene=>[scene.clipId,scene.visualTransition]));
  const timeline=plan.scenes.filter(scene=>!singleId||scene.type!=='gap').map(scene=>({...scene,visualTransition:transitionById.get(scene.clipId)}));
  if(!best.length||!timeline.length)throw new Error('请先添加至少一条加入影片的成绩');
  if(plan.issues.length)throw new Error(plan.issues.map(i=>i.message).join('；'));
  for(const s of timeline)if(s.entry){const e=s.entry,errors=issues(e,p);if(errors.length)throw new Error(`${e.title||'未命名曲目'}：${errors.join('；')}`);if(!e.reviewed)throw new Error(`${e.title} 尚未确认 OCR 校对结果`);}
  const layout=getLayout(p),media=new Map(),needed=new Set([p.settings.background]);
  for(const s of timeline){
    if(s.type==='animation')needed.add(s.file);
    if(s.entry)for(const k of ['video','background'])needed.add(s.entry[k]);
    for(const image of layout.images[s.type]||[])needed.add(layoutImageFile(image,s.entry));
  }
  for(const a of plan.audio)needed.add(a.file);
  for(const file of needed){if(!file)continue;progress({ratio:0,stage:'检查本地素材',detail:path.basename(file)});media.set(file,await probe(file));}
  const checkRange=(file,start,duration,kind,label)=>{
    const m=media.get(file),limit=kind==='video'?m?.videoDuration:m?.audioDuration;
    if(!m?.[kind])throw new Error(`${label} 没有可用${kind==='video'?'画面':'音轨'}：${path.basename(file)}`);
    if(!Number.isFinite(start)||start<0)throw new Error(`${label} 的素材起点不能为负数`);
    const actualStart=kind==='video'?m.videoStart:m.audioStart;
    if(start+.001<actualStart)throw new Error(`${label} 需要从 ${start.toFixed(3)} 秒取用，但素材的${kind==='video'?'画面':'音轨'}从 ${actualStart.toFixed(3)} 秒才开始，缺少 ${(actualStart-start).toFixed(3)} 秒`);
    if(!Number.isFinite(limit)||limit<=0)throw new Error(`${label} 的素材长度无法确认，请更换可读取的素材`);
    if(start+duration>limit+.001)throw new Error(`${label} 需要 ${start.toFixed(3)}–${(start+duration).toFixed(3)} 秒，素材只有 ${limit.toFixed(3)} 秒，缺少 ${(start+duration-limit).toFixed(3)} 秒；请调整起止点或时长`);
  };
  for(const s of timeline){
    if(s.type==='animation')checkRange(s.file,Number(s.start),s.duration,'video','动画');
    else if(s.entry?.video)checkRange(s.entry.video,Number(s.entry.start),s.duration,'video',s.entry.title);
  }
  for(const a of plan.audio){
    if(a.loop){if(!media.get(a.file)?.audio)throw new Error('旧工程背景音乐没有可用音轨');}
    else checkRange(a.file,a.start,a.duration,'audio',a.kind==='group'?'连续配乐':a.kind==='overview'?'总览音乐':'片段配乐');
  }
  const normalized=await require('./loudness.cjs').normalizeTracks(plan.audio,{job,onProgress:({done,total,file})=>progress({ratio:0,stage:`统一配乐响度 ${done} / ${total}`,detail:path.basename(file||'')})});
  const audioGains=new Map(normalized.map(a=>[a.id,a.gain]));
  const work=await fs.mkdtemp(path.join(os.tmpdir(),'arcshow-'));
  const partial=path.join(path.dirname(output),`.arcshow-${require('node:crypto').randomUUID()}.partial.mp4`);
  let codec=await encoder(p.settings.encoder,job);
  const total=plan.duration,fps=Number(p.settings.fps),width=Number(p.settings.width),height=width*9/16;
  const filterThreads=String(Math.min(8,os.availableParallelism?.()||os.cpus().length));
  let elapsed=0,completed=false;const clips=[];
  const encodeArgs=()=>codec==='libx264'?['-c:v','libx264','-preset','fast','-crf',String(p.settings.crf),'-threads','4']:codec==='h264_nvenc'?['-c:v',codec,'-preset','p4','-cq',String(p.settings.crf),'-b:v','0']:['-c:v',codec,'-global_quality',String(p.settings.crf)];
  try{
    for(let index=0;index<timeline.length;index++){
      if(job.cancelled)throw new Cancelled();
      const s=timeline[index],d=Number(s.duration),e=s.entry;
      const label=s.type==='song'?`B${e.rank} · ${e.title}`:s.type==='animation'?'插入动画':s.type==='gap'?'黑场留白':`成绩总览 ${s.page}/${s.pages}`;
      progress({ratio:elapsed/total*.88,stage:`合成 ${index+1} / ${timeline.length}`,detail:label,encoder:codec});
      const clip=path.join(work,`${String(index).padStart(3,'0')}.mp4`);
      const args=['-y','-hide_banner','-loglevel','error','-filter_complex_threads',filterThreads];
      const filters=[];let base='0:v';
      if(s.type==='gap'){
        args.push('-f','lavfi','-i',`color=c=black:s=${width}x${height}:r=${fps}:d=${d}`);
      }else if(s.type==='animation'){
        args.push('-ss',String(s.start),'-i',s.file);
        filters.push(`[0:v]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}:eof_action=pass,format=yuv420p[animationbase]`);base='animationbase';
      }else{
        const r=videoRect(p),composite=!!e?.video&&r.visible,png=path.join(work,`${index}.png`);
        await fs.writeFile(png,await render({project:p,scene:s,still:true,layer:composite?'background':'complete'}));
        args.push('-loop','1','-framerate',String(fps),'-i',png);
        if(composite){
          const fg=path.join(work,`${index}-foreground.png`);
          await fs.writeFile(fg,await render({project:p,scene:s,still:true,layer:'foreground'}));
          args.push('-loop','1','-framerate',String(fps),'-i',fg,'-ss',String(e.start),'-i',e.video);
          const pad=Math.min(Math.floor(r.padding/2)*2,Math.floor((Math.min(r.w,r.h)-4)/4)*2),innerW=r.w-pad*2,innerH=r.h-pad*2;
          const color=(r.background||'#080f16').replace('#','0x');let shape='';
          if(r.radius>0){
            const rad=Math.min(r.radius,r.w/2,r.h/2);
            const alpha=`if(lte(pow(max(${rad}-X\\,X-(W-${rad}-1))\\,2)+pow(max(${rad}-Y\\,Y-(H-${rad}-1))\\,2)\\,${rad*rad})\\,255\\,if(between(X\\,${rad}\\,W-${rad}-1)+between(Y\\,${rad}\\,H-${rad}-1)\\,255\\,0))`;
            shape=`,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'`;
          }
          filters.push(`[2:v]setpts=PTS-STARTPTS,scale=${innerW}:${innerH}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${r.w}:${r.h}:(ow-iw)/2:(oh-ih)/2:color=${color},setsar=1,fps=${fps}:eof_action=pass,format=rgba${shape},colorchannelmixer=aa=${r.opacity}[game]`);
          filters.push(`[0:v][game]overlay=${r.x}:${r.y}:shortest=1[gamebase]`);
          filters.push('[gamebase][1:v]overlay=0:0:shortest=1[base]');base='base';
        }
      }
      filters.push(`[${base}]scale=${width}:${height}:flags=lanczos,setsar=1,fps=${fps}:eof_action=pass,format=yuv420p[scaled]`);
      filters.push(...ffmpegVisualFilters(s.visualTransition,d,'scaled','v',width/1920));
      args.push('-filter_complex',filters.join(';'),'-map','[v]','-an','-t',String(d),'-frames:v',String(Math.round(d*fps)),'-r',String(fps),'-pix_fmt','yuv420p','-progress','pipe:1','-nostats');
      const onLine=line=>{const m=/^out_time_us=(\d+)/.exec(line);if(m)progress({ratio:Math.min(.88,(elapsed+Math.min(d,Number(m[1])/1e6))/total*.88),stage:`合成 ${index+1} / ${timeline.length}`,detail:`${label} · ${clock(Number(m[1])/1e6)} / ${clock(d)}`,encoder:codec});};
      try{await execute('ffmpeg',[...args,...encodeArgs(),clip],job,onLine);}
      catch(error){
        if(job.cancelled||codec==='libx264')throw error;
        codec='libx264';progress({ratio:elapsed/total*.88,stage:'硬件编码不可用，已切换软件编码',detail:label});
        for(let previous=0;previous<clips.length;previous++){
          const normalized=path.join(work,`software-${previous}.mp4`);
          await execute('ffmpeg',['-y','-v','error','-i',clips[previous],'-map','0:v:0','-an',...encodeArgs(),'-pix_fmt','yuv420p',normalized],job);
          clips[previous]=normalized;
        }
        await execute('ffmpeg',[...args,...encodeArgs(),clip],job,onLine);
      }
      clips.push(clip);elapsed+=d;
    }
    const manifest=path.join(work,'concat.txt');
    await fs.writeFile(manifest,clips.map(c=>`file '${c.replaceAll('\\','/').replaceAll("'","'\\''")}'`).join('\n'));
    progress({ratio:.90,stage:'合并画面与连续音轨',detail:`${timeline.length} 个片段 · ${clock(total)}`});
    // Silence is an intentional base for unscored gaps; every real source was range-checked above.
    // Continuous groups are read once, mixed once, and encoded to AAC only here.
    const finalArgs=['-y','-hide_banner','-loglevel','error','-filter_complex_threads','2','-f','concat','-safe','0','-i',manifest,'-f','lavfi','-t',String(total),'-i','anullsrc=r=48000:cl=stereo'];
    const audioFilters=['[1:a]atrim=duration='+total+',asetpts=PTS-STARTPTS[baseaudio]'],labels=['[baseaudio]'];
    for(let i=0;i<plan.audio.length;i++){
      const a=plan.audio[i],input=i+2;
      if(a.loop)finalArgs.push('-stream_loop','-1');
      finalArgs.push('-ss',String(a.start),'-t',String(a.duration),'-i',a.file);
      const fadeIn=Number(a.fadeIn)||0,fadeOut=Number(a.fadeOut)||0,offset=Number(a.fadeOffset)||0,fadeDuration=Number(a.fadeDuration)||a.duration;
      const gain=[fadeIn?`sin(PI/2*min(1,max(0,(t+${offset})/${fadeIn})))`:'1',fadeOut?`sin(PI/2*min(1,max(0,(${fadeDuration}-(t+${offset}))/${fadeOut})))`:'1'].join('*');
      const envelope=fadeIn||fadeOut?`,aeval=exprs='val(0)*${gain}|val(1)*${gain}'`:'';
      audioFilters.push(`[${input}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${a.duration},asetpts=PTS-STARTPTS,volume=${a.volume*(audioGains.get(a.id)??1)}${envelope},adelay=${Math.round(a.at*48000)}S:all=1[a${i}]`);
      labels.push(`[a${i}]`);
    }
    audioFilters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0${p.settings.normalizeAudio?',alimiter=limit=0.891251:attack=5:release=50:level=false:latency=true':''}[a]`);
    finalArgs.push('-filter_complex',audioFilters.join(';'),'-map','0:v:0','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-t',String(total),'-movflags','+faststart','-progress','pipe:1','-nostats',partial);
    await execute('ffmpeg',finalArgs,job,line=>{const m=/^out_time_us=(\d+)/.exec(line);if(m)progress({ratio:.90+Math.min(1,Number(m[1])/1e6/total)*.08,stage:'合并画面与连续音轨',detail:clock(Number(m[1])/1e6)});});
    const result=await probe(partial);
    if(!result.video||!result.audio||result.width!==width||Math.abs(result.duration-total)>.1||Math.abs(result.videoDuration-total)>1/fps+.005||result.videoFrames!=null&&result.videoFrames!==Math.round(total*fps))throw new Error('成片校验失败，请查看导出日志');
    if(job.cancelled)throw new Cancelled();
    await fs.rename(partial,output);completed=true;
    return {path:output,duration:result.duration,width,height,fps,encoder:codec,segments:timeline.length,audioTracks:plan.audio.length};
  }catch(error){
    await fs.writeFile(path.join(work,'error.log'),String(error.stack||error));
    if(!(error instanceof Cancelled))error.message+=`\n诊断日志：${path.join(work,'error.log')}`;
    throw error;
  }finally{
    await fs.rm(partial,{force:true}).catch(()=>{});
    const safe=path.dirname(path.resolve(work))===path.resolve(os.tmpdir())&&path.basename(work).startsWith('arcshow-');
    if(safe&&(completed||job.cancelled))await fs.rm(work,{recursive:true,force:true}).catch(()=>{});
  }
}
module.exports={exportMovie,probe,binary};

import {buildTimeline} from './timeline.mjs';
import {getLayout,layoutImageFile} from './layout.mjs';

const tolerance=.001;
const filename=file=>String(file||'').split(/[\\/]/).pop();
const seconds=value=>Number(value).toFixed(3);

/** Read-only preflight for the actual timing plan. probe() is injected so the
 * renderer can use IPC and tests can exercise stream boundaries without files.
 * videoDuration/audioDuration mean stream END positions, matching exporter.probe.
 */
export async function checkTimelineMedia(project,probe,{singleId}={}){
  if(typeof probe!=='function')throw new TypeError('素材预检需要 probe(file) 函数');
  const p=structuredClone(project),plan=buildTimeline(p,{singleId}),layout=getLayout(p),issues=[],seen=new Set(),requests=[],files=new Map();
  const add=issue=>{
    const item={code:issue.code||'media-invalid',message:String(issue.message||'素材配置无效'),...(issue.file?{file:issue.file}:{}),...(issue.clipId?{clipId:issue.clipId}:{}),...(issue.groupId?{groupId:issue.groupId}:{})};
    const key=[item.code,item.file||'',item.clipId||'',item.groupId||''].join('\0');if(!seen.has(key)){seen.add(key);issues.push(item);}
  };
  for(const issue of plan.issues)add(issue);
  const need=(file,kind,label,clipId,start,duration,options={})=>{
    if(!file)return;
    const request={file:String(file),kind,label,clipId,start:Number(start),duration:Number(duration),...options};requests.push(request);
    if(!files.has(request.file))files.set(request.file,{request});
  };
  for(const scene of plan.scenes){
    if(scene.type==='gap')continue;
    const e=scene.entry,label=e?.title||'未命名曲目';
    if(scene.type==='animation')need(scene.file,'video','动画',scene.clipId,scene.start,scene.duration);
    else{
      const background=(scene.type==='song'?e?.background:'')||p.settings.background;
      need(background,'image',scene.type==='song'?`${label} 的背景`:'全局背景',scene.clipId);
      for(const image of layout.images[scene.type]||[])need(layoutImageFile(image,e),'image',image.label,scene.clipId);
      if(e)need(e.video,'video',`${label} 的录像`,scene.clipId,e.start,scene.duration);
    }
  }
  for(const sound of plan.audio){
    const label=sound.kind==='group'?'连续配乐':sound.kind==='overview'?'总览音乐':sound.kind==='animation-original'?'动画原声':sound.kind==='animation-effect'?'动画音效':'片段配乐';
    need(sound.file,'audio',label,sound.clipIds?.[0],sound.start,sound.duration,{loop:!!sound.loop,groupId:sound.groupId});
  }
  // Two probes at most: a large B50 must not spawn dozens of FFprobe processes.
  const queue=[...files.entries()];let index=0;
  async function worker(){
    while(index<queue.length){const [file,item]=queue[index++];try{const metadata=await probe(file);if(!metadata||typeof metadata!=='object')throw new Error('无法识别素材流');item.metadata=metadata;}catch(error){item.error=true;add({code:'media-unreadable',message:`${item.request.label} 无法读取：${filename(file)}${error?.message?'；'+error.message:''}`,file,clipId:item.request.clipId});}}
  }
  await Promise.all(Array.from({length:Math.min(2,queue.length)},worker));
  for(const request of requests){
    const {file,kind,label,clipId,groupId,start,duration}=request,item=files.get(file),metadata=item.metadata;
    if(item.error)continue;const where={file,clipId,groupId};
    if(kind==='image'){
      if(!metadata.video)add({code:'image-invalid',message:`${label} 没有可读取的图片画面：${filename(file)}`,...where});
      continue;
    }
    const streamName=kind==='video'?'画面':'音轨';
    if(!metadata[kind]){add({code:`${kind}-missing`,message:`${label} 没有可用${streamName}：${filename(file)}`,...where});continue;}
    // Legacy BGM intentionally loops. Its presence is checked, not its range.
    if(request.loop)continue;
    if(!Number.isFinite(start)||start<0){add({code:`${kind}-start`,message:`${label} 的素材起点必须为非负秒数${Number.isFinite(start)?`，当前缺少 ${seconds(-start)} 秒前置素材`:''}`,...where});continue;}
    if(!Number.isFinite(duration)||duration<=0){add({code:`${kind}-range`,message:`${label} 的取用时长必须大于 0`,...where});continue;}
    const rawStart=Number(metadata[`${kind}Start`]),actualStart=Number.isFinite(rawStart)?rawStart:0;
    if(start+tolerance<actualStart)add({code:`${kind}-delayed`,message:`${label} 需要从 ${seconds(start)} 秒取用，但${streamName}从 ${seconds(actualStart)} 秒才开始，缺少 ${seconds(actualStart-start)} 秒`,...where});
    // Fall back only for old probe contracts that omit the stream field.
    // A present zero/invalid stream duration must not borrow another stream's length.
    const rawLimit=metadata[`${kind}Duration`],limit=Number(rawLimit===undefined?metadata.duration:rawLimit);
    if(!Number.isFinite(limit)||limit<=0)add({code:`${kind}-duration`,message:`${label} 的${streamName}长度无法确认，请更换可读取的素材：${filename(file)}`,...where});
    else if(start+duration>limit+tolerance)add({code:`${kind}-short`,message:`${label} 需要 ${seconds(start)}–${seconds(start+duration)} 秒，${streamName}只有 ${seconds(limit)} 秒，缺少 ${seconds(start+duration-limit)} 秒；请调整起止点或时长`,...where});
  }
  return {issues,files:files.size};
}

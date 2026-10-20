import {ranked} from './rating.mjs';

const songId=id=>`song:${id}`;
const finite=n=>(typeof n==='number'||typeof n==='string'&&n.trim()!=='')&&Number.isFinite(Number(n));
const number=(n,d=0)=>finite(n)?Number(n):d;
// Defaults apply only to omitted fields. Preserve explicitly malformed input so
// planning can report it instead of quietly changing the user's saved cut.
const inputNumber=(n,d=0)=>n===undefined?d:finite(n)?Number(n):NaN;
const uid=()=>globalThis.crypto.randomUUID();
const epsilon=1e-7;

/** Overview order is independent of the editable movie sequence and Best ranks. */
export function overviewEntries(p,best=ranked(p)) {
  return p.settings?.overviewOrder==='ascending'?[...best].reverse():[...best];
}

/** Synchronize selected Best charts without replacing a user's custom order. */
export function ensureSequence(p) {
  const excluded=new Set(Array.isArray(p.excludedEntryIds)?p.excludedEntryIds.map(String):[]);
  const best=ranked(p).filter(e=>!excluded.has(e.id)), selected=new Set(best.map(e=>e.id));
  const ordered=p.settings?.order==='ascending'?best:[...best].reverse();
  const supplied=Array.isArray(p.sequence)?p.sequence:[];
  const seen=new Set(),result=[];
  for(const raw of supplied){
    if(!raw||typeof raw!=='object')continue;
    if(raw.type==='song'){
      const entryId=String(raw.entryId??String(raw.id||'').replace(/^song:/,''));
      if(!selected.has(entryId)||seen.has(entryId))continue;
      seen.add(entryId);Object.assign(raw,{id:songId(entryId),type:'song',entryId});result.push(raw);
    }else if(raw.type==='animation'){
      let id=String(raw.id||`animation:${uid()}`);
      if(result.some(c=>c.id===id))id=`animation:${uid()}`;
      Object.assign(raw,{id,type:'animation',file:String(raw.file||''),start:inputNumber(raw.start),duration:inputNumber(raw.duration,3),audioMode:['next','previous','own','silent'].includes(raw.audioMode)?raw.audioMode:'next',originalVolume:inputNumber(raw.originalVolume,raw.audioMode==='own'?1:0)});result.push(raw);
    }
  }
  for(const e of ordered)if(!seen.has(e.id))result.push({id:songId(e.id),type:'song',entryId:e.id});
  supplied.splice(0,supplied.length,...result);p.sequence=supplied;p.version=2;
  if(!Array.isArray(p.audioGroups))p.audioGroups=[];
  // Pending alignment belongs to a group's current video members. Keep the group
  // object stable for asynchronous editors, and do not manufacture pending flags
  // for legacy groups that predate explicit alignment confirmation.
  const videoIds=new Set((p.entries||[]).filter(e=>e.video).map(e=>songId(e.id)));
  for(const g of p.audioGroups){
    if(!g||!Array.isArray(g.pendingClipIds))continue;
    const members=new Set(Array.isArray(g.clipIds)?g.clipIds:[]);
    g.pendingClipIds=[...new Set(g.pendingClipIds.map(String).filter(id=>members.has(id)&&videoIds.has(id)))];
  }
  return supplied;
}

/** Reset chart ordering while preserving animations at their current slots. */
export function resetSequence(p,order='countdown') {
  const current=ensureSequence(p),excluded=new Set(p.excludedEntryIds||[]),best=ranked(p).filter(e=>!excluded.has(e.id));
  const songs=(order==='ascending'?best:[...best].reverse()).map(e=>({id:songId(e.id),type:'song',entryId:e.id}));
  let i=0;p.sequence=current.map(c=>c.type==='song'?songs[i++]:c);
  while(i<songs.length)p.sequence.push(songs[i++]);
  p.settings.order=order==='ascending'?'ascending':'countdown';
  return p.sequence;
}

export function entryAudioSource(e,p) {
  const mode=e.audioMode||'auto';
  if(mode==='silent')return null;
  if(mode==='audio')return e.audio?{file:e.audio,start:number(e.audioStart),kind:'song'}:null;
  if(mode==='video')return e.video?{file:e.video,start:number(e.start),kind:'song'}:null;
  if(e.audio)return {file:e.audio,start:number(e.audioStart),kind:'song'};
  if(e.video&&p.settings.videoAudio)return {file:e.video,start:number(e.start),kind:'song'};
  return null;
}

/** A shared, media-independent timing plan used identically by preview and export. */
export function buildTimeline(p,{singleId}={}) {
  const sequence=ensureSequence(p),best=ranked(p),byId=new Map(best.map(e=>[e.id,e]));
  const scenes=[],audio=[],issues=[],fps=number(p.settings.fps,60);
  const frameDuration=d=>Math.round(Number(d)*fps)/fps;
  const issue=(code,message,fields={})=>issues.push({code,message,...fields});
  let at=0;
  const add=s=>{
    if(!finite(s.duration)||s.duration<=0){issue('duration',`${s.type==='animation'?'动画':'片段'}时长必须大于 0`,{clipId:s.clipId});return;}
    s.duration=frameDuration(s.duration);
    if(s.duration<=0){issue('duration','片段时长小于一帧',{clipId:s.clipId});return;}
    s.at=at;at+=s.duration;scenes.push(s);
  };
  const content=[];
  for(const c of sequence){
    const s=c.type==='song'?{type:'song',clipId:c.id,entry:{...byId.get(c.entryId)},duration:byId.get(c.entryId)?.duration}:{...c,clipId:c.id};
    add(s);if(s.at!=null)content.push(s);
  }
  const overview=overviewEntries(p,best);
  if(Number(p.settings.overview)>0)for(let i=0;i<overview.length;i+=10)add({type:'overview',clipId:`overview:${i/10+1}`,entries:overview.slice(i,i+10),page:i/10+1,pages:Math.ceil(overview.length/10),duration:Number(p.settings.overview)});
  let total=at;const route=new Map(),grouped=new Set(),groupEvents=[];
  const indexById=new Map(content.map((s,i)=>[s.clipId,i]));
  for(const g of p.audioGroups||[]){
    if(!g||typeof g!=='object'){issue('group-data','连续配乐数据无效，请重新连接配乐');continue;}
    if(g.pendingClipIds!=null&&!Array.isArray(g.pendingClipIds)){issue('calibration-state','连续配乐待校准列表无效，请重新连接配乐',{groupId:g.id});continue;}
    if(g.offsets!==undefined&&(!g.offsets||typeof g.offsets!=='object'||Array.isArray(g.offsets))){issue('group-offset','连续配乐音画偏移数据无效，请重新确认对应',{groupId:g.id});continue;}
    const ids=Array.isArray(g.clipIds)?g.clipIds:[],indices=ids.map(id=>indexById.get(id));
    const label=`连续配乐 ${g.id||''}`;
    if(!ids.length||indices.some(i=>i==null)||new Set(ids).size!==ids.length||!indices.some(i=>content[i]?.type==='song')){issue('group-members',`${label} 包含失效片段或没有歌曲`,{groupId:g.id});continue;}
    if(indices.some((v,i)=>i&&v!==indices[i-1]+1)){issue('group-order',`${label} 的片段必须保持相邻且顺序一致；请重新连接配乐`,{groupId:g.id});continue;}
    if(ids.some(id=>grouped.has(id))){issue('group-overlap',`${label} 与另一组配乐重叠`,{groupId:g.id});continue;}
    if(!g.source){issue('group-source',`${label} 缺少共同音源`,{groupId:g.id});continue;}
    const groupVolume=inputNumber(g.volume,1);
    if(!finite(g.sourceStart)||Number(g.sourceStart)<0||!finite(groupVolume)||groupVolume<0||groupVolume>1){issue('group-range',`${label} 的取音起点或音量无效`,{groupId:g.id});continue;}
    const first=content[indices[0]],last=content[indices.at(-1)],start=Number(g.sourceStart),volume=groupVolume;
    const event={id:`group:${g.id}`,groupId:g.id,file:g.source,start,at:first.at,duration:last.at+last.duration-first.at,volume,kind:'group',clipIds:[...ids],fadeIn:0,fadeOut:0};
    for(const id of ids){
      const s=content[indexById.get(id)],sourcePosition=start+s.at-first.at;
      grouped.add(id);s.audioGroupId=g.id;route.set(id,{file:g.source,start:sourcePosition,volume,groupId:g.id,kind:'group'});
      if(s.entry){
        if(s.entry.video&&Array.isArray(g.pendingClipIds)&&g.pendingClipIds.includes(id))issue('calibration-pending',`${s.entry.title} 的录像尚未确认音画对应，请试听并确认当前对应或采用对齐候选`,{clipId:id,groupId:g.id});
        const offset=g.offsets?.[id];
        if(offset!==undefined&&!finite(offset))issue('group-offset',`${s.entry.title} 的音画偏移无效`,{clipId:id,groupId:g.id});
        s.entry.start=offset===undefined||!finite(offset)?Number(s.entry.start):sourcePosition+Number(offset);
        s.entry.audioStart=sourcePosition;s.entry.audio=g.source;s.audioGroupId=g.id;s.sourceTime=sourcePosition;
      }
    }
    if(indices.at(-1)===content.length-1)event.duration+=total-(last.at+last.duration);
    groupEvents.push(event);
  }
  for(const s of content)if(s.entry&&!grouped.has(s.clipId)){
    const source=entryAudioSource(s.entry,p);
    if(source)route.set(s.clipId,{...source,volume:1});
    else if(['audio','video'].includes(s.entry.audioMode))issue('missing-audio',`${s.entry.title} 未选择指定的配乐素材`,{clipId:s.clipId});
  }
  for(let i=0;i<content.length;i++){
    const s=content[i];if(s.type!=='animation')continue;
    if(!s.file)issue('animation-file','动画片段缺少视频文件',{clipId:s.clipId});
    const validStart=finite(s.start)&&s.start>=0,validVolume=finite(s.originalVolume)&&s.originalVolume>=0&&s.originalVolume<=1;
    if(!validStart)issue('animation-range','动画取用起点应为非负的有效秒数',{clipId:s.clipId,file:s.file});
    if(!validVolume)issue('animation-volume','动画原声音量应为 0–1',{clipId:s.clipId});
    if(s.effectFile){
      const effectStart=inputNumber(s.effectStart),effectVolume=inputNumber(s.effectVolume,1),effectDuration=inputNumber(s.effectDuration,s.duration);
      if(!finite(effectStart)||effectStart<0||!finite(effectVolume)||effectVolume<0||effectVolume>1||!finite(effectDuration)||effectDuration<=0)issue('animation-effect','动画音效起点、音量或时长无效；时长必须大于 0',{clipId:s.clipId,file:s.effectFile});
      else if(effectVolume>0)audio.push({id:`effect:${s.clipId}`,file:String(s.effectFile),start:effectStart,at:s.at,duration:Math.min(s.duration,effectDuration),volume:effectVolume,kind:'animation-effect',overlay:true,clipIds:[s.clipId],fadeIn:0,fadeOut:0});
    }
    if(!grouped.has(s.clipId)&&['next','previous'].includes(s.audioMode)){
      const target=s.audioMode==='next'?content.slice(i+1).find(x=>x.entry):content.slice(0,i).reverse().find(x=>x.entry);
      const source=target&&route.get(target.clipId);
      if(source)route.set(s.clipId,{...source,start:source.start+s.at-target.at,kind:'animation-music'});
      else issue('animation-music',`动画没有可${s.audioMode==='next'?'提前播放的下一首':'延续的上一首'}音源，请选择音源或改为原声／静音`,{clipId:s.clipId});
    }
    if(!grouped.has(s.clipId)&&s.audioMode==='own'&&s.file&&validStart&&validVolume&&s.originalVolume>0)route.set(s.clipId,{file:s.file,start:s.start,volume:s.originalVolume,kind:'animation-original'});
    else if(grouped.has(s.clipId)||s.audioMode==='next'||s.audioMode==='previous'){
      if(s.file&&validStart&&validVolume&&s.originalVolume>0)audio.push({id:`original:${s.clipId}`,file:s.file,start:s.start,at:s.at,duration:s.duration,volume:s.originalVolume,kind:'animation-original',overlay:true,clipIds:[s.clipId],fadeIn:0,fadeOut:0});
    }
  }
  for(const s of scenes){
    if(s.type==='overview'&&groupEvents.some(a=>a.at<=s.at+epsilon&&a.at+a.duration>=s.at+s.duration-epsilon))continue;
    if(s.type==='overview'){
      const song=[...content].reverse().find(x=>x.entry);
      const source=song&&route.get(song.clipId);
      s.audioSilent=song?.entry?.audioMode==='silent';
      if(source)route.set(s.clipId,{...source,start:source.start+s.at-song.at,kind:s.type});
    }
    if(grouped.has(s.clipId))continue;
    const r=route.get(s.clipId);
    if(r)audio.push({id:`audio:${s.clipId}`,...r,at:s.at,duration:s.duration,clipIds:[s.clipId],fadeIn:0,fadeOut:0});
    else if(p.settings.globalBgm&&!(s.audioSilent||s.entry?.audioMode==='silent'||s.type==='animation'&&s.audioMode==='silent'))audio.push({id:`legacy:${s.clipId}`,file:p.settings.globalBgm,start:s.at,at:s.at,duration:s.duration,volume:1,kind:'legacy-bgm',loop:true,clipIds:[s.clipId],fadeIn:0,fadeOut:0});
  }
  audio.push(...groupEvents);
  const volume=number(p.settings.volume,.8);
  for(const a of audio){
    a.volume*=volume;
  }
  for(const s of content)if(s.entry&&(!finite(s.entry.start)||s.entry.start<0))issue('video-start',`${s.entry.title} 联动后的录像起点在素材开始之前`,{clipId:s.clipId,file:s.entry.video});
  // Merge only genuinely contiguous source ranges, never mask a discontinuity.
  audio.sort((a,b)=>a.at-b.at||a.kind.localeCompare(b.kind));
  const merged=[];
  for(const a of audio){
    const prev=[...merged].reverse().find(x=>!x.overlay&&!a.overlay&&x.file===a.file&&x.groupId===a.groupId&&x.volume===a.volume&&x.loop===a.loop&&Math.abs(x.at+x.duration-a.at)<epsilon&&Math.abs(x.start+x.duration-a.start)<epsilon);
    if(prev){prev.duration+=a.duration;prev.clipIds.push(...a.clipIds);}
    else merged.push({...a,clipIds:[...a.clipIds]});
  }
  // A merged source crossing a picture boundary is a continuous connection.
  // Independent clips get an actual black/silent interval; music fades remain
  // inside the selected ranges and never request unavailable pre/post-roll.
  const transition=Math.max(0,number(p.settings.audioTransition,.35));
  const primary=merged.filter(a=>!a.overlay).sort((a,b)=>a.at-b.at);
  const boundaries=[],gaps=[];
  for(let i=1;i<scenes.length;i++){
    const incoming=scenes[i],boundary=incoming.at,key=incoming.clipId;
    const setting=p.settings.sceneTransitions?.[key]??(key?.startsWith('overview:')?p.settings.sceneTransitions?.['overview:1']:undefined);
    const connected=primary.some(a=>a.at<boundary-epsilon&&a.at+a.duration>boundary+epsilon)||incoming.type==='overview';
    incoming.connectedFromPrevious=connected;
    if(connected)continue;
    const gap=setting?.mode==='cut'?0:frameDuration(Math.max(0,Math.min(5,number(setting?.gapDuration,number(p.settings.segmentGap)))));
    if(gap>0)gaps.push({boundary,duration:gap,incomingClipId:key});
    boundaries.push({boundary,key,setting});
  }
  for(const {boundary,setting} of boundaries){
    const outgoing=primary.find(a=>Math.abs(a.at+a.duration-boundary)<epsilon),incoming=primary.find(a=>Math.abs(a.at-boundary)<epsilon);
    const boundaryTransition=setting?.audioDuration===undefined?transition:Math.max(0,number(setting.audioDuration,transition));
    if(outgoing){outgoing.fadeOut=Math.min(boundaryTransition,outgoing.duration/2);outgoing.fadeCurve='equal-power';}
    if(incoming){incoming.fadeIn=Math.min(boundaryTransition,incoming.duration/2);incoming.fadeCurve='equal-power';}
  }
  if(gaps.length){
    const shifted=[];let offset=0;
    for(const scene of scenes){
      const gap=gaps.find(g=>g.incomingClipId===scene.clipId);
      if(gap){shifted.push({type:'gap',clipId:'gap:'+scene.clipId,incomingClipId:scene.clipId,at:scene.at+offset,duration:gap.duration});offset+=gap.duration;}
      scene.at+=offset;shifted.push(scene);
    }
    for(const a of merged)a.at+=gaps.filter(g=>g.boundary<=a.at+epsilon).reduce((sum,g)=>sum+g.duration,0);
    scenes.splice(0,scenes.length,...shifted);total+=offset;
  }
  for(const a of merged){
    a.fadeOffset=0;a.fadeDuration=a.duration;
    // Preserve the full continuous range when exporting/auditioning one card.
    // One shared source receives one static gain, never one gain per difficulty.
    a.normalizeAudio=p.settings.normalizeAudio!==false&&!a.overlay;
    a.loudnessRange={start:a.start,duration:a.duration};
    if(!finite(a.start)||a.start<0)issue('audio-start',`${a.kind==='group'?'连续配乐':'配乐'}取用范围早于音源起点 ${Math.abs(number(a.start)).toFixed(3)} 秒；请调整共同音源开始时间或动画借用范围`,{clipId:a.clipIds?.[0],groupId:a.groupId,file:a.file});
  }
  if(singleId){
    const selected=scenes.find(s=>s.clipId===singleId||s.entry?.id===singleId);
    if(!selected)return {scenes:[],audio:[],issues:issues.filter(i=>i.clipId===singleId||i.clipId===songId(singleId)),duration:0};
    const left=selected.at,right=left+selected.duration;
    const selectedAudio=merged.filter(a=>a.at<right-epsilon&&a.at+a.duration>left+epsilon).map(a=>{const from=Math.max(left,a.at),to=Math.min(right,a.at+a.duration);return {...a,start:a.start+from-a.at,at:from-left,duration:to-from,fadeOffset:from-a.at};});
    return {scenes:[{...selected,at:0}],audio:selectedAudio,issues:issues.filter(i=>i.code!=='audio-start'&&(i.clipId===selected.clipId||i.groupId&&i.groupId===selected.audioGroupId)).concat(selectedAudio.filter(a=>a.start<0).map(a=>({code:'audio-start',message:'配乐取音起点在素材之前',clipId:selected.clipId,file:a.file}))),duration:selected.duration};
  }
  return {scenes,audio:merged,issues,duration:total};
}

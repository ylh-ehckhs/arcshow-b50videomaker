import {escapeHtml as h,fmtScore,fmtRating,grade} from '../shared/core.mjs';
import {getLayout,componentStyle,videoRect,layoutComponent,layoutImageFile} from '../shared/layout.mjs';
import {mediaUrl} from '../shared/media.mjs';
import {scenePalette} from '../shared/impression.mjs';
import {resolveTextLayout,TEXT_SHADOWS} from '../shared/text-styles.mjs';
import {createPreviewVideoPool,createVideoSynchronizer} from './preview-video.mjs';
import {createScenePreparationCache,scenePreparationKey} from './preview-scene.mjs';
import {commentHtml} from '../shared/comments.mjs';
const root=document.querySelector('#stage');
const blurSurface=document.querySelector('#scene-blur');
let state=null,drag=null,sceneGeneration=0,sceneLoading=false,videoPool=null,videoHolder=null,sceneHolder=null,playbackIntent=false;
const videoSync=createVideoSynchronizer();
const abortScene=()=>Object.assign(new Error('预览场景准备已取消'),{name:'AbortError'});
const preparedScenes=createScenePreparationCache({build:buildPreparedScene,maxEntries:2});
function sceneHoldingArea(){
  if(!sceneHolder){sceneHolder=document.createElement('div');sceneHolder.id='preview-scenes';sceneHolder.setAttribute('aria-hidden','true');sceneHolder.style.cssText='position:fixed;left:-10000px;top:0;width:1920px;height:1080px;visibility:hidden;pointer-events:none';document.body.append(sceneHolder);}
  return sceneHolder;
}
function pool(){
  if(!videoPool)videoPool=createPreviewVideoPool({
    createVideo:()=>document.createElement('video'),
    hold:video=>{
      if(!videoHolder){videoHolder=document.createElement('div');videoHolder.id='preview-preload';videoHolder.setAttribute('aria-hidden','true');videoHolder.style.cssText='position:fixed;left:-10000px;top:0;width:2px;height:2px;overflow:hidden;visibility:hidden;pointer-events:none';document.body.append(videoHolder);}
      videoHolder.append(video);
    },maxEntries:3
  });
  return videoPool;
}
function videoSpec(data){
  const s=data.scene,file=s.type==='animation'?s.file:s.type==='song'?s.entry?.video:'';
  if(!file||data.still)return null;
  const start=Math.max(0,Number(s.type==='animation'?s.start:s.entry?.start)||0);
  const time=start+Math.max(0,Number(s.previewSeconds??data.seconds)||0);
  return {key:JSON.stringify([s.clipId,file,start]),src:mediaUrl(file),time,file,tolerance:(s.previewPlaying??data.playing)&&time-start<.15?.15:0};
}
window.prepareScene=async data=>{
  const spec=videoSpec(data);
  await Promise.all([spec?pool().prepare(spec):Promise.resolve(),preparedScenes.prepare(scenePreparationKey(data),data)]);
  return {ready:true,clipId:data.scene.clipId};
};
const img=(path,cls)=>path?`<img class="${cls}" src="${h(mediaUrl(path))}" data-media-file="${h(path)}" data-media-kind="${cls==='backdrop'?'background':'image'}" alt="">`:'';
const bounded=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Number(value))):fallback;
function showTransition(opacity=0,blur=0){
  const overlay=root.querySelector('#scene-transition');
  const value=String(state?.editing||state?.still?0:bounded(opacity,0,1,0));
  if(overlay&&overlay.style.opacity!==value)overlay.style.opacity=value;
  const amount=state?.editing||state?.still?0:bounded(blur,0,1,0);
  // A backdrop blur samples the opaque, already composed scene. Filtering
  // #stage itself fades its perimeter to transparency and exposes black.
  // Keep this surface outside the swapped scene DOM, without scaling content.
  const filter=amount?`blur(${12*amount}px)`:'';
  if(blurSurface.style.backdropFilter!==filter)blurSurface.style.backdropFilter=filter;
}
const sourceStart=()=>Math.max(0,Number(state?.scene?.type==='animation'?state.scene.start:state?.scene?.entry?.start)||0);
function seekVideo(seconds=0,playing=false,force=false){
  const video=root.querySelector('video');if(!video)return;
  const at=sourceStart()+Math.max(0,Number(seconds)||0);
  const seek=()=>videoSync.sync(video,at,{playing,force});
  if(video.readyState>=1)seek();else video.addEventListener('loadedmetadata',seek,{once:true});
}
function mediaError(file,kind,scene=state?.scene){parent.postMessage({type:'media-error',file,kind,clipId:scene?.clipId,sceneId:scene?.id||scene?.entry?.id||'',message:`${kind==='background'?'背景图片':'素材'}无法读取：${file}`},'*');}
function fit(){
  const scale=`scale(${Math.min(innerWidth/1920,innerHeight/1080)})`;
  if(root.style.transform!==scale)root.style.transform=scale;
  if(blurSurface.style.transform!==scale)blurSurface.style.transform=scale;
  // Both the stage and its blur surface survive card swaps. Keep their
  // compositor layers allocated while the next card is prepared offscreen.
  root.style.willChange='transform';root.style.contain='layout paint style';
}
addEventListener('resize',fit);fit();
async function renderScene(target,data,signal){
  const {project:p,scene:s,still=false,layer='complete',editing=false,selectedComponent=''}=data;
  if(s.type==='gap'){
    target.className='scene';target.style.filter='';
    target.innerHTML='<div style="position:absolute;inset:0;background:#000" aria-hidden="true"></div>';return target;
  }
  const e=s.entry,layout=resolveTextLayout(p,s.type==='song'?e:null);
  target.className=`scene ${p.settings.theme==='dawn'?'dawn':''} ${editing?'editing':''} layer-${layer}`;
  for(const [key,value] of Object.entries(scenePalette(p.settings.impression,p.settings.theme)))target.style.setProperty('--'+key,value);
  const bg=(s.type==='song'?e?.background:'')||p.settings.background||'';
  target.style.setProperty('--background-blur',`${bounded(p.settings.backgroundBlur,0,60,0)}px`);
  target.style.setProperty('--background-scale',String(1+bounded(p.settings.backgroundBlur,0,60,0)/500));
  target.style.setProperty('--background-shade',String(bounded(p.settings.backgroundShade,0,1,.25)));
  const block=(scope,id,content,cls='')=>{
    const v=scope==='song'&&id==='video'?videoRect(p):layout[scope][id],key=scope+'.'+id;
    const readable=v.readableText&&!(scope==='song'&&id==='video')&&!!content;
    const localStyle=(v.textColorOverride?`--component-text-color:${v.color};`:'')+(v.textShadow?`text-shadow:${TEXT_SHADOWS[v.textShadow]};`:'');
    return `<div data-component="${key}" class="component ${cls} ${readable?'readable-text':''} ${v.textColorOverride?'local-text-color':''} difficulty-${v.difficultyColor} ${key===selectedComponent?'component-selected':''}" style="${componentStyle(v)}${localStyle}">${content}${editing?'<i class="resize-handle"></i>':''}</div>`;
  };
  let body='';
  if(s.type==='song'){
    body=block('song','video',e.video&&!still?'<video data-preview-slot muted playsinline></video>':'<div class="video-fallback"><span>谱面视频</span></div>','video-frame')+
      block('song','title',h(e.title),'song-title')+
      block('song','meta',`<b class="diff ${h(e.difficulty)}">${h(e.difficulty)}</b> ${e.constant!=null?Number(e.constant).toFixed(1):'—'}${e.artist?`<span class="artist">${h(e.artist)}</span>`:''}`,'track-meta')+
      block('song','player',h(p.player),'muted')+
      block('song','score',`<small>分数</small><strong>${fmtScore(e.score)}</strong>`,'score-value')+
      block('song','grade',h(grade(e)),'grade-value')+
      block('song','rating',`<small>单曲 Potential</small><strong>${fmtRating(e.rating)}</strong>`,'metric')+
      block('song','clear',`<small>通关状态</small><strong>${e.clear==='UNKNOWN'?'—':h(e.clear)}</strong>`,'metric')+
      block('song','judgements',`FAR <b>${e.far??'—'}</b><span>LOST <b>${e.lost??'—'}</b></span>`,'judgements')+
      block('song','comment',commentHtml(e),'comment')+
      block('song','rank',`<strong>#${e.rank}</strong>`,'rank-value')+
      block('song','date',h(p.date),'muted');
  }else if(s.type==='animation'){
    body=s.file&&!still?'<div class="animation-video"><video data-preview-slot muted playsinline></video></div>':'';
  }else{
    body=block('overview','title',`BEST ${p.settings.count}`,'overview-title')+
      block('overview','player',h(p.player),'overview-player')+
      block('overview','page',`${s.page} / ${s.pages}`,'overview-page')+
      block('overview','grid',s.entries.map(e=>`<div class="overview-card"><b class="overview-rank">${String(e.rank).padStart(2,'0')}</b><div><h2>${h(e.title)}</h2><p><span class="diff ${h(e.difficulty)}">${h(e.difficulty)}</span> ${e.constant!=null?Number(e.constant).toFixed(1):'—'} <span class="overview-score">${fmtScore(e.score)}</span></p></div><strong>${fmtRating(e.rating)}</strong></div>`).join(''),'overview-grid');
  }
  const chrome=s.type==='animation'?'':block('common','brand','arcshow-b50videomaker','scene-brand')+block(s.type,'footer',`<span>${h(p.name)}</span><span>${p.demo?'演示成绩':''}</span><span>Arcaea Best ${p.settings.count}</span>`,'scene-footer');
  const plates=(layout.backdrops[s.type]||[]).map(v=>{const key=s.type+'.backdrop:'+v.id;return `<div data-component="${key}" class="component independent-backdrop ${key===selectedComponent?'component-selected':''}" style="${componentStyle(v)}">${editing?'<i class="resize-handle"></i>':''}</div>`;}).join('');
  const pictures=(layout.images[s.type]||[]).map(v=>{
    const key=s.type+'.image:'+v.id,file=layoutImageFile(v,e),content=file?img(file,'layout-picture'):editing?'<span class="layout-picture-empty">'+h(v.label)+'</span>':'';
    return `<div data-component="${key}" class="component independent-image ${key===selectedComponent?'component-selected':''}" style="${componentStyle(v)}--image-fit:${v.fit};">${content}${editing?'<i class="resize-handle"></i>':''}</div>`;
  }).join('');
  target.innerHTML=`<div class="background">${img(bg,'backdrop')}<div class="background-shade"></div><div class="glass-shape"></div></div>${plates}${pictures}${body}${chrome}<div id="scene-transition" class="scene-transition" aria-hidden="true"></div>`;
  await document.fonts.ready;if(signal?.aborted)throw abortScene();
  for(const title of target.querySelectorAll('.song-title,.overview-card h2')){
    let font=parseFloat(getComputedStyle(title).fontSize);
    while(title.scrollWidth>title.clientWidth+1&&font>10){font-=.5;title.style.fontSize=font+'px';}
  }
  const comment=target.querySelector('.comment');
  if(comment){let font=parseFloat(getComputedStyle(comment).fontSize);while(comment.scrollHeight>comment.clientHeight+1&&font>12){font-=.5;comment.style.fontSize=font+'px';}}
  await Promise.all([...target.querySelectorAll('img')].map(im=>waitImage(im,signal,s)));
  // A loaded image can still await decoding, especially in a hidden export window.
  // Finish decoding before the main process requests a composited frame.
  await Promise.all([...target.querySelectorAll('img')].filter(im=>im.naturalWidth).map(im=>im.decode().catch(()=>{})));
  if(signal?.aborted)throw abortScene();return target;
}
function waitImage(im,signal,scene){
  if(signal?.aborted)return Promise.reject(abortScene());
  if(im.complete){if(!im.naturalWidth)mediaError(im.dataset.mediaFile,im.dataset.mediaKind,scene);return Promise.resolve();}
  return new Promise((resolve,reject)=>{
    const clean=()=>{clearTimeout(timer);im.removeEventListener('load',loaded);im.removeEventListener('error',failed);signal?.removeEventListener('abort',cancel);};
    const loaded=()=>{clean();resolve();},failed=()=>{clean();mediaError(im.dataset.mediaFile,im.dataset.mediaKind,scene);resolve();},cancel=()=>{clean();reject(abortScene());};
    const timer=setTimeout(failed,15000);im.addEventListener('load',loaded,{once:true});im.addEventListener('error',failed,{once:true});signal?.addEventListener('abort',cancel,{once:true});
  });
}
async function buildPreparedScene(data,signal){
  const target=document.createElement('div');target.style.cssText='width:1920px;height:1080px;position:relative;overflow:hidden';sceneHoldingArea().append(target);
  try{return await renderScene(target,data,signal);}catch(error){target.remove();throw error;}
}
window.setScene=async function(data){
  const generation=++sceneGeneration;sceneLoading=true;
  const {scene:s,still=false,editing=false}=data,spec=videoSpec(data),playing=!!(s.previewPlaying??data.playing);
  playbackIntent=playing;
  const composed=!still&&!editing&&(!!spec||playing),key=composed?scenePreparationKey(data):null;
  preparedScenes.protect(key);let prepared=null,stage=null;
  try{
    if(composed){
      [prepared,stage]=await Promise.all([spec?pool().prepare(spec):Promise.resolve(null),preparedScenes.get(key)||preparedScenes.prepare(key,data)]);
    }else{
      if(spec)prepared=await pool().prepare(spec);
      if(generation!==sceneGeneration)return {ready:false,stale:true};
      for(const video of root.querySelectorAll('video'))videoSync.pause(video);
      if(prepared)pool().activate(spec.key);else videoPool?.deactivate();
      await renderScene(root,data);
    }
  }catch(error){
    if(generation!==sceneGeneration||error.name==='AbortError')return {ready:false,stale:true};
    sceneLoading=false;preparedScenes.protect(null);if(spec)mediaError(spec.file,'video',s);throw error;
  }
  if(generation!==sceneGeneration)return {ready:false,stale:true};
  if(composed){
    preparedScenes.consume(key);preparedScenes.protect(null);
    // All typography, images and card DOM were prepared before the picture cut.
    // Keep #stage itself stable for editing, exports and the parent preview.
    for(const video of root.querySelectorAll('video'))videoSync.pause(video);
    if(prepared)pool().activate(spec.key);else videoPool?.deactivate();
    if(root.className!==stage.className)root.className=stage.className;
    // Preserve the stage transform. The persistent sibling blur surface keeps
    // its active effect while these already prepared scene children change.
    for(let i=0;i<stage.style.length;i++){
      const name=stage.style[i];if(!name.startsWith('--'))continue;
      const value=stage.style.getPropertyValue(name);if(root.style.getPropertyValue(name)!==value)root.style.setProperty(name,value);
    }
    root.replaceChildren(...stage.childNodes);stage.remove();
  }
  state=data;
  if(prepared){prepared.video.dataset.mediaFile=spec.file;root.querySelector('[data-preview-slot]').replaceWith(prepared.video);}
  const v=root.querySelector('video');
  if(v){
    v.muted=true;v.onerror=()=>mediaError(s.file||s.entry?.video,'video',s);v.onended=()=>videoSync.pause(v);
    // Start on the already prepared frame, without another seek or a parent
    // message round trip. A later clock sync corrects small decode drift.
    videoSync.sync(v,v.currentTime,{playing:playing&&playbackIntent});
  }
  showTransition(s.blackOpacity??0,s.blurOpacity??0);fit();sceneLoading=false;
  parent.postMessage({type:'scene-ready',clipId:s.clipId},'*');return {ready:true};
};
root.addEventListener('pointerdown',event=>{
  if(!state?.editing)return;
  const el=event.target.closest('[data-component]');if(!el)return;
  event.preventDefault();root.querySelectorAll('.component-selected').forEach(x=>x.classList.remove('component-selected'));el.classList.add('component-selected');
  const key=el.dataset.component,base=layoutComponent(getLayout(state.project),key);if(!base)return;
  drag={el,key,base,x:event.clientX,y:event.clientY,scale:root.getBoundingClientRect().width/1920,resize:event.target.classList.contains('resize-handle')};
  el.setPointerCapture(event.pointerId);parent.postMessage({type:'layout-select',key},'*');
});
root.addEventListener('pointermove',event=>{
  if(!drag)return;const d=drag,step=state.snap===false?1:10,snap=n=>Math.round(n/step)*step;
  const dx=(event.clientX-d.x)/d.scale,dy=(event.clientY-d.y)/d.scale;
  const patch=d.resize?{w:Math.max(40,Math.min(1920-d.base.x,snap(d.base.w+dx))),h:Math.max(24,Math.min(1080-d.base.y,snap(d.base.h+dy)))}:{x:Math.max(0,Math.min(1920-d.base.w,snap(d.base.x+dx))),y:Math.max(0,Math.min(1080-d.base.h,snap(d.base.y+dy)))};
  for(const [k,v] of Object.entries(patch))d.el.style[{x:'left',y:'top',w:'width',h:'height'}[k]]=v+'px';d.patch=patch;
});
root.addEventListener('pointerup',()=>{if(drag){parent.postMessage({type:'layout-change',key:drag.key,patch:drag.patch||{}},'*');drag=null;}});
addEventListener('message',async({data})=>{
  if(data?.type==='prepare-scene'){
    try{await window.prepareScene(data.payload);parent.postMessage({type:'scene-prepared',clipId:data.payload.scene.clipId},'*');}
    catch(error){if(error.name!=='AbortError')parent.postMessage({type:'scene-prepared',clipId:data.payload.scene.clipId,ready:false},'*');}
  }
  if(data?.type==='scene'){try{await window.setScene(data.payload);}catch{}}
  if(data?.type==='play'){playbackIntent=true;if(!sceneLoading)seekVideo(data.seconds??0,true);}
  if(data?.type==='pause'){playbackIntent=false;const v=root.querySelector('video');if(v)videoSync.pause(v);}
  if(data?.type==='seek'&&!sceneLoading)seekVideo(data.seconds,false,true);
  if(data?.type==='sync'){
    if(sceneLoading)return;
    playbackIntent=!!data.playing;
    showTransition(data.blackOpacity??0,data.blurOpacity??0);
    seekVideo(data.seconds,!!data.playing);
  }
});
addEventListener('pagehide',()=>{preparedScenes.clear();videoPool?.clear();});

import {buildTimeline} from '../shared/core.mjs';
import {mediaUrl} from '../shared/media.mjs';
import {withSceneTransitions,blackOpacity,blurOpacity} from '../shared/transitions.mjs';
import {previewPayload} from './preview-payload.mjs';
import {createPreviewBufferAudio} from './preview-audio.mjs';

// One live element per continuous track; audio playback drives the preview.
export function createTimelinePlayer(hooks){
  let plan=null,cursor=0,end=0,running=false,loading=false,anchor=0,raf=0,sceneId='',frameReady=false,generation=0,signature='',selection='',lastSync=0,lastBlack=-1,lastBlur=-1,destroyed=false;
  const sounds=new Map(),waits=new Set(),normalization=new Map(),preparedScenes=new Set(),decodedTracks=new Map(),bufferJobs=new Map(),bufferFailures=new Set(),previewRequests=new Set();
  let projectSnapshot=null,frameError=null;
  let audioContext=null,mixBus=null,analysisRequest='',audioAnchor=null;
  const audioApi=()=>globalThis.window?.arc;
  const wall=()=>Math.max(0,(performance.now()-anchor)/1000);
  const sceneAt=t=>plan?.scenes.find(s=>t>=s.at-1e-7&&t<s.at+s.duration-1e-7);
  // Intentional pauses are silent even when a legacy/overlay track spans them.
  // With no active audio element, position() falls back to its wall clock.
  const activeAt=t=>sceneAt(t)?.type==='gap'?[]:plan?.audio.filter(a=>t>=a.at-1e-7&&t<a.at+a.duration-1e-7&&t<end)||[];
  const abortError=()=>Object.assign(new Error('预览已停止'),{name:'AbortError'});
  function position(){
    if(!running||loading)return cursor;
    if(audioAnchor!=null)return Math.max(cursor,Math.min(end,audioContext.currentTime-audioAnchor));
    for(const spec of activeAt(cursor).filter(a=>!a.overlay&&!a.loop)){
      const item=sounds.get(spec.id),el=item?.el;
      if(item?.started&&!el.paused&&!el.ended&&!el.seeking&&Number.isFinite(el.currentTime)){
        const t=spec.at+el.currentTime-spec.start;
        // Chromium can briefly report a position before the requested seek
        // target as a newly started local audio clock settles. Playback must
        // not cross a committed picture cut backwards and restart both tracks.
        // Explicit seek/play requests reset cursor separately and can rewind.
        if(t>=spec.at-.1&&t<=spec.at+spec.duration+.1)return Math.max(cursor,Math.min(end,t));
      }
    }
    return Math.max(cursor,Math.min(end,wall()));
  }
  function frameMessage(data){hooks.frame()?.contentWindow.postMessage(data,'*');}
  function pause(){
    if(running)cursor=position();running=false;loading=false;generation++;audioAnchor=null;cancelAnimationFrame(raf);preparedScenes.clear();
    for(const cancel of [...waits])cancel();for(const item of sounds.values()){item.el.pause();item.scheduled=false;item.started=false;item.gainNode?.gain.cancelScheduledValues?.(audioContext?.currentTime||0);}
    for(const id of previewRequests)audioApi()?.cancelPreviewAudio?.(id).catch(()=>{});previewRequests.clear();bufferJobs.clear();
    if(analysisRequest){audioApi()?.cancelLoudness?.(analysisRequest).catch(()=>{});analysisRequest='';}
    hooks.status?.('');
    frameMessage({type:'pause'});hooks.state(false);
  }
  function release(item){item.released=true;item.cancelWarm?.();item.el.pause();item.sourceNode?.disconnect();item.gainNode?.disconnect();if(item.el.dispose)item.el.dispose();else{item.el.removeAttribute('src');item.el.load();}}
  function dispose(){for(const item of sounds.values())release(item);sounds.clear();preparedScenes.clear();decodedTracks.clear();bufferFailures.clear();audioAnchor=null;}
  async function normalizedAudio(token){
    const api=audioApi(),tracks=plan.audio.filter(a=>a.at<end&&a.at+a.duration>cursor);
    if(!tracks.some(a=>a.normalizeAudio)||!api?.loudness)return;
    const id=globalThis.crypto.randomUUID();analysisRequest=id;hooks.status?.('正在统一音轨响度…');
    try{
      const result=await api.loudness(tracks,id);
      if(token!==generation||!running)throw abortError();
      for(const value of result){normalization.set(value.id,value);const item=sounds.get(value.id);if(item)item.normalizationGain=item.el.isPreviewBuffer?value.gain:value.previewGain??value.gain;}
    }finally{if(analysisRequest===id)analysisRequest='';}
  }
  function ensureAudioGraph(){
    const Context=globalThis.AudioContext||globalThis.webkitAudioContext;
    if(!Context)return;
    if(!audioContext){
      audioContext=new Context();mixBus=audioContext.createDynamicsCompressor();
      // A safety ceiling for overlapping animation effects; normal music is
      // statically peak-capped by the offline measurement, below this knee.
      mixBus.threshold.value=-1;mixBus.knee.value=0;mixBus.ratio.value=20;mixBus.attack.value=.005;mixBus.release.value=.05;mixBus.connect(audioContext.destination);
    }
    const unified=plan.audio.some(a=>a.normalizeAudio);mixBus.threshold.value=unified?-1:0;mixBus.ratio.value=unified?20:1;
    for(const item of sounds.values())connectAudio(item);
    return audioContext.resume();
  }
  function connectAudio(item){if(audioContext&&!item.gainNode){if(item.el.isPreviewBuffer)item.gainNode=item.el.connectAudio(mixBus);else{item.sourceNode=audioContext.createMediaElementSource(item.el);item.gainNode=audioContext.createGain();item.sourceNode.connect(item.gainNode);item.gainNode.connect(mixBus);}}}
  function setVolume(spec,t){
    const item=sounds.get(spec.id),level=volume(spec,t)*(item.normalizationGain??1);
    if(item.el.isPreviewBuffer&&item.scheduled)return;
    if(item.gainNode){item.el.volume=1;item.gainNode.gain.value=level;}
    else item.el.volume=Math.min(1,level);
  }
  function fail(error,token){if(token!==generation||error.name==='AbortError')return;pause();hooks.error(error.message||'预览素材无法播放');}
  function prepare(project){
    const next=buildTimeline(project),key=JSON.stringify({audio:next.audio,scenes:next.scenes.map(s=>[s.clipId,s.at,s.duration,s.entry?.start,s.start,s.entry?.video,s.file])});
    if(key!==signature){dispose();normalization.clear();signature=key;}plan={...next,scenes:withSceneTransitions(project,next.scenes)};projectSnapshot=project;
    // Keep only a small local window. Loading all 50 video-backed audio tracks
    // competes with the visible video decoder, especially at a distant seek.
    audioWindow(cursor,false);
  }
  function sound(spec){
    if(sounds.has(spec.id))return sounds.get(spec.id);
    const decoded=decodedTracks.get(spec.id),el=decoded?createPreviewBufferAudio(audioContext,decoded.buffer,{sourceStart:spec.start}):new Audio();el.crossOrigin='anonymous';el.src=mediaUrl(spec.file);el.preload='auto';el.loop=decoded?false:!!spec.loop;
    const gain=normalization.get(spec.id),item={el,started:false,scheduled:false,normalizationGain:decoded?gain?.gain:gain?.previewGain??gain?.gain};sounds.set(spec.id,item);connectAudio(item);
    el.addEventListener('error',()=>{if(running&&activeAt(cursor).some(a=>a.id===spec.id))fail(new Error('配乐无法播放：'+spec.file),generation);});el.load();return item;
  }
  function windowTracks(t){
    const current=plan.audio.filter(a=>a.at<=t+1e-7&&a.at+a.duration>t+1e-7),future=plan.audio.filter(a=>a.at>t+1e-7).slice(0,2),previous=plan.audio.filter(a=>a.at+a.duration<=t+1e-7).at(-1);
    return [...(previous?[previous]:[]),...current,...future];
  }
  function audioWindow(t,prime=true,natural=false){
    const tracks=windowTracks(t),keep=new Set(tracks.map(a=>a.id));
    for(const [id,item]of sounds)if(!keep.has(id)){release(item);sounds.delete(id);}
    for(const id of decodedTracks.keys())if(!keep.has(id))decodedTracks.delete(id);
    for(const spec of tracks){const item=sound(spec);if(prime&&running&&!item.started&&spec.at+spec.duration>t+1e-7){const at=Math.max(t,spec.at),tolerance=natural&&t>=spec.at&&t-spec.at<.15?.15:0;warmAudio(spec,at,generation,tolerance).catch(error=>{if(error.name!=='AbortError')item.warmError=error;});}}
    if(prime&&running&&!loading)prepareDecodedWindow(t,generation).then(()=>scheduleBuffers()).catch(()=>{});
  }
  async function prepareDecodedWindow(t,token){
    const api=audioApi();if(!api?.previewAudio||!audioContext?.decodeAudioData)return;
    const tracks=windowTracks(t).filter(a=>a.at<end&&a.at+a.duration>t&&a.duration<=180&&!decodedTracks.has(a.id)&&!bufferFailures.has(a.id));
    const missing=tracks.filter(a=>!bufferJobs.has(a.id));
    if(missing.length){
      const id=globalThis.crypto.randomUUID();previewRequests.add(id);
      const job=(async()=>{
        const ranges=await api.previewAudio(missing,id);
        if(token!==generation||!running)throw abortError();
        await Promise.all(ranges.map(async range=>{
          const spec=missing.find(a=>a.id===range.id);if(!spec)return;
          const response=await fetch(mediaUrl(range.file));if(!response.ok)throw new Error('预览音轨缓存无法读取');
          const buffer=await audioContext.decodeAudioData(await response.arrayBuffer());
          if(token!==generation||!running)throw abortError();
          if(!windowTracks(cursor).some(a=>a.id===spec.id))return;
          decodedTracks.set(spec.id,{buffer});
          const old=sounds.get(spec.id);if(old&&!old.started){release(old);sounds.delete(spec.id);sound(spec);}
        }));
      })().catch(error=>{if(error.name!=='AbortError'&&token===generation){console.warn('预览音轨预解码失败，改用本地流式播放：',error);for(const spec of missing)bufferFailures.add(spec.id);}}).finally(()=>{previewRequests.delete(id);for(const spec of missing)if(bufferJobs.get(spec.id)===job)bufferJobs.delete(spec.id);});
      for(const spec of missing)bufferJobs.set(spec.id,job);
    }
    await Promise.all(tracks.map(a=>bufferJobs.get(a.id)).filter(Boolean));
  }
  function scheduleGain(spec,item,t,when){
    const gain=item.gainNode?.gain;if(!gain)return;
    const multiplier=item.normalizationGain??1,until=Math.min(end,spec.at+spec.duration),now=audioContext.currentTime;
    gain.cancelScheduledValues(now);gain.setValueAtTime(0,now);gain.setValueAtTime(volume(spec,t)*multiplier,when);
    const phase=Number(spec.fadeOffset||0),duration=Number(spec.fadeDuration)||spec.duration;
    const points=[t,spec.at-phase,spec.at-phase+Number(spec.fadeIn||0),spec.at-phase+duration-Number(spec.fadeOut||0),spec.at-phase+duration,until].filter(v=>v>=t&&v<=until).sort((a,b)=>a-b);
    for(let i=1;i<points.length;i++){
      const left=points[i-1],right=points[i];if(right<=left)continue;
      const steps=spec.fadeCurve==='equal-power'?32:8;
      for(let j=1;j<=steps;j++){const at=left+(right-left)*j/steps;gain.linearRampToValueAtTime(volume(spec,at)*multiplier,when+at-t);}
    }
    gain.setValueAtTime(0,when+until-t);
  }
  function scheduleBuffers(){
    if(!running||loading||audioAnchor==null)return;
    const t=position();
    for(const spec of windowTracks(t)){
      const item=sounds.get(spec.id);if(!item?.el.isPreviewBuffer||item.started||spec.at>=end||spec.at+spec.duration<=t)continue;
      const start=Math.max(t,spec.at),when=audioAnchor+start;
      item.el.currentTime=desired(spec,start,item.el);scheduleGain(spec,item,start,when);item.el.playAt(when);item.started=true;item.scheduled=true;
    }
  }
  function prepareNextScenes(t){
    if(!hooks.frame())return;
    const next=plan.scenes.filter(s=>s.at>t+1e-7&&s.at<end).slice(0,2);
    const keep=new Set(next.map(s=>s.clipId));for(const id of preparedScenes)if(!keep.has(id))preparedScenes.delete(id);
    for(const scene of next)if(!preparedScenes.has(scene.clipId)){preparedScenes.add(scene.clipId);frameMessage({type:'prepare-scene',payload:previewPayload(projectSnapshot,{...scene,previewSeconds:0})});}
  }
  function waitMedia(el,predicate,token,item){
    if(token!==generation||!running||item?.released)return Promise.reject(abortError());if(el.error)return Promise.reject(new Error('音轨无法读取，请检查本地素材。'));if(predicate())return Promise.resolve();
    return new Promise((resolve,reject)=>{
      let timer;const events=['loadedmetadata','loadeddata','canplay','seeked'];
      const clean=()=>{clearTimeout(timer);waits.delete(cancel);if(item?.cancelWarm===cancel)item.cancelWarm=null;for(const name of events)el.removeEventListener(name,check);el.removeEventListener('error',failed);};
      const cancel=()=>{clean();reject(abortError());},failed=()=>{clean();reject(new Error('音轨无法读取，请检查本地素材。'));};
      const check=()=>{if(token!==generation||!running||item?.released)cancel();else if(predicate()){clean();resolve();}};
      waits.add(cancel);if(item)item.cancelWarm=cancel;for(const name of events)el.addEventListener(name,check);el.addEventListener('error',failed,{once:true});
      timer=setTimeout(()=>{clean();reject(new Error('等待本地音轨超时，请检查文件或重新选择素材。'));},15000);check();
    });
  }
  async function warmAudio(spec,t,token,tolerance=0){
    const item=sound(spec),el=item.el,target=Math.max(0,spec.start+t-spec.at);
    if(item.warmPromise&&item.warmToken===token&&Math.abs(item.warmTarget-target)<Math.max(.03,tolerance))return item.warmPromise;
    if(item.warmToken===token&&Math.abs(item.warmTarget-target)<Math.max(.015,tolerance)&&el.readyState>=3&&!el.seeking&&Math.abs(el.currentTime-desired(spec,t,el))<Math.max(.015,tolerance))return;
    item.cancelWarm?.();item.warmToken=token;item.warmTarget=target;item.warmError=null;
    const work=(async()=>{
      await waitMedia(el,()=>el.readyState>=1,token,item);if(item.released||token!==generation||!running)throw abortError();const time=desired(spec,t,el);
      if(Math.abs(el.currentTime-time)>.015)el.currentTime=time;
      await waitMedia(el,()=>el.readyState>=3&&!el.seeking,token,item);
      if(!spec.loop&&Number.isFinite(el.duration)&&time>=el.duration-.002)throw new Error('配乐取用范围超过音轨长度：'+spec.file);
    })();
    item.warmPromise=work;
    try{return await work;}finally{if(item.warmPromise===work)item.warmPromise=null;}
  }
  function waitScene(token){
    if(frameError)return Promise.reject(frameError);
    if(!hooks.waitForSceneReady||!hooks.frame()||frameReady)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      let timer;const id=sceneId;
      const clean=()=>{clearTimeout(timer);waits.delete(cancel);removeEventListener('message',check);};
      const cancel=()=>{clean();reject(abortError());};
      const check=event=>{if(!messageForScene(event,id))return;if(event.data?.type==='scene-ready'){clean();resolve();}else if(event.data?.type==='media-error'&&(!event.data.kind||event.data.kind==='video')){clean();reject(new Error(event.data.message||'预览画面无法读取'));}};
      waits.add(cancel);addEventListener('message',check);timer=setTimeout(()=>{clean();reject(new Error('等待预览画面超时，请检查录像素材。'));},15000);
      if(token!==generation||!running)cancel();else if(frameReady){clean();resolve();}
    });
  }
  function desired(spec,t,el){let value=Math.max(0,spec.start+t-spec.at);if(spec.loop&&!el.isPreviewBuffer&&Number.isFinite(el.duration)&&el.duration>0)value%=el.duration;return value;}
  function volume(spec,t){
    const phase=t-spec.at+Number(spec.fadeOffset||0),duration=Number(spec.fadeDuration)||spec.duration;
    const fi=spec.fadeIn?Math.max(0,Math.min(1,phase/spec.fadeIn)):1,fo=spec.fadeOut?Math.max(0,Math.min(1,(duration-phase)/spec.fadeOut)):1;
    const gain=spec.fadeCurve==='equal-power'?Math.sin(Math.PI/2*fi)*Math.sin(Math.PI/2*fo):fi*fo;
    return Math.max(0,Math.min(1,Number(spec.volume??1)*gain));
  }
  async function startAt(t,token,natural=false){
    loading=true;cursor=t;const active=activeAt(t),needed=new Set(active.map(a=>a.id));
    if(audioAnchor!=null&&active.some(spec=>!spec.overlay&&!sound(spec).el.isPreviewBuffer)){
      // A streaming primary may need to buffer. Cancel both its already-due
      // overlays and later buffers before waiting, so none run on the old clock.
      for(const item of sounds.values())if(item.scheduled){item.el.pause();item.started=false;item.scheduled=false;item.gainNode?.gain.cancelScheduledValues(audioContext.currentTime);}
      audioAnchor=null;
    }
    // A still-valid common track remains the clock through a visual cut or a
    // late overlay. Never pause/restart it to bring a different element online.
    const continuous=active.find(spec=>{const item=sounds.get(spec.id);return !spec.overlay&&!spec.loop&&item?.started&&!item.el.paused&&!item.el.ended&&!item.el.seeking;});
    for(const [id,item]of sounds)if(!needed.has(id)&&!(item.scheduled&&plan.audio.some(a=>a.id===id&&a.at>t&&a.at<end))){item.el.pause();item.started=false;item.scheduled=false;}
    if(!continuous&&!natural)frameMessage({type:'pause'});
    await Promise.all(active.map(async spec=>{
      const item=sound(spec),tolerance=natural&&!item.started&&t>=spec.at&&t-spec.at<.15?.15:0;if(!item.started||item.el.paused)await warmAudio(spec,t,token,tolerance);
      else if(item.el.readyState<3||item.el.seeking)await waitMedia(item.el,()=>item.el.readyState>=3&&!item.el.seeking,token,item);
      setVolume(spec,t);
    }));
    if(!continuous)await waitScene(token);
    if(token!==generation||!running)throw abortError();
    if(continuous){const item=sounds.get(continuous.id);cursor=Math.max(t,Math.min(end,continuous.at+item.el.currentTime-continuous.start));}
    else if(natural){const primary=active.find(spec=>!spec.overlay&&!spec.loop);if(primary)cursor=Math.max(sceneAt(t)?.at??primary.at,primary.at,Math.min(end,primary.at+sounds.get(primary.id).el.currentTime-primary.start));}
    const starting=active.map(spec=>sounds.get(spec.id)).filter(item=>!item.started||item.el.paused);
    const primary=active.filter(spec=>!spec.overlay),clockTracks=primary.length?primary:active;
    const decodedClock=!!audioContext&&clockTracks.every(spec=>sounds.get(spec.id).el.isPreviewBuffer)&&(active.length>0||decodedTracks.size>0);
    if(decodedClock){if(audioAnchor==null)audioAnchor=audioContext.currentTime-cursor;}
    else{
      // A long streaming fallback can buffer at this cut. Future buffers must
      // not continue following its old, now paused timeline anchor.
      if(audioAnchor!=null)for(const spec of plan.audio)if(spec.at>cursor){const item=sounds.get(spec.id);if(item?.scheduled){item.el.pause();item.started=false;item.scheduled=false;item.gainNode?.gain.cancelScheduledValues(audioContext.currentTime);}}
      audioAnchor=null;
    }
    await Promise.all(starting.map(async item=>{
      item.playToken=token;
      if(item.el.isPreviewBuffer&&audioAnchor!=null){const spec=active.find(a=>sounds.get(a.id)===item),when=Math.max(audioContext.currentTime,audioAnchor+cursor);scheduleGain(spec,item,cursor,when);item.el.playAt(when);item.scheduled=true;}
      else await item.el.play();
      if(item.playToken===token)item.started=true;
    }));
    if(token!==generation||!running){for(const item of starting)if(item.playToken===token)item.el.pause();throw abortError();}
    loading=false;anchor=performance.now()-cursor*1000;lastSync=-Infinity;scheduleBuffers();tick();
  }
  function showScene(scene,t){
    if(!scene)return;const seconds=Math.max(0,t-scene.at),opacity=blackOpacity(scene.visualTransition,seconds,scene.duration),blur=blurOpacity(scene.visualTransition,seconds,scene.duration);
    if(scene.clipId!==sceneId){sceneId=scene.clipId;frameReady=false;frameError=null;lastBlack=-1;lastBlur=-1;hooks.scene({...scene,previewSeconds:seconds,previewPlaying:running&&!loading,blackOpacity:opacity,blurOpacity:blur});}
    hooks.time(seconds,scene.duration,t);const time=performance.now();
    // Audio/video sync needs only 10 Hz, but an active visual fade follows each
    // animation frame so short fades do not turn into visible brightness steps.
    if(frameReady&&(time-lastSync>=100||!running||opacity!==lastBlack||blur!==lastBlur)){lastSync=time;lastBlack=opacity;lastBlur=blur;frameMessage({type:'sync',seconds,playing:running&&!loading,blackOpacity:opacity,blurOpacity:blur});}
  }
  function tick(){
    if(!running||loading)return;cursor=Math.min(end,position());anchor=performance.now()-cursor*1000;
    const scene=sceneAt(cursor)||plan.scenes.at(-1);showScene(scene,cursor);
    const active=activeAt(cursor),needed=new Set(active.map(a=>a.id));for(const [id,item]of sounds)if(!needed.has(id)&&!(item.scheduled&&plan.audio.some(a=>a.id===id&&a.at>cursor&&a.at<end))){item.el.pause();item.started=false;item.scheduled=false;}
    if(cursor>=end-1e-5){pause();cursor=end;return;}
    audioWindow(cursor,true,true);prepareNextScenes(cursor);
    if(active.some(spec=>{const item=sounds.get(spec.id);return !item.started||item.el.paused||item.el.readyState<3||item.el.seeking;})){
      const token=generation;startAt(cursor,token,true).catch(error=>fail(error,token));return;
    }
    for(const spec of active){const el=sounds.get(spec.id).el;setVolume(spec,cursor);const target=desired(spec,cursor,el);if((spec.overlay||spec.loop)&&Math.abs(el.currentTime-target)>.12)el.currentTime=target;}
    raf=requestAnimationFrame(tick);
  }
  function seek(t){
    pause();prepare(hooks.project());cursor=Math.max(0,Math.min(plan.duration,Number(t)||0));end=plan.duration;sceneId='';
    showScene(sceneAt(cursor)||plan.scenes.at(-1),cursor);
  }
  async function play({all=false,from,to,project}={}){
    if(destroyed)return;const wasPaused=!!plan,previousCursor=running?position():cursor,previousSelection=selection;pause();prepare(project||hooks.project());
    const current=hooks.current(),key=all?'all':current?.clipId||current?.entry?.id||current?.type||'';selection=key;
    let selected=plan.scenes.find(s=>s.clipId===current?.clipId||current?.entry?.id&&s.entry?.id===current.entry.id)||current||plan.scenes[0];
    if(selected?.type==='gap')selected=plan.scenes.find(s=>s.clipId===selected.incomingClipId)||plan.scenes.find(s=>s.type!=='gap');
    // An explicit end is the splice-audition range, which may begin in the
    // previous clip or its gap. Ordinary single-clip playback stays in its clip.
    const left=all||to!=null?0:selected?.at||0,right=all||selected?.type==='overview'?plan.duration:left+(selected?.duration||0);
    end=Math.min(plan.duration,to??right);cursor=Math.max(left,Math.min(end,from??(wasPaused&&previousSelection===key&&previousCursor>=left&&previousCursor<end?previousCursor:left)));
    if(!plan.scenes.length||end<=cursor)return;
    const badGroup=plan.issues.find(i=>i.code==='group-range');
    if(badGroup){hooks.error(badGroup.message);return;}
    const badAudio=plan.audio.find(a=>a.at<end&&a.at+a.duration>cursor&&(!Number.isFinite(a.start)||a.start+Math.max(0,cursor-a.at)<-1e-7));
    if(badAudio){hooks.error('预览范围需要音源开始之前的声音，请调整取音点或片段时长：'+badAudio.file);return;}
    const badVideo=plan.scenes.find(s=>s.at<end&&s.at+s.duration>cursor&&(s.entry?.video||s.type==='animation'&&s.file)&&Number(s.entry?.start??s.start??0)+Math.max(0,cursor-s.at)<-1e-7);
    if(badVideo){hooks.error('预览范围的录像入点在素材开始之前，请调整音画偏移或取用范围。');return;}
    const token=++generation;sceneId='';running=true;loading=true;hooks.state(true);audioWindow(cursor);showScene(sceneAt(cursor)||plan.scenes.at(-1),cursor);prepareNextScenes(cursor);
    try{
      // Resume from the user gesture before awaiting the offline analysis.
      await ensureAudioGraph();if(token!==generation||!running)throw abortError();
      await normalizedAudio(token);if(token!==generation||!running)throw abortError();
      if(audioApi()?.previewAudio&&audioContext?.decodeAudioData){hooks.status?.('正在准备流畅预览音轨…');await prepareDecodedWindow(cursor,token);if(token!==generation||!running)throw abortError();}
      hooks.status?.('');await startAt(cursor,token);
    }catch(error){fail(error,token);}
  }
  function messageForScene(event,id=sceneId){
    if(event.source!==hooks.frame()?.contentWindow)return false;
    const data=event.data;if(data?.clipId)return data.clipId===id;
    if(data?.sceneId){const scene=plan?.scenes.find(scene=>scene.clipId===id);return [id,scene?.id,scene?.entry?.id].includes(data.sceneId);}
    return true;
  }
  function onMessage(event){
    if(!messageForScene(event))return;
    if(event.data?.type==='media-error'&&(!event.data.kind||event.data.kind==='video')){frameError=new Error(event.data.message||'预览画面无法读取');return;}
    if(event.data?.type!=='scene-ready')return;
    frameReady=true;
    // The prepared decoder already holds the requested picture. While the
    // incoming audio is still starting, cursor may include a few milliseconds
    // of the previous clock's scheduling delay. A paused sync here would seek
    // that decoder again and discard its ready frame before startAt settles.
    if(running&&loading)return;
    const scene=plan?.scenes.find(s=>s.clipId===sceneId);if(scene){const seconds=Math.max(0,position()-scene.at),opacity=blackOpacity(scene.visualTransition,seconds,scene.duration),blur=blurOpacity(scene.visualTransition,seconds,scene.duration);lastBlack=opacity;lastBlur=blur;frameMessage({type:'sync',seconds,playing:running,blackOpacity:opacity,blurOpacity:blur});}
  }
  addEventListener('message',onMessage);
  return {play,pause,seek,get running(){return running;},get cursor(){return position();},destroy(){destroyed=true;pause();dispose();mixBus?.disconnect();audioContext?.close().catch(()=>{});removeEventListener('message',onMessage);}};
}

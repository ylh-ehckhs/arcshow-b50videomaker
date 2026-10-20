const aborted=()=>Object.assign(new Error('预览准备已取消'),{name:'AbortError'});

/** A bounded pool of muted, already-seeked local video decoders. */
export function createPreviewVideoPool({createVideo,hold,maxEntries=3,timeoutMs=15000}){
  const entries=new Map();let active=null,stamp=0;
  const capacity=Math.max(1,Math.trunc(maxEntries)||3);
  function release(entry){
    if(entry.released)return;entry.released=true;entry.ready=false;
    entry.cancel?.();entry.video.pause();entry.video.removeAttribute('src');entry.video.load();entry.video.remove?.();
    if(active===entry)active=null;
  }
  function trim(){
    while(entries.size>capacity){const candidate=[...entries.values()].filter(entry=>entry!==active).sort((a,b)=>a.used-b.used)[0];if(!candidate)break;entries.delete(candidate.key);release(candidate);}
  }
  function wait(entry,predicate){
    const video=entry.video;
    if(entry.released)return Promise.reject(aborted());
    if(video.error)return Promise.reject(new Error('预览录像无法读取：'+entry.src));
    if(predicate())return Promise.resolve();
    return new Promise((resolve,reject)=>{
      let timer;const events=['loadedmetadata','loadeddata','canplay','seeked'];
      const clean=()=>{clearTimeout(timer);if(entry.cancel===cancel)entry.cancel=null;for(const event of events)video.removeEventListener(event,check);video.removeEventListener('error',fail);};
      const cancel=()=>{clean();reject(aborted());},fail=()=>{clean();reject(new Error('预览录像无法读取：'+entry.src));};
      const check=()=>{if(entry.released)cancel();else if(predicate()){clean();resolve();}};
      entry.cancel=cancel;for(const event of events)video.addEventListener(event,check);video.addEventListener('error',fail,{once:true});
      timer=setTimeout(()=>{clean();reject(new Error('等待预览录像超时：'+entry.src));},timeoutMs);check();
    });
  }
  function readyEntry(entry,target){
    const video=entry.video;entry.ready=false;entry.requestedTime=target;
    entry.promise=(async()=>{
      await wait(entry,()=>video.readyState>=1);if(entry.released)throw aborted();
      entry.time=Number.isFinite(video.duration)&&video.duration>0?Math.min(target,Math.max(0,video.duration-.001)):target;
      if(Math.abs(video.currentTime-entry.time)>.001)video.currentTime=entry.time;
      await wait(entry,()=>video.readyState>=3&&!video.seeking);if(entry.released)throw aborted();
      entry.ready=true;return entry;
    })().catch(error=>{if(entries.get(entry.key)===entry){entries.delete(entry.key);release(entry);}throw error;});
    // An evicted speculative request may have no consumer yet. Keep its original
    // rejected promise observable, while preventing an unhandled rejection.
    entry.promise.catch(()=>{});return entry.promise;
  }
  function prepare({key,src,time=0,tolerance=0}){
    const target=Math.max(0,Number(time)||0),limit=Math.max(.001,Number(tolerance)||0),previous=entries.get(key);
    if(previous&&!previous.released&&previous.src===src&&Math.abs(previous.requestedTime-target)<=limit){
      previous.used=++stamp;
      // A cached decoder may have played forward since its preparation. Rewind
      // that same decoder and wait again before reporting the frame as ready.
      if(previous.ready&&Math.abs(previous.video.currentTime-target)>limit){previous.video.pause();return readyEntry(previous,target);}
      return previous.promise;
    }
    if(previous){entries.delete(key);release(previous);}
    const video=createVideo();video.muted=true;video.playsInline=true;video.preload='auto';
    const entry={key,video,src,time:target,requestedTime:target,ready:false,released:false,used:++stamp,cancel:null,promise:null};
    entries.set(key,entry);video.src=src;hold(video);video.load();
    const promise=readyEntry(entry,target);trim();return promise;
  }
  function deactivate(){if(active){active.video.pause();hold(active.video);active=null;}}
  function activate(key){const entry=entries.get(key);if(!entry||entry.released)return null;if(active!==entry){deactivate();active=entry;}entry.used=++stamp;return entry;}
  return {prepare,activate,deactivate,clear(){for(const entry of entries.values())release(entry);entries.clear();active=null;},get size(){return entries.size;}};
}

/** Keep a muted video near the audio clock without repeated decoder seeks. */
export function createVideoSynchronizer({now=()=>performance.now()}={}){
  const states=new WeakMap();
  function state(video){if(!states.has(video))states.set(video,{lastSeek:-Infinity,driftSince:null,playToken:0,playPromise:null,wantPlaying:false});return states.get(video);}
  function pause(video){
    if(!video)return;const item=state(video);item.wantPlaying=false;item.playToken++;item.driftSince=null;video.pause();video.playbackRate=1;
  }
  function play(video,item){
    item.wantPlaying=true;if(!video.paused||item.playPromise)return;
    const token=++item.playToken;let result;
    try{result=video.play();}catch{return;}
    const pending=Promise.resolve(result).then(()=>{if(item.playToken!==token||!item.wantPlaying)video.pause();}).catch(()=>{}).finally(()=>{if(item.playPromise===pending)item.playPromise=null;});item.playPromise=pending;
  }
  function sync(video,target,{playing=false,force=false}={}){
    if(!video)return;const item=state(video);video.muted=true;
    const seconds=Math.max(0,Number(target)||0),at=now(),drift=seconds-video.currentTime;
    if(!playing)pause(video);
    // currentTime writes during a pending seek repeatedly discard the very
    // frame Chromium is trying to decode. A later sync will use the newest time.
    if(video.seeking||video.readyState<2){item.driftSince=null;if(playing)play(video,item);return;}
    if(!playing||force){
      if(Math.abs(drift)>.001){video.currentTime=seconds;item.lastSeek=at;}
      item.driftSince=null;video.playbackRate=1;
    }else if(Math.abs(drift)>.6){
      item.driftSince??=at;
      if(at-item.driftSince>=250&&at-item.lastSeek>=1000){video.currentTime=seconds;item.lastSeek=at;item.driftSince=null;video.playbackRate=1;}
      else video.playbackRate=Math.max(.97,Math.min(1.03,1+drift*.1));
    }else{
      item.driftSince=null;video.playbackRate=Math.abs(drift)<.02?1:Math.max(.97,Math.min(1.03,1+drift*.1));
    }
    if(playing)play(video,item);
  }
  return {sync,pause,reset(video){if(!video)return;pause(video);const item=state(video);item.lastSeek=-Infinity;item.driftSince=null;}};
}

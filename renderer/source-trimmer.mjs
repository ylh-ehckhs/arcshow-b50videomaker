const finite=value=>Number.isFinite(Number(value));
const seconds=value=>Number(value||0).toFixed(3);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

// Every visual uses the same media-time domain. Keep the requested cut separate
// from the native inputs: Chromium clamps input.value when max is still a guess.
export function trimRange(start,end,duration){
  start=Math.max(0,Number(start)||0);end=Math.max(start,Number(end)||0);
  const max=finite(duration)&&Number(duration)>0?Number(duration):Math.max(60,end);
  return {start,end,max,left:clamp(start/max,0,1),right:clamp(end/max,0,1)};
}

export function moveTrimHandle(range,key,value){
  const span=Math.min(.5,range.max),start=clamp(range.start,0,range.max-span),end=clamp(range.end,start+span,range.max);
  return key==='trim-in'
    ?{start:clamp(Number(value)||0,Math.max(0,end-600),end-span),end}
    :{start,end:clamp(Number(value)||0,start+span,Math.min(range.max,start+600))};
}

export function createSourceTrimmer({root,video,onPlay=()=>{},onError=()=>{},onMetadata=()=>{},requestFrame=fn=>requestAnimationFrame(fn),cancelFrame=id=>cancelAnimationFrame(id)}){
  const first=root.querySelector('[data-wb="trim-in"]'),last=root.querySelector('[data-wb="trim-out"]'),region=root.querySelector('.trim-selection'),label=root.querySelector('#source-range-label'),button=root.querySelector('[data-action="wb-source-loop"]');
  const listeners=[];let range=trimRange(0,0),disposed=false,loop=false,frame=null,loopFrame=null,pendingSeek=null,ownSeek=false,resume=false,epoch=0,playPending=null,metadataReady=false;
  const listen=(target,event,handler)=>{if(target){target.addEventListener(event,handler);listeners.push(()=>target.removeEventListener(event,handler));}};
  const paint=()=>{
    for(const [input,value] of [[first,range.start],[last,range.end]])if(input){input.min='0';input.max=String(range.max);input.value=String(clamp(value,0,range.max));input.setAttribute('aria-valuetext',seconds(value)+' 秒');}
    if(region){region.style.left=range.left*100+'%';region.style.width=(range.right-range.left)*100+'%';}
    if(label)label.textContent=seconds(range.start)+' → '+seconds(range.end)+' / '+seconds(range.max)+' 秒'+(range.end>range.max+.001?'（超出原片范围）':'');
    if(button){button.textContent=loop?'停止循环':'循环选区';button.setAttribute('aria-pressed',String(loop));}
  };
  function stopLoop(){loop=false;resume=false;if(loopFrame!==null){cancelFrame(loopFrame);loopFrame=null;}paint();}
  function pause(){epoch++;playPending=null;stopLoop();pendingSeek=null;if(frame!==null){cancelFrame(frame);frame=null;}video.pause();}
  function play(){
    if(disposed||!loop||playPending)return;
    const token=epoch;let attempt;
    try{attempt=video.play();}catch(error){stopLoop();onError(error.message);return;}
    const pending=Promise.resolve(attempt);playPending=pending;
    pending.then(()=>{if(disposed||token!==epoch&&!loop)video.pause();},error=>{
      if(!disposed&&token===epoch&&error.name!=='AbortError'){stopLoop();onError(error.message);}
    }).finally(()=>{if(playPending===pending)playPending=null;});
  }
  function flush(){
    frame=null;if(disposed||pendingSeek===null||video.seeking||ownSeek||video.readyState<1)return;
    const time=pendingSeek;pendingSeek=null;
    if(Math.abs(video.currentTime-time)<.001){if(resume){resume=false;play();}return;}
    ownSeek=true;try{video.currentTime=time;}catch(error){ownSeek=false;resume=false;stopLoop();onError(error.message);}
  }
  function seek(time){
    if(disposed||!finite(time))return;
    const max=finite(video.duration)&&video.duration>0?video.duration:range.max;
    pendingSeek=clamp(Number(time),0,Math.max(0,max-.001));
    if(frame===null)frame=requestFrame(flush);
  }
  function update({start=range.start,end=range.end,duration,seekTo}={}){
    const max=duration??(finite(video.duration)&&video.duration>0?video.duration:range.max);
    range=trimRange(start,end,max);paint();
    if(finite(seekTo))seek(seekTo);
  }
  function metadata(){
    if(disposed||!finite(video.duration)||video.duration<=0)return;
    update({duration:video.duration});onMetadata(video.duration);
    if(!metadataReady){metadataReady=true;seek(pendingSeek??range.start);}
  }
  function boundary(){
    if(disposed||!loop||video.seeking||ownSeek||pendingSeek!==null||video.paused)return;
    // Do not rebuild the whole film or keep seeking while a decoder is busy.
    if(video.currentTime>=Math.min(range.end,range.max)-.001){resume=true;seek(range.start);}
  }
  function watchLoop(){
    if(disposed||!loop||video.paused||loopFrame!==null)return;
    loopFrame=requestFrame(()=>{
      loopFrame=null;boundary();
      if(!video.seeking&&!ownSeek&&pendingSeek===null)watchLoop();
    });
  }
  listen(video,'loadedmetadata',metadata);listen(video,'durationchange',()=>{if(video.readyState>=1)metadata();});
  listen(video,'seeked',()=>{
    ownSeek=false;
    if(pendingSeek!==null){if(frame===null)frame=requestFrame(flush);return;}
    if(loop&&resume){resume=false;play();}
    watchLoop();
  });
  listen(video,'timeupdate',boundary);
  listen(video,'ended',()=>{if(loop&&!disposed){resume=true;seek(range.start);}});
  listen(video,'pause',()=>{epoch++;playPending=null;if(!video.ended)stopLoop();});
  listen(video,'play',()=>{if(disposed){video.pause();return;}onPlay();watchLoop();});
  for(const input of [first,last])listen(input,'input',()=>{
    const value=input.value;pause();const moved=moveTrimHandle(range,input.dataset.wb,value);
    update(moved);seek(input.dataset.wb==='trim-in'?moved.start:moved.end);
  });
  paint();
  return {
    update,seek,pause,
    toggleLoop(){
      if(disposed)return;
      if(loop){pause();return;}
      epoch++;loop=true;resume=true;video.muted=false;onPlay();paint();seek(range.start);
    },
    get looping(){return loop;},
    dispose(){if(disposed)return;disposed=true;pause();for(const remove of listeners)remove();}
  };
}

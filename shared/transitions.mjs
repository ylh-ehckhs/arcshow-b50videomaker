// Visual transitions belong to the incoming clip. They never alter source
// positions, scene lengths or audio tracks.
export const MAX_TRANSITION=5;
const boundedDuration=(value,fallback=.8)=>{
  const number=Number(value);
  return value!==''&&value!=null&&Number.isFinite(number)?Math.max(0,Math.min(MAX_TRANSITION,number)):fallback;
};
export function transitionFor(project,clipId){
  const settings=project?.settings||{},overrides=settings.sceneTransitions||{};
  const key=String(clipId||'').startsWith('overview:')?'overview:1':clipId;
  const override=overrides[clipId]??overrides[key];
  const inherited=override?.mode==null&&override?.duration==null,mode=override?.mode==='cut'?'cut':'black';
  return {mode,duration:mode==='cut'?0:boundedDuration(override?.duration,boundedDuration(settings.transition)),inherited};
}
export function sceneTransitions(project,scenes){
  const result=scenes.map(()=>({fadeIn:0,fadeOut:0}));
  const fps=Number(project?.settings?.fps)||60;
  const blurJoin=(previous,index,duration)=>{
    const frames=Math.round(duration*fps),out=Math.min(Math.floor(frames/2),Math.floor(scenes[previous].duration*fps/2+1e-7)),enter=Math.min(Math.ceil(frames/2),Math.floor(scenes[index].duration*fps/2+1e-7));
    if(out>0)result[previous].blurOut=out/fps;
    if(enter>0)result[index].blurIn=enter/fps;
  };
  for(let index=1;index<scenes.length;index++){
    if(scenes[index].type==='gap')continue;
    // Overview page turns blur the complete frame, with uninterrupted music.
    // This replaces page-to-page black fades and consumes no extra film time.
    if(scenes[index-1].type==='overview'&&scenes[index].type==='overview'){
      blurJoin(index-1,index,boundedDuration(project?.settings?.overviewBlur,.5));
      continue;
    }
    const incoming=transitionFor(project,scenes[index].clipId);
    const direct=scenes[index].connectedFromPrevious&&incoming.inherited||incoming.mode==='cut'||incoming.duration<=0;
    if(direct){
      // A picture-only cue when a song or unlock animation cuts into gameplay.
      // Music and clip lengths stay unchanged; gaps and overview pages are excluded.
      if(scenes[index].type==='song'&&['song','animation'].includes(scenes[index-1].type)){
        blurJoin(index-1,index,boundedDuration(project?.settings?.cutBlur,.3));
      }
      continue;
    }
    const previous=scenes[index-1].type==='gap'?index-2:index-1;
    if(previous<0)continue;
    // The total transition is split around the existing picture cut. Limit
    // each side to half its scene so adjacent transitions cannot overlap.
    const frames=Math.min(Math.round(incoming.duration/2*fps),Math.floor(scenes[previous].duration*fps/2+1e-7),Math.floor(scenes[index].duration*fps/2+1e-7));
    if(frames<=0)continue;
    result[previous].fadeOut=frames/fps;
    result[index].fadeIn=frames/fps;
  }
  return result;
}
export function withSceneTransitions(project,scenes){
  const fades=sceneTransitions(project,scenes);
  return scenes.map((scene,index)=>({...scene,visualTransition:fades[index]}));
}
export function blackOpacity(transition,seconds,duration){
  const time=Math.max(0,Number(seconds)||0),length=Math.max(0,Number(duration)||0);
  const fadeIn=Math.max(0,Number(transition?.fadeIn)||0),fadeOut=Math.max(0,Number(transition?.fadeOut)||0);
  const entering=fadeIn>0?1-time/fadeIn:0;
  const leaving=fadeOut>0?1-(length-time)/fadeOut:0;
  return Math.max(0,Math.min(1,Math.max(entering,leaving)));
}
export function ffmpegFadeFilters(transition,duration){
  const fadeIn=Math.max(0,Number(transition?.fadeIn)||0),fadeOut=Math.max(0,Number(transition?.fadeOut)||0);
  return [fadeIn>0?`fade=t=in:st=0:d=${fadeIn}`:'',fadeOut>0?`fade=t=out:st=${Math.max(0,duration-fadeOut)}:d=${fadeOut}`:''].filter(Boolean);
}
export function blurOpacity(transition,seconds,duration){
  return blackOpacity({fadeIn:transition?.blurIn,fadeOut:transition?.blurOut},seconds,duration);
}
export function ffmpegVisualFilters(transition,duration,input='scaled',output='v',scale=1){
  const fade=ffmpegFadeFilters(transition,duration),fi=Number(transition?.blurIn)||0,fo=Number(transition?.blurOut)||0;
  const finish=fade.length?fade.join(','):'null';
  if(!fi&&!fo)return [`[${input}]${finish}[${output}]`];
  const amount=[fi?`max(0,1-T/${fi})`:'0',fo?`max(0,1-(${duration}-T)/${fo})`:'0'];
  const envelope=`min(1,max(${amount.join(',')}))`,enable=[fi?`lt(t,${fi})`:'0',fo?`gt(t,${Math.max(0,duration-fo)})`:'0'].join('+');
  return [`[${input}]split=2[sharp][blursource]`,`[blursource]gblur=sigma=${12*scale}:steps=2:enable='${enable}'[soft]`,`[sharp][soft]blend=all_expr='A*(1-(${envelope}))+B*(${envelope})':enable='${enable}',${finish}[${output}]`];
}

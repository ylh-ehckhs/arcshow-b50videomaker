import {ensureSequence,resetSequence,buildTimeline,ranked,escapeHtml as h} from '../shared/core.mjs';
import {entryAudioSource} from '../shared/timeline.mjs';
import {mediaUrl} from '../shared/media.mjs';
import {transitionFor} from '../shared/transitions.mjs';
import {textStyleView,bindTextStyleEditor} from './text-style-editor.mjs';
import {createSourceTrimmer,trimRange} from './source-trimmer.mjs';
const sec=n=>Number(n||0).toFixed(3);
const name=file=>String(file||'').split(/[\\/]/).pop();
const btn=(a,text,extra='',cls='outline')=>`<button class="btn ${cls}" data-action="wb-${a}" ${extra}>${text}</button>`;
const select=(key,value,items)=>`<select data-wb="${key}">${items.map(([k,v])=>`<option value="${k}" ${k===String(value)?'selected':''}>${v}</option>`).join('')}</select>`;
const timeKeys=new Set(['start','end','duration','audioStart','groupStart','offset','transitionDuration','transitionAudioDuration','transitionGapDuration']);
const input=(label,key,value,attrs='')=>`<label class="field"><span>${label}</span><input data-wb="${key}" ${timeKeys.has(key)?'data-time="true"':''} value="${h(value??'')}" type="number" ${/\bstep\s*=/.test(attrs)?'':'step="0.1"'} ${attrs}></label>`;
const pick=(key,label,file,kind)=>`<div class="file-row"><span>${label}</span><div>${btn('pick',file?'✓ '+h(name(file)):'＋ 选择本地文件',`data-key="${key}" data-kind="${kind}" title="${h(file)}"`)}${file?btn('clear','移除',`data-key="${key}"`,'quiet'):''}</div></div>`;
const mediaCache=new Map();
let trimmer=null,trimmerVideo=null,waveCleanups=[];
export function disposeWorkbench(){trimmer?.dispose();trimmer=null;trimmerVideo=null;for(const cleanup of waveCleanups.splice(0))cleanup();}
export function pauseWorkbench(){trimmer?.pause();}
export function resetWorkbenchHistory(){undo=[];alignment=null;mediaCache.clear();}
let alignment=null,busy=false,lastKey='',undo=[],dragId='',hooks;
export function clipFor(p,id){return ensureSequence(p).find(c=>c.id===id);}
const choose=kind=>hooks?.pick?hooks.pick(kind):window.arc.pick(kind);
const groupFor=(p,id)=>(p.audioGroups||[]).find(g=>g.clipIds.includes(id));
export function timelineCards(p,selected){
  const plan=buildTimeline(p),content=plan.scenes.filter(s=>['song','animation','gap'].includes(s.type));
  const fixed=(id,title,duration,detail)=>`<button data-clip-id="${id}" data-action="wb-select" class="timeline-chip fixed ${selected===id||id==='overview:1'&&selected?.startsWith('overview:')?'selected':''}"><span>${title}${duration>0?'':' · 已关闭'}</span><strong>${detail}</strong><small>${sec(duration)} 秒</small></button>`;
  return content.map(s=>s.type==='gap'?`<div data-gap-id="${h(s.clipId)}" class="timeline-chip gap"><span>黑屏 · 静音</span><strong>留白 ${sec(s.duration)} 秒</strong><small>在下一卡片中调整</small></div>`:`<button draggable="true" data-clip-id="${h(s.clipId)}" data-action="wb-select" class="timeline-chip ${s.type} ${s.clipId===selected?'selected':''}"><span>${s.entry?'B'+String(s.entry.rank).padStart(2,'0')+' · '+h(s.entry.difficulty):'动画'} ${s.audioGroupId?'<b class="link-indicator">↔</b>':''}</span><strong>${h(s.entry?.title||name(s.file))}</strong><small>${sec(s.duration)} 秒</small></button>`).join('')+fixed('overview:1','结尾总览',p.settings.overview,`${Math.max(1,Math.ceil(ranked(p).length/10))} 页分表`);
}
const globalSetting=(p,label,key,attrs)=>`<label class="field"><span>${label}</span><input data-setting="${key}" ${key==='volume'?'':'data-time="true"'} type="number" value="${p.settings[key]}" ${attrs}></label>`;
function timingPanel(p){return `<details class="workbench-global"><summary>全片时间与声音</summary><div class="clip-fields">${globalSetting(p,'独立片段之间留白（秒）','segmentGap','min="0" max="5" step=".1"')}${globalSetting(p,'画面淡出＋淡入（共计秒数）','transition','min="0" max="5" step=".1"')}${globalSetting(p,'谱面切换模糊（共计秒数，0 关闭）','cutBlur','min="0" max="1" step=".1"')}${globalSetting(p,'音乐淡出／淡入（每侧秒数）','audioTransition','min="0" max="2" step=".1"')}${globalSetting(p,'整体音量（0–1）','volume','min="0" max="1" step=".05"')}${globalSetting(p,'默认单曲时长（秒）','defaultDuration','min=".5" max="600" step=".1"')}<label class="checkbox"><input data-setting="normalizeAudio" type="checkbox" ${p.settings.normalizeAudio!==false?'checked':''}>统一配乐响度</label><label class="checkbox"><input data-setting="videoAudio" type="checkbox" ${p.settings.videoAudio?'checked':''}>无独立音频时使用录像原声</label><button class="btn outline" data-action="apply-duration">应用默认时长到全部曲目</button></div><p>配乐先统一至 −16 LUFS 基准，再应用整体音量；连续配乐整组处理，叠加音效保留手动混音比例。首次预览会在本机分析并缓存。歌曲之间、动画切入谱面的连续直切默认有 0.3 秒模糊提示，不延长影片或打断音乐。留白为额外黑屏静音，淡入淡出在片段内部完成。</p></details>`;}
function transitionEditor(p,id){
  const current=transitionFor(p,id),mode=current.inherited?'inherit':current.mode,override=p.settings.sceneTransitions?.[id]||{},scene=buildTimeline(p).scenes.find(s=>s.clipId===id),connected=scene?.connectedFromPrevious;
  return `<div class="clip-transition"><div class="clip-fields"><label class="field"><span>与上一段的画面转场</span>${select('transitionMode',mode,[['inherit','自动（连接内直切）'],['black','黑场淡出 / 淡入'],['cut','直接切换（0 秒）']])}</label>${input('画面淡出＋淡入（共计秒数）','transitionDuration',sec(current.duration),`min="0" max="5" ${mode==='cut'?'disabled':''}`)}${input('本次段间留白（秒）','transitionGapDuration',override.gapDuration??'',`min="0" max="5" placeholder="${connected?'已连接，不留白':'全片默认 '+(p.settings.segmentGap??0)+' 秒'}" ${connected||mode==='cut'?'disabled':''}`)}${input('音乐淡出／淡入（每侧秒数）','transitionAudioDuration',override.audioDuration??'',`min="0" max="2" placeholder="${connected?'共同配乐保持连续':'全片默认 '+p.settings.audioTransition+' 秒'}" ${connected?'disabled':''}`)}</div><p>${connected?'当前接点已连接：不插入留白，共同音源连续播放。':'独立片段：先淡出，再黑屏静音留白，最后下一段淡入。'}留白可单独调整，填 0 取消；音乐留空跟随全片，填 0 关闭音乐淡化。第一段没有前置转场。</p></div>`;
}
function bookendEditor(p,id){
  const count=ranked(p).length||Number(p.settings.count)||50;
  return `<section class="clip-editor bookend-editor"><div class="trim-heading"><h3>结尾总览</h3></div><div class="clip-fields">${globalSetting(p,'每页总览时长（秒，0 为关闭）','overview','min="0" max="60" step=".1"')}${globalSetting({settings:{overviewBlur:p.settings.overviewBlur??.5}},'总览翻页模糊（共计秒数，0 关闭）','overviewBlur','min="0" max="5" step=".1"')}<label class="field"><span>总览排列（按 Potential）</span><select data-setting="overviewOrder"><option value="descending" ${p.settings.overviewOrder!=='ascending'?'selected':''}>正向：#1 → #${count}（从高到低）</option><option value="ascending" ${p.settings.overviewOrder==='ascending'?'selected':''}>逆向：#${count} → #1（从低到高）</option></select></label><label class="field"><span>玩家名称</span><input data-project="player" value="${h(p.player)}" type="text" maxlength="60"></label></div>${transitionEditor(p,'overview:1')}<p>配乐延续实际最后一首歌曲。翻页模糊不增加时长；进入总览的画面转场只影响第一页。总览排列独立于单曲剪辑顺序，保留各曲 Best 排名。组件样式在“视频布局”调整。</p></section>`;
}
export function workbenchView(p,id){
  const plan=buildTimeline(p),c=clipFor(p,id),scene=plan.scenes.find(s=>s.clipId===id),e=c?.type==='song'?p.entries.find(e=>e.id===c.entryId):null;
  const excluded=ranked(p).filter(e=>(p.excludedEntryIds||[]).includes(e.id));
  const toolbar=`<div class="workbench-toolbar"><div>${btn('insert','＋ 插入动画')}${btn('reset','重置倒序','data-order="countdown"','quiet')}${btn('reset','重置正序','data-order="ascending"','quiet')}${btn('undo','撤销剪辑',undo.length?'':'disabled','quiet')}</div><div>${excluded.length?`<label>重新加入影片 <select data-wb="restore"><option value="">选择成绩</option>${excluded.map(e=>`<option value="${e.id}">${h(e.title)} ${e.difficulty}</option>`).join('')}</select></label>`:''}</div></div>`;
  const global=timingPanel(p);
  if(id?.startsWith('overview:'))return toolbar+bookendEditor(p,id)+global;
  if(!c||!scene)return toolbar+global+(plan.issues.length?`<div class="timeline-warning">${plan.issues.map(i=>h(i.message)).join('<br>')}</div>`:'');
  const target=e||c,file=e?.video||c.file,start=scene.entry?.start??c.start??0,duration=target.duration,probe=mediaCache.get(file)||e?.probe,max=probe?.videoDuration||probe?.duration||Math.max(60,start+duration);
  const g=groupFor(p,id),source=g?.source||(e?entryAudioSource(e,p)?.file:'')||'',music=plan.audio.find(a=>a.clipIds?.includes(id)&&a.kind!=='animation-original');
  return `${toolbar}<section class="clip-editor"><div class="trim-heading"><h3>${h(e?e.title+' · '+e.difficulty:'动画 · '+name(c.file))}</h3><div class="clip-actions">${btn('left','← 左移')}${btn('right','右移 →')}${e?btn('edit','编辑成绩'):''}${btn('remove','从影片移除','','quiet')}</div></div>
  ${transitionEditor(p,id)}<div class="clip-media-grid">${pick(e?'video':'file',e?'谱面录像':'动画视频',file,'video')}${e?pick('audio','独立音频',e.audio,'audio')+pick('jacket','本曲图片（供图片组件使用）',e.jacket,'image')+pick('background','本曲背景（未选时继承全局）',e.background,'image'):pick('effectFile','额外音效',c.effectFile,'audio')}</div>${e?textStyleView(p,e):''}
  ${file?`<div class="source-trimmer"><div class="source-clip-preview"><video id="source-video" src="${h(mediaUrl(file))}" preload="metadata" muted controls></video><small>查看原始文件，选择要保留的开始和结束时间</small></div><div class="source-waveform"><div class="waveform-wrap"><canvas id="source-wave"></canvas><div class="trim-selection" style="left:${trimRange(start,start+duration,max).left*100}%;width:${(trimRange(start,start+duration,max).right-trimRange(start,start+duration,max).left)*100}%"></div></div><div class="trim-handles"><input aria-label="开始时间" data-wb="trim-in" type="range" min="0" max="${max}" step=".001" value="${start}"><input aria-label="结束时间" data-wb="trim-out" type="range" min="0" max="${max}" step=".001" value="${start+duration}"></div><div class="trim-range-label"><span>0:00</span><span id="source-range-label">${sec(start)} → ${sec(start+duration)} / ${sec(max)} 秒</span></div><div class="clip-actions">${btn('mark-in','从当前画面开始')}${btn('mark-out','到当前画面结束')}${btn('source-loop','循环选区','aria-pressed="false"')}</div></div></div>`:''}
  <p class="time-edit-help">时间均对应原始文件。直接输入秒数，回车或离开输入框保存；↑↓ 调整 0.1 秒，Shift + ↑↓ 调整 1 秒，Alt + ↑↓ 微调 0.001 秒。开始和结束时间决定保留范围。</p>
  <div class="clip-fields">${input('视频开始时间（秒）','start',sec(start),'min="0"')}${input('视频结束时间（秒）','end',sec(start+duration),'min="0"')}${input('播放时长（秒）','duration',sec(duration),'min=".5" max="600"')}${e?input('音频开始时间（秒）','audioStart',sec(e.audioStart),'min="0"'):''}<label class="field"><span>${g?'本段已使用共同配乐':e?'独立片段配乐':'动画配乐'}</span>${g?'<span>断开连接后可设置独立配乐</span>':e?select('audioMode',e.audioMode||'auto',[['auto','独立音频优先，其次录像原声'],['audio','仅独立音频'],['video','仅录像原声'],['silent','静音']]):select('audioMode',c.audioMode,[['next','提前播放下一首'],['previous','延续上一首'],['own','使用动画原声'],['silent','静音']])}</label>${!e?input('动画原声音量（0–1）','originalVolume',c.originalVolume,'min="0" max="1" step=".05"'):''}${c.effectFile?input('额外音效音量（0–1）','effectVolume',c.effectVolume??1,'min="0" max="1" step=".05"'):''}</div>
  <div class="audio-panel"><div class="audio-heading"><h3>${g?'共同音源 · 连续播放':'音乐衔接'}</h3><div class="clip-actions">${btn('connect','与前一段连接配乐')}${g?btn('disconnect','断开本组配乐','','quiet'):''}${btn('listen','试听接点')}</div></div><p>拖动卡片不改变 Best 排名。共同配乐内修改开始时间会联动本组音乐；音画校准请调整偏移。原片声音可在上方播放器中试听。</p>
  ${g?`${pick('groupSource','共同音源',g.source,'sound')}<div class="audio-controls">${input('本组音乐开始时间（秒）','groupStart',sec(g.sourceStart),'min="0"')}${input('录像相对音乐偏移（秒）','offset',sec(g.offsets?.[id]??(start-(scene.sourceTime??0))))}${input('本组音量（0–1）','groupVolume',g.volume??1,'min="0" max="1" step=".05"')}</div><div class="clip-actions">${e?.video?btn('align',busy?'正在分析…':'自动对齐到共同音源',busy?'disabled':''):''}${busy?btn('cancel-align','取消对齐'):''}${e?.video?btn('confirm-offset','确认当前音画对应','','quiet'):''}</div>${g.pendingClipIds?.includes(id)?'<div class="audio-status amber-text">本段尚未校准。试听后采用对齐候选，或手动微调偏移并确认；确认前不能导出。</div>':''}`:''}
  ${source?`<div class="waveform-wrap"><canvas id="music-wave"></canvas></div><small>配乐：${h(name(source))}${music?' · 当前范围 '+sec(music.start+(scene.at-music.at))+' 秒起':''}</small>`:''}
  ${alignment?.clipId===id?`<div class="audio-status">${h(alignment.result.reason||alignment.result.status)}${alignment.result.candidates?.length?`<div class="audio-candidates">${alignment.result.candidates.map((v,i)=>`<div>${btn('audition',`试听候选 ${i+1} · 偏移 ${sec(v.offset)} 秒`,`data-index="${i}"`)}${btn('adopt',`采用 · ${v.matchedWindows||0} 个窗口一致`,`data-index="${i}"`)}</div>`).join('')}</div>`:''}</div>`:''}
  </div></section>${global}${plan.issues.length?`<div class="timeline-warning">${plan.issues.map(i=>h(i.message)).join('<br>')}</div>`:''}`;
}
const waves=new WeakMap();
function draw(canvas){
  const state=waves.get(canvas);if(!state?.data||!canvas.isConnected)return;
  const data=state.data,dpr=devicePixelRatio||1;canvas.width=Math.max(1,Math.round(canvas.clientWidth*dpr));canvas.height=Math.max(1,Math.round(canvas.clientHeight*dpr));
  const ctx=canvas.getContext('2d');ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#7a75a0';ctx.lineWidth=Math.max(1,dpr);
  const end=data.end??data.duration,domain=state.duration?.()||end||1,start=data.start||0,peaks=data.peaks||[];
  ctx.beginPath();peaks.forEach((v,i)=>{const x=(start+i/Math.max(1,peaks.length-1)*Math.max(0,end-start))/domain*canvas.width;ctx.moveTo(x,canvas.height*(.5-v*.45));ctx.lineTo(x,canvas.height*(.5+v*.45));});ctx.stroke();
}
async function wave(file,canvas,duration){
  if(!file||!canvas)return;const state={duration};waves.set(canvas,state);
  const observer=new ResizeObserver(()=>draw(canvas));observer.observe(canvas);waveCleanups.push(()=>{observer.disconnect();waves.delete(canvas);});
  try{state.data=await window.arc.waveform(file,{points:1200});if(waves.get(canvas)===state)draw(canvas);}catch(error){if(canvas.isConnected)canvas.title=error.message;}
}
export function syncWorkbench(root,{seekTo}={}){
  if(!trimmer||root.querySelector('#source-video')!==trimmerVideo)return;
  const {t,s}=current();if(!t||!s)return;
  const start=s.entry?.start??t.start??0;trimmer.update({start,end:start+t.duration,seekTo});draw(root.querySelector('#source-wave'));
}
export function mountWorkbench(root){
  disposeWorkbench();
  if(!hooks)return;const p=hooks.project(),id=hooks.selected(),c=clipFor(p,id),e=c?.type==='song'?p.entries.find(e=>e.id===c.entryId):null,file=e?.video||c?.file,video=root.querySelector('#source-video');
  if(video){
    trimmerVideo=video;trimmer=createSourceTrimmer({root,video,onPlay:()=>hooks.stopTimeline?.(),onError:message=>hooks.error(message),onMetadata:duration=>{mediaCache.set(file,{...(mediaCache.get(file)||{}),videoDuration:duration,duration});draw(root.querySelector('#source-wave'));}});
    syncWorkbench(root);if(video.readyState>=1)trimmer.seek(buildTimeline(p).scenes.find(s=>s.clipId===id)?.entry?.start??c?.start??0);
  }
  if(file)wave(file,root.querySelector('#source-wave'),()=>Number.isFinite(video?.duration)?video.duration:undefined);
  const g=groupFor(p,id),source=g?.source||(e?entryAudioSource(e,p)?.file:'');if(source)wave(source,root.querySelector('#music-wave'));
}
function snapshot(){return JSON.stringify(hooks.project());}
function commit(edit,options){
  hooks.stop();const before=snapshot(),old=buildTimeline(hooks.project());edit(hooks.project());const next=buildTimeline(hooks.project());
  const moved=next.scenes.filter(s=>s.audioGroupId&&s.entry&&old.scenes.some(o=>o.clipId===s.clipId&&Math.abs(o.entry?.start-s.entry.start)>.0005));
  if(moved.length&&!confirm('保持音乐连续会联动调整录像开始时间：\n'+moved.slice(0,8).map(s=>`${s.entry.title} → ${sec(s.entry.start)} 秒`).join('\n')+'\n确认采用？取消将保留原安排。')){hooks.replace(JSON.parse(before));hooks.refresh(options);return false;}
  if(snapshot()!==before){undo.push(before);if(undo.length>25)undo.shift();hooks.changed();}hooks.refresh(options);return true;
}
export function changeWorkbench(edit,options){return commit(edit,options);}
function current(){const p=hooks.project(),c=clipFor(p,hooks.selected()),e=c?.type==='song'?p.entries.find(e=>e.id===c.entryId):null;return {p,c,e,t:e||c,g:groupFor(p,c?.id),s:buildTimeline(p).scenes.find(s=>s.clipId===c?.id)};}
function setTrim(key,value,options){const {t,s,g,c}=current();if(!t||!Number.isFinite(value))return;commit(()=>{const start=s.entry?.start??t.start??0,end=start+t.duration;if(key==='start'||key==='trim-in')value=Math.max(0,value);if(key==='duration')t.duration=Math.max(.5,Math.min(600,value));else if(key==='end'||key==='trim-out')t.duration=Math.max(.5,Math.min(600,value-start));else{if(g){g.sourceStart+=value-start;}else t.start=Math.max(0,value);t.duration=Math.max(.5,Math.min(600,end-value));}},options);}
export function bindWorkbench(root,callbacks){
  hooks=callbacks;
  bindTextStyleEditor(root,{entry:()=>current().e,commit,refresh:hooks.refresh,error:hooks.error});
  root.addEventListener('click',async ev=>{const el=ev.target.closest('[data-action^="wb-"]');if(!el||el.disabled)return;ev.preventDefault();try{
    const a=el.dataset.action.slice(3),{p,c,e,t,g,s}=current();
    if(a==='select'){hooks.stop();hooks.select(el.dataset.clipId);return;}
    if(a==='edit'){hooks.edit(e.id);return;}
    if(a==='undo'){if(undo.length){hooks.stop();hooks.replace(JSON.parse(undo.pop()));hooks.changed();hooks.refresh();}return;}
    if(a==='reset'){if(confirm('恢复自动排序会断开现有共同配乐连接，动画保留当前位置。'))commit(p=>{p.audioGroups=[];resetSequence(p,el.dataset.order);});return;}
    if(a==='insert'){
      const file=await choose('video');if(!file)return;
      const meta=await window.arc.probe(file);if(!meta.video)throw new Error('所选文件没有视频画面');
      const item={id:'animation:'+crypto.randomUUID(),type:'animation',file,start:0,duration:Math.min(3,meta.duration),audioMode:'next',originalVolume:0};
      mediaCache.set(file,meta);
      commit(p=>{
        const seq=ensureSequence(p),selected=hooks.selected(),selectedIndex=seq.findIndex(x=>x.id===selected);
        const insertionIndex=selectedIndex<0?seq.length:selectedIndex;
        item.audioMode=seq.slice(insertionIndex).some(c=>c.type==='song')?'next':seq.slice(0,insertionIndex).some(c=>c.type==='song')?'previous':'silent';
        seq.splice(insertionIndex,0,item);
        const next=seq[insertionIndex+1],group=next&&groupFor(p,next.id);
        if(group){const j=group.clipIds.indexOf(next.id);group.clipIds.splice(j,0,item.id);if(j===0)group.sourceStart-=item.duration;}
      });
      if(clipFor(hooks.project(),item.id))hooks.select(item.id);return;
    }
    if(!c)return;
    if(a==='left'||a==='right'){commit(p=>{const seq=ensureSequence(p),i=seq.findIndex(x=>x.id===c.id),j=i+(a==='left'?-1:1);if(j>=0&&j<seq.length)[seq[i],seq[j]]=[seq[j],seq[i]];});return;}
    if(a==='remove'){if(confirm(`从影片移除「${e?.title||name(c.file)}」？成绩与本地文件会保留。`))commit(p=>{if(e){p.excludedEntryIds??=[];p.excludedEntryIds.push(e.id);}p.sequence=p.sequence.filter(x=>x.id!==c.id);p.audioGroups=(p.audioGroups||[]).filter(g=>!g.clipIds.includes(c.id));});return;}
    if(a==='pick'){const file=await choose(el.dataset.kind);if(!file)return;const meta=await window.arc.probe(file);mediaCache.set(file,meta);commit(()=>{if(el.dataset.key==='groupSource'){g.source=file;g.offsets={};g.pendingClipIds=g.clipIds.filter(id=>p.sequence.find(c=>c.id===id)?.type==='song'&&p.entries.find(e=>'song:'+e.id===id)?.video!==file);for(const id of g.clipIds){const entry=p.entries.find(e=>'song:'+e.id===id);if(entry?.video===file)g.offsets[id]=0;}alignment=null;}else{t[el.dataset.key]=file;if(el.dataset.key==='video'){t.probe=meta;if(g){if(g.offsets)delete g.offsets[c.id];g.pendingClipIds=[...new Set([...(g.pendingClipIds||[]),c.id])];alignment=null;}}if(el.dataset.key==='effectFile')t.effectDuration=Math.min(meta.audioDuration||meta.duration,t.duration);}});return;}
    if(a==='clear'){commit(()=>{if(el.dataset.key==='groupSource'){g.source='';g.offsets={};alignment=null;}else{t[el.dataset.key]='';}});return;}
    if(a==='mark-in'||a==='mark-out'){setTrim(a==='mark-in'?'start':'end',root.querySelector('#source-video')?.currentTime??0);return;}
    if(a==='source-loop'){syncWorkbench(root);trimmer?.toggleLoop();return;}
    if(a==='connect'){
      const seq=ensureSequence(p),i=seq.findIndex(x=>x.id===c.id);if(i<1)throw new Error('前面没有可连接的内容片段');const prev=seq[i-1],prevScene=buildTimeline(p).scenes.find(x=>x.clipId===prev.id);let group=groupFor(p,prev.id);
      if(g&&g!==group)throw new Error('当前片段已经属于另一组，请先断开原连接');
      if(group){if(!group.clipIds.includes(c.id))commit(()=>{const originalStart=s.entry?.start??e?.start;group.clipIds.push(c.id);if(e){group.offsets??={};const connected=buildTimeline(p).scenes.find(x=>x.clipId===c.id);group.offsets[c.id]=e.video===group.source?0:originalStart-connected.sourceTime;if(e.video&&e.video!==group.source)group.pendingClipIds=[...new Set([...(group.pendingClipIds||[]),c.id])];}});}
      else{const prevEntry=prevScene?.entry,baseEntry=prevEntry||e;let source=baseEntry?entryAudioSource(baseEntry,p)?.file:'';if(!source)source=await choose('sound');if(!source)return;const sourceStart=prevEntry?(entryAudioSource(prevEntry,p)?.start??0):Math.max(0,(entryAudioSource(e,p)?.start??0)-prevScene.duration);commit(p=>{const offsets={},pendingClipIds=[];if(prevEntry){offsets[prev.id]=prevEntry.video===source?0:prevEntry.start-sourceStart;if(prevEntry.video&&prevEntry.video!==source)pendingClipIds.push(prev.id);}if(e){offsets[c.id]=e.video===source?0:e.start-(sourceStart+prevScene.duration);if(e.video&&e.video!==source)pendingClipIds.push(c.id);}p.audioGroups.push({id:crypto.randomUUID(),clipIds:[prev.id,c.id],source,sourceStart,offsets,pendingClipIds,volume:1});});}
      return;
    }
    if(a==='disconnect'){commit(p=>{p.audioGroups=p.audioGroups.filter(x=>x.id!==g?.id);});return;}
    if(a==='listen'){const plan=buildTimeline(p),index=plan.scenes.findIndex(x=>x.clipId===c.id),cut=index>0?s.at:s.at+s.duration;hooks.listen(Math.max(0,cut-3),Math.min(plan.duration,cut+3));return;}
    if(a==='align'){if(!g||!e?.video)throw new Error('先连接配乐并选择录像');busy=true;alignment=null;hooks.refresh();try{alignment={clipId:c.id,source:g.source,target:e.video,result:await window.arc.align({source:g.source,target:e.video})};}finally{busy=false;hooks.refresh();}return;}
    if(a==='cancel-align'){await window.arc.cancelAlign();return;}
    if(a==='audition'){if(!g||alignment?.source!==g.source||alignment?.target!==e?.video)throw new Error('素材已变化，请重新对齐');const draft=structuredClone(p),dg=draft.audioGroups.find(x=>x.id===g.id);dg.offsets??={};dg.offsets[c.id]=alignment.result.candidates[Number(el.dataset.index)].offset;const plan=buildTimeline(draft),ds=plan.scenes.find(x=>x.clipId===c.id);hooks.listen(Math.max(0,ds.at-3),Math.min(plan.duration,ds.at+3),draft);return;}
    if(a==='adopt'){if(!g||alignment?.source!==g.source||alignment?.target!==e?.video)throw new Error('素材已变化，请重新对齐');const candidate=alignment.result.candidates[Number(el.dataset.index)];commit(()=>{g.offsets??={};g.offsets[c.id]=candidate.offset;g.pendingClipIds=(g.pendingClipIds||[]).filter(id=>id!==c.id);});return;}
    if(a==='confirm-offset'){if(g)commit(()=>{g.pendingClipIds=(g.pendingClipIds||[]).filter(id=>id!==c.id);});return;}
  }catch(error){hooks.error(error.message);}});
  root.addEventListener('change',ev=>{
    const el=ev.target,key=el.dataset.wb;if(!key)return;
    const editing=el.tagName!=='SELECT',options={editing,source:el};
    try{
      const {p,t,g,c}=current();
      if(['transitionMode','transitionDuration','transitionAudioDuration','transitionGapDuration'].includes(key)){
        const empty=String(el.value).trim()==='';
        if(key!=='transitionMode'&&!(['transitionAudioDuration','transitionGapDuration'].includes(key)&&empty)&&(empty||!Number.isFinite(Number(el.value)))){hooks.error('请输入有效的转场时长。');hooks.refresh({editing:true});return;}
        commit(p=>{
          p.settings.sceneTransitions??={};const id=hooks.selected()?.startsWith('overview:')?'overview:1':hooks.selected(),old=p.settings.sceneTransitions[id]||{},next={...old};
          if(key==='transitionMode'){
            if(el.value==='inherit'){delete next.mode;delete next.duration;}
            else{next.mode=el.value;next.duration=old.duration??transitionFor(p,id).duration;}
          }else if(key==='transitionAudioDuration'){
            if(empty)delete next.audioDuration;else next.audioDuration=Math.max(0,Math.min(2,Number(el.value)));
          }else if(key==='transitionGapDuration'){
            if(empty)delete next.gapDuration;else next.gapDuration=Math.max(0,Math.min(5,Number(el.value)));
          }else{next.mode='black';next.duration=Math.max(0,Math.min(5,Number(el.value)));}
          if(Object.keys(next).length)p.settings.sceneTransitions[id]=next;else delete p.settings.sceneTransitions[id];
        },{editing:true,source:el});return;
      }
      if(key==='restore'){if(el.value)commit(p=>{p.excludedEntryIds=(p.excludedEntryIds||[]).filter(id=>id!==el.value);});return;}
      if(editing&&(String(el.value).trim()===''||!Number.isFinite(Number(el.value)))){
        hooks.error('请输入有效数字；已保留原来的设置。');hooks.refresh(options);return;
      }
      if(['start','end','duration','trim-in','trim-out'].includes(key)){setTrim(key,Number(el.value),options);return;}
      commit(()=>{
        if(key==='groupStart')g.sourceStart=Math.max(0,Number(el.value));
        else if(key==='groupVolume')g.volume=Math.max(0,Math.min(1,Number(el.value)));
        else if(key==='offset'){g.offsets??={};g.offsets[c.id]=Number(el.value);}
        else{
          t[key]=el.tagName==='SELECT'?el.value:Math.max(Number(el.min??-Infinity),Math.min(el.max?Number(el.max):Infinity,Number(el.value)));
          if(key==='audioMode'&&c.type==='animation'&&el.value==='own'&&!t.originalVolume)t.originalVolume=1;
        }
      },options);
    }catch(error){hooks.error(error.message);}
  });
  root.addEventListener('keydown',ev=>{
    const el=ev.target;
    if(el.tagName!=='INPUT'||el.type==='checkbox'||(!el.dataset.time&&!el.closest('.clip-editor,.workbench-global')))return;
    if(ev.key==='Enter'){ev.preventDefault();el.dispatchEvent(new Event('change',{bubbles:true}));}
    else if(ev.key==='Escape'){ev.preventDefault();hooks.refresh({editing:true,source:el});}
    else if(el.dataset.time&&(ev.key==='ArrowUp'||ev.key==='ArrowDown')){
      ev.preventDefault();const value=Number(el.value);if(!Number.isFinite(value))return;
      const step=ev.altKey?.001:ev.shiftKey?1:.1;
      const min=el.min!==''?Number(el.min):-Infinity,max=el.max!==''?Number(el.max):Infinity;
      el.value=String(Math.max(min,Math.min(max,Math.round((value+(ev.key==='ArrowUp'?step:-step))*1000)/1000)));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }
  });
  root.addEventListener('dragstart',ev=>{const el=ev.target.closest('[data-clip-id][draggable="true"]');if(!el)return;dragId=el.dataset.clipId;ev.dataTransfer.setData('text/plain',dragId);ev.dataTransfer.effectAllowed='move';el.classList.add('dragging');});
  root.addEventListener('dragover',ev=>{const el=ev.target.closest('[data-clip-id][draggable="true"]');if(el&&dragId){ev.preventDefault();el.classList.add('drop-target');}});
  root.addEventListener('dragleave',ev=>ev.target.closest('[data-clip-id]')?.classList.remove('drop-target'));
  root.addEventListener('dragend',()=>{dragId='';root.querySelectorAll('.dragging,.drop-target').forEach(el=>el.classList.remove('dragging','drop-target'));});
  root.addEventListener('drop',ev=>{const el=ev.target.closest('[data-clip-id][draggable="true"]');if(!el||!dragId)return;ev.preventDefault();const id=dragId,target=el.dataset.clipId;dragId='';if(id===target)return;commit(p=>{const seq=ensureSequence(p),i=seq.findIndex(x=>x.id===id),j=seq.findIndex(x=>x.id===target);if(i<0||j<0)return;seq.splice(j,0,seq.splice(i,1)[0]);});});
}

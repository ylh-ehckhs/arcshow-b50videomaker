import {workbenchView,timelineCards,bindWorkbench,mountWorkbench,syncWorkbench,disposeWorkbench,pauseWorkbench,resetWorkbenchHistory,changeWorkbench} from './workbench.mjs';
import {checkTimelineMedia} from '../shared/media-check.mjs';
import {createTimelinePlayer} from './timeline-player.mjs';
import {previewPayload} from './preview-payload.mjs';
import {layoutView,bindLayoutEditor,layoutSelection} from './layout-editor.mjs';
import {newProject,newEntry,demoProject,ranked,scenes,rating,grade,issues,fmtScore,fmtRating,clock,numeric,escapeHtml as h,matchMedia,ensureSequence,resetSequence,buildTimeline,overviewEntries,DIFFICULTIES,CLEARS} from '../shared/core.mjs';
import {mediaUrl} from '../shared/media.mjs';
import {lockPlaybackEditor,refreshPlaybackEditor} from './playback-editor.mjs';
import {truncateComment} from '../shared/comments.mjs';
import {commentPreviewHtml,refreshCommentPreview,bindCommentClipboard} from './comment-editor.mjs';
const api=window.arc;
const $=s=>document.querySelector(s);
const icons={grid:'▦',media:'▧',settings:'☷',export:'↗',plus:'＋',play:'▶',pause:'Ⅱ',save:'↓',folder:'⌑',image:'▧',check:'✓',arrow:'→'};
let p=demoProject(),view='entries',selected=p.entries[7].id,sceneType='song',overviewPage=0,search='',filter='all',projectPath='',dirty=false,saveText='尚未保存工程',info=null,assets=[],assetDir='',job=null,lastExport=null,ocrDraft=null,ocrIndex=0,ocrFile='',ocrRunning=false,modal=null,playing=false,playTimer=null,audio=null,previewElapsed=0,previewQueue=[],autoTimer,previewTimer;
let mediaRevision=0,mediaCheck={revision:-1,status:'idle',issues:[],files:0},testPickQueue=[];
let selectedClipId='song:'+selected,entryDraft=null,entryIsNew=false,rowMenu=null,previewGap=false,pendingPlaybackEditor=null;
let ocrOptions={layout:'auto',cols:5,rows:10,left:.01,right:.99,top:.24,bottom:.965};
const root=$('#app');
let uiTheme=localStorage.getItem('arcshow.ui-theme')||'luna';
if(!['hikari','tairitsu','sakuya','luna'].includes(uiTheme))uiTheme='luna';
document.documentElement.dataset.impression=uiTheme;
function syncProjectImpression(){
  if(['hikari','tairitsu','sakuya','luna'].includes(p.settings.impression))uiTheme=p.settings.impression;
  else p.settings.impression=uiTheme;
  document.documentElement.dataset.impression=uiTheme;localStorage.setItem('arcshow.ui-theme',uiTheme);
}
let uiZoom=1;
try{const saved=Number((localStorage.getItem('arcshow.ui-zoom')??localStorage.getItem('arc-reel.ui-zoom')));if(saved>=.75&&saved<=2)uiZoom=saved;}catch{}
document.documentElement.style.setProperty('--ui-scale',uiZoom);
function setUiZoom(value){
  uiZoom=Math.max(.75,Math.min(2,Math.round(value*100)/100));
  document.documentElement.style.setProperty('--ui-scale',uiZoom);
  try{localStorage.setItem('arcshow.ui-zoom',String(uiZoom));}catch{}
  const label=$('#ui-zoom-label');if(label)label.textContent=`${Math.round(uiZoom*100)}%`;
  const out=$('[data-action="ui-zoom-out"]'),inside=$('[data-action="ui-zoom-in"]');
  if(out)out.disabled=uiZoom<=.75;if(inside)inside.disabled=uiZoom>=2;
}
const zoomControls=()=>`<div class="zoom-control" role="group" aria-label="界面缩放"><span>界面</span>${button('ui-zoom-out','−','quiet','aria-label="缩小界面" title="缩小界面（Ctrl+-）"'+(uiZoom<=.75?' disabled':''))}${button('ui-zoom-reset',`${Math.round(uiZoom*100)}%`,'quiet','id="ui-zoom-label" title="恢复 100%（Ctrl+0）"')}${button('ui-zoom-in','＋','quiet','aria-label="放大界面" title="放大界面（Ctrl++）"'+(uiZoom>=2?' disabled':''))}</div>`;
const entry=()=>entryDraft||p.entries.find(e=>e.id===selected)||p.entries[0];
const best=()=>ranked(p);
function toast(text,error=false){const el=$('#toast');el.textContent=text;el.className=`show ${error?'error':''}`;clearTimeout(el.timer);el.timer=setTimeout(()=>el.className='',5500);}
const button=(action,label,cls='',extra='')=>`<button class="btn ${cls}" data-action="${action}" ${extra}>${label}</button>`;
const options=(values,current,labels={})=>values.map(v=>`<option value="${h(v)}" ${String(v)===String(current)?'selected':''}>${h(labels[v]??v)}</option>`).join('');
const numKeys=new Set(['constant','score','far','lost','ratingOverride','duration','start','audioStart']);
function field(label,key,value,type='text',attrs='') {return `<label class="field"><span>${label}</span><input data-field="${key}" value="${h(value??'')}" type="${type}" ${attrs}></label>`;}
function currentScene(){
  const plan=buildTimeline(p),list=overviewEntries(p);
  overviewPage=Math.max(0,Math.min(overviewPage,Math.max(0,Math.ceil(list.length/10)-1)));
  if(sceneType==='intro')sceneType='song';
  if(view==='layout'&&sceneType!=='overview')sceneType='song';
  if(sceneType==='overview')return plan.scenes.find(s=>s.type==='overview'&&s.page===overviewPage+1)||{type:'overview',clipId:'overview:'+String(overviewPage+1),at:plan.duration,entries:list.slice(overviewPage*10,overviewPage*10+10),page:overviewPage+1,pages:Math.max(1,Math.ceil(list.length/10)),duration:p.settings.overview};
  const candidates=view==='layout'?plan.scenes.filter(s=>s.type==='song'):plan.scenes;
  const found=candidates.find(s=>s.clipId===selectedClipId)||candidates.find(s=>s.entry?.id===selected)||candidates.find(s=>s.type==='song');
  if(found)return found;
  return {type:'song',clipId:'sample',at:0,entry:{...newEntry({title:'曲名',score:9900000,constant:10,clear:'NC',comment:'短评',duration:15}),rating:11.7,rank:1},duration:15};
}
function editEntry(id,isNew=false){stopPlayback();entryDraft=isNew?newEntry({duration:p.settings.defaultDuration}):structuredClone(p.entries.find(e=>e.id===id));if(!entryDraft)return;entryIsNew=isNew;modal='entry-edit';document.querySelector('.row-menu')?.remove();$('#modal-root').innerHTML=modalView();}
function closeEntryEditor(){entryDraft=null;modal=null;$('#modal-root').replaceChildren();}
function refreshEntryEditor(source){
  const host=$('#modal-root'),template=document.createElement('template');template.innerHTML=modalView();
  for(const field of host.querySelectorAll('[data-field]')){
    const next=template.content.querySelector(`[data-field="${field.dataset.field}"]`);if(!next||field===source)continue;
    if(field.type==='checkbox')field.checked=next.checked;else if(field.value!==next.value)field.value=next.value;
  }
  for(const selector of ['.calculated','.inspector-head','.inspector-bottom']){
    const current=host.querySelector(selector),next=template.content.querySelector(selector);if(current&&next)current.innerHTML=next.innerHTML;
  }
  const validation=host.querySelector('.inspector-form > .validation'),nextValidation=template.content.querySelector('.inspector-form > .validation');
  if(validation&&nextValidation)validation.replaceWith(nextValidation);else if(validation)validation.remove();else if(nextValidation)host.querySelector('.inspector-bottom')?.before(nextValidation);
  for(const field of host.querySelectorAll('.field')){const count=field.querySelector('span small');if(count&&field.querySelector('[data-field="comment"]'))count.textContent=`${entryDraft.comment.length} / 500`;}
  refreshCommentPreview(host,entryDraft);
}
function updatePreview(){const iframe=$('#preview');if(iframe)iframe.contentWindow.postMessage({type:'scene',payload:previewPayload(p,currentScene(),{editing:view==='layout',...layoutSelection()})},'*');}
function playbackEditor(id,defer=playing){
  const editor=$('#clip-editor-root');if(!editor){pendingPlaybackEditor=null;return;}
  pendingPlaybackEditor=defer?id:null;
  refreshPlaybackEditor(editor,id,{playing:defer,render:(host,clipId)=>{host.innerHTML=workbenchView(p,clipId);mountWorkbench(root);}});
}
function selectClip(id){
  if(id==='intro')return;
  previewGap=false;
  stopPlayback();const plan=buildTimeline(p);let scene=plan.scenes.find(s=>s.clipId===id);
  if(!scene&&id?.startsWith('overview:')){scene={type:'overview',clipId:id,duration:0};}
  if(!scene)return;
  const workspace=$('.workspace'),table=$('.table-panel'),oldTableTop=table?.getBoundingClientRect().top,anchorTable=oldTableTop!=null&&oldTableTop<innerHeight*.8;
  selectedClipId=id;sceneType=scene.type;if(scene.entry)selected=scene.entry.id;if(scene.type==='overview')overviewPage=Math.max(0,Number(id.split(':')[1]||1)-1);previewElapsed=0;
  if(scene.type==='overview'){render();return;}
  const editor=$('#clip-editor-root');if(!editor){render();return;}
  editor.innerHTML=workbenchView(p,id);
  editor.dataset.clipId=id;
  root.querySelectorAll('[data-clip-id]').forEach(el=>el.classList.toggle('selected',el.dataset.clipId===id));
  root.querySelectorAll('tr[data-id]').forEach(el=>el.classList.toggle('selected',el.dataset.id===selected));
  root.querySelectorAll('[data-scene]').forEach(el=>el.classList.toggle('active',el.dataset.scene===sceneType));
  $('.overview-pages')?.remove();const play=$('[data-action="play"]');if(play)play.disabled=scene.duration<=0;const scrub=$('#scrub');if(scrub){scrub.disabled=false;scrub.max=scene.duration;scrub.value=0;}const time=$('#play-time');if(time)time.textContent=clock(0)+' / '+clock(scene.duration);
  updatePreview();mountWorkbench(root);
  if(anchorTable&&workspace&&table)workspace.scrollTop+=table.getBoundingClientRect().top-oldTableTop;
}
function changed(resetHistory=true){mediaRevision++;mediaCheck={revision:-1,status:'idle',issues:[],files:0};if(resetHistory)resetWorkbenchHistory();dirty=true;saveText='正在自动保存…';clearTimeout(autoTimer);autoTimer=setTimeout(async()=>{try{await api.autosave(p);saveText='已自动保存到本机';const el=$('#save-state');if(el)el.textContent=saveText;}catch(e){saveText='自动保存失败';toast(e.message,true);}},500);}
function panelHeader(kicker,title,description){return `<div class="page-title"><h1>${title}</h1>${description?`<p>${description}</p>`:''}</div>`;}
const pageScroll=new Map();
let renderedView=null;
function render(){
  disposeWorkbench();
  previewGap=false;
  syncProjectImpression();
  if(sceneType==='intro')sceneType='song';
  const content=ensureSequence(p);if(!selectedClipId?.startsWith('overview:')&&!content.some(c=>c.id===selectedClipId)){selectedClipId=content[0]?.id||'';const c=content[0];if(c?.entryId)selected=c.entryId;}
  const entryScroll=$('.entry-edit-body')?.scrollTop||0;
  if(renderedView)pageScroll.set(renderedView,$('.workspace')?.scrollTop||0);
  const scroll=pageScroll.get(view)||0;
  const reviewScroll=$('.review-content')?.scrollTop||0;
  const timelineScroll=$('.timeline')?.scrollLeft||0;
  const tableScroll={top:$('.table-scroll')?.scrollTop||0,left:$('.table-scroll')?.scrollLeft||0};
  const openDetails=[...root.querySelectorAll('details[open]')].map(el=>el.className);
  renderedView=view;
  root.innerHTML=`<aside class="sidebar"><div class="brand"><div class="brand-mark">◇</div><div>arcshow-<small>b50videomaker</small></div></div><div class="side-label"></div><nav>${[['entries','grid','成绩与剪辑','01'],['settings','settings','影片设置','02'],['layout','grid','视频布局','03'],['export','export','导出','04']].map(([id,ic,label,n])=>`<button data-action="nav" data-view="${id}" class="nav ${view===id?'active':''}"><span>${icons[ic]}</span>${label}<small>${n}</small></button>`).join('')}</nav><div class="side-project"><strong>${h(p.name)}</strong><p>${p.entries.length} 条成绩 · Best ${p.settings.count}</p></div><div class="side-bottom"><small>v${info?.version??'0.1.0'}</small></div></aside>
    <main><header class="topbar"><div class="breadcrumb"> ${h(p.name)} ${p.demo?'<b class="demo-badge">演示工程</b>':''}</div><div class="top-actions">${zoomControls()}<span id="save-state">${h(saveText)}</span>${button('new','新建','quiet')}${button('open','打开工程','quiet')}${button('save','↓ 保存工程','outline')}</div></header><div class="workspace">${view==='entries'?entriesView():view==='settings'?settingsView():view==='layout'?layoutView(p,sceneType):exportView()}</div></main><div id="modal-root">${modalView()}</div>`;
  for(const cls of openDetails)if(cls)root.querySelector('details.'+cls)?.setAttribute('open','');
  $('.workspace').scrollTop=scroll;
  if($('.entry-edit-body'))$('.entry-edit-body').scrollTop=entryScroll;
  if($('.review-content'))$('.review-content').scrollTop=reviewScroll;
  if($('.timeline'))$('.timeline').scrollLeft=timelineScroll;
  const table=$('.table-scroll');if(table){table.scrollTop=tableScroll.top;table.scrollLeft=tableScroll.left;}
  const iframe=$('#preview');if(iframe)iframe.addEventListener('load',updatePreview,{once:true});
  updateJobs();
  if(view==='entries'){const editor=$('#clip-editor-root');if(editor){editor.dataset.clipId=selectedClipId;lockPlaybackEditor(editor,playing);}mountWorkbench(root);}
  if(view==='export'&&mediaCheck.status==='idle')queueMicrotask(()=>checkMedia());
}
function refreshWorkbench({editing=false,source=null,textStyles=false}={}){
  const editor=$('#clip-editor-root');
  if(textStyles&&editor){
    const template=document.createElement('template');template.innerHTML=workbenchView(p,selectedClipId);
    const current=editor.querySelector('.clip-text-styles'),next=template.content.querySelector('.clip-text-styles');
    if(current&&next){next.open=current.open;current.replaceWith(next);}return;
  }
  if(!editing||view!=='entries'||!editor){render();return;}
  // change fires between mouse press and release. Keep these controls alive so
  // the next field receives focus and the next button receives its first click.
  const template=document.createElement('template');template.innerHTML=workbenchView(p,selectedClipId);
  const fresh=template.content;
  for(const field of editor.querySelectorAll('[data-wb],[data-setting],[data-project],[data-text-style-field],[data-text-color-picker]')){
    if(['trim-in','trim-out'].includes(field.dataset.wb))continue;
    const attr=['data-wb','data-setting','data-project','data-text-style-field','data-text-color-picker'].find(a=>field.hasAttribute(a));
    const next=fresh.querySelector(`[${attr}="${field.getAttribute(attr)}"]`);if(!next)continue;
    field.disabled=next.disabled;
    if(field.hasAttribute('placeholder'))field.placeholder=next.placeholder;
    if(attr==='data-text-style-field'&&field.tagName==='SELECT')field.options[0].textContent=next.options[0].textContent;
    if(field.type==='checkbox')field.checked=next.checked;
    else if(field.value!==next.value)field.value=next.value;
  }
  const styleStatus=editor.querySelector('[data-text-style-status]'),nextStatus=fresh.querySelector('[data-text-style-status]');
  if(styleStatus&&nextStatus)styleStatus.textContent=nextStatus.textContent;
  for(const button of editor.querySelectorAll('[data-text-style-action]')){
    const next=fresh.querySelector(`[data-text-style-action="${button.dataset.textStyleAction}"]`);if(next)button.disabled=next.disabled;
  }
  for(const selector of ['.audio-panel > small']){
    const current=editor.querySelector(selector),next=fresh.querySelector(selector);
    if(current&&next)current.textContent=next.textContent;
  }
  const seekKey=source?.dataset.wb,seekTo=['start','end','trim-in','trim-out'].includes(seekKey)?Number(editor.querySelector(`[data-wb="${seekKey}"]`).value):undefined;
  syncWorkbench(root,{seekTo});
  const warning=editor.querySelector('.timeline-warning'),nextWarning=fresh.querySelector('.timeline-warning');
  if(nextWarning){if(warning)warning.innerHTML=nextWarning.innerHTML;else editor.append(nextWarning);}
  else warning?.remove();
  const undo=editor.querySelector('[data-action="wb-undo"]'),nextUndo=fresh.querySelector('[data-action="wb-undo"]');
  if(undo&&nextUndo)undo.disabled=nextUndo.disabled;
  const timeline=document.createElement('template');timeline.innerHTML=timelineCards(p,selectedClipId);
  for(const card of root.querySelectorAll('.timeline [data-clip-id]')){
    const next=timeline.content.querySelector(`[data-clip-id="${card.dataset.clipId}"]`);
    if(next)for(const tag of ['span','strong','small']){
      const current=card.querySelector(tag),value=next.querySelector(tag);if(current&&value)current.innerHTML=value.innerHTML;
    }
  }
  const lane=$('.timeline');if(lane){const left=lane.scrollLeft;lane.querySelectorAll('[data-gap-id]').forEach(el=>el.remove());for(const gap of timeline.content.querySelectorAll('[data-gap-id]')){const incoming=gap.dataset.gapId.slice(4),next=lane.querySelector(`[data-clip-id="${CSS.escape(incoming)}"]`);if(next)lane.insertBefore(gap,next);}lane.scrollLeft=left;}
  const scene=currentScene(),scrub=$('#scrub');previewElapsed=Math.min(previewElapsed,scene.duration);
  if(scrub){scrub.max=scene.duration;scrub.value=previewElapsed;}
  const time=$('#play-time');if(time)time.textContent=clock(previewElapsed)+' / '+clock(scene.duration);
  const play=$('[data-action="play"]');if(play)play.disabled=scene.duration<=0;
  updatePreview();
}
function refreshOcrReview({editing=false,source=null}={}){
  // Keep the underlying video preview alive while changing the review card.
  const host=$('#modal-root'),scroll=$('.review-content')?.scrollTop||0;
  if(editing&&modal==='ocr-review'&&host.querySelector('.review-modal')){
    // A field's change event runs during the next button's mouse press. Keep
    // every control in place so the matching mouse release still clicks it.
    const template=document.createElement('template');template.innerHTML=modalView();
    const fresh=template.content;
    for(const field of host.querySelectorAll('[data-ocr-field]')){
      const next=fresh.querySelector(`[data-ocr-field="${field.dataset.ocrField}"]`);
      if(field!==source&&next&&field.value!==next.value)field.value=next.value;
    }
    for(const selector of ['.calculated','.ocr-notice-slot','.rating-reference > span','.review-fields > .validation']){
      const current=host.querySelector(selector),next=fresh.querySelector(selector);
      if(current&&next){if(current.innerHTML!==next.innerHTML)current.innerHTML=next.innerHTML;current.className=next.className;}
    }
    for(const button of host.querySelectorAll('[data-action]')){
      const selector=`[data-action="${button.dataset.action}"]${button.dataset.index==null?'':`[data-index="${button.dataset.index}"]`}`;
      const next=fresh.querySelector(selector);
      if(next){button.disabled=next.disabled;button.className=next.className;}
    }
    return;
  }
  const wasOpen=$('.review-original details')?.open||false;
  host.innerHTML=modalView();
  const content=$('.review-content');if(content)content.scrollTop=scroll;
  const details=$('.review-original details');if(details)details.open=wasOpen;
}
async function checkMedia(force=false){
  if(mediaCheck.revision===mediaRevision&&(mediaCheck.status==='checking'||!force&&mediaCheck.status==='done'))return;
  const revision=mediaRevision;mediaCheck={revision,status:'checking',issues:[],files:0};if(view==='export')render();
  try{const result=await checkTimelineMedia(p,file=>api.probe(file));if(revision!==mediaRevision)return;mediaCheck={revision,status:'done',...result};}
  catch(error){if(revision!==mediaRevision)return;mediaCheck={revision,status:'done',files:0,issues:[{code:'media-check',message:error.message}]};}
  if(view==='export')render();
}
function entriesView(){
  const list=best(),avg=list.length?list.reduce((n,e)=>n+(e.rating??0),0)/list.length:0,scene=currentScene(),pages=Math.max(1,Math.ceil(list.length/10));
  return `${panelHeader('','成绩与剪辑','')}<div class="hero-actions">${button('ocr','长分表 OCR','primary',ocrRunning?'disabled':'')}${button('import','导入 JSON / CSV','outline')}${button('add','手动添加','quiet')}${button('scan','扫描素材目录','outline')}${button('match','自动匹配空白素材','quiet',assets.length?'':'disabled')}</div>
  <div class="stats"><div><span>BEST ${p.settings.count} 均值</span><strong>${fmtRating(avg)}</strong><small>${list.length} 个谱面</small></div><div><span>最高单曲 Potential</span><strong>${fmtRating(list[0]?.rating)}</strong><small>${h(list[0]?.title||'等待导入')}</small></div><div><span>录像素材</span><strong>${list.filter(e=>e.video).length}<em> / ${list.length}</em></strong><small>${assets.length?'已扫描 '+assets.length+' 个素材':'可扫描目录自动匹配'}</small></div><div><span>待校对成绩</span><strong>${p.entries.filter(e=>!e.reviewed||issues(e,p).length).length}</strong><small>右键或点击编辑</small></div></div>
  <div class="editor-grid workbench-wide"><section class="preview-panel"><div class="panel-top"><div class="segmented">${['song','overview'].map((v,i)=>`<button data-action="scene" data-scene="${v}" class="${sceneType===v?'active':''}">${['单曲展示','分表总览'][i]}</button>`).join('')}</div>${sceneType==='overview'?`<div class="overview-pages">${button('overview-prev','上一页','quiet',overviewPage===0?'disabled':'')}<select data-overview-page aria-label="总览页码">${Array.from({length:pages},(_,i)=>`<option value="${i}" ${i===overviewPage?'selected':''}>第 ${i+1} / ${pages} 页</option>`).join('')}</select>${button('overview-next','下一页','quiet',overviewPage>=pages-1?'disabled':'')}</div>`:''}<span class="preview-res">${p.settings.width} × ${p.settings.width*9/16} · ${p.settings.fps} FPS</span></div><div class="preview-wrap"><iframe id="preview" src="frame.html" title="影片实时预览"></iframe></div><div class="player-controls">${button('play',playing?'暂停':'播放片段','play',scene.duration<=0?'disabled':'')}${button('play-all','从此处连续预览','quiet')}<input id="scrub" aria-label="预览进度" type="range" min="0" max="${scene.duration}" step=".001" value="${previewElapsed}"><span id="play-time">${clock(previewElapsed)} / ${clock(scene.duration)}</span></div><div class="timeline">${timelineCards(p,selectedClipId)}</div><div id="clip-editor-root">${workbenchView(p,selectedClipId)}</div></section></div>
  <section class="table-panel"><div class="table-toolbar"><div><h2>成绩列表 <span>${p.entries.length}</span></h2><p>按 Potential 排名，影片顺序可单独调整</p></div><div class="table-tools"><input id="search" placeholder="搜索曲名或难度…" value="${h(search)}" aria-label="搜索成绩"><select id="filter" aria-label="成绩筛选">${options(['all','review','video'],filter,{all:'全部成绩',review:'需要校对',video:'缺少影片'})}</select></div></div><div class="table-scroll"><table><thead><tr><th>排名</th><th>曲目 / 难度</th><th>分数</th><th>POTENTIAL</th><th>素材</th><th>校对状态</th><th></th></tr></thead><tbody>${tableRows()}</tbody></table></div></section>`;
}
function inspector(){
  const e=entry();if(!e)return '<div class="empty-inspector"><b>◇</b><h3>从一份成绩开始</h3><p>支持长分表 OCR、JSON、CSV<br>也可以手动填写。</p></div>';
  const errs=issues(e,p),rank=best().find(x=>x.id===e.id)?.rank;
  return `<div class="inspector-head"><span>成绩详情</span><b>${rank?'B'+String(rank).padStart(2,'0'):'未入选'}</b></div><div class="inspector-form">${field('曲名','title',e.title)}<div class="field-pair"><label class="field"><span>谱面难度</span><select data-field="difficulty">${options(DIFFICULTIES,e.difficulty)}</select></label>${field('谱面定数','constant',e.constant,'number','min="0" max="15" step="0.1"')}</div>${field('分数','score',e.score,'text','inputmode="numeric" placeholder="09\'987\'654"')}<div class="field-pair"><label class="field"><span>通关状态</span><select data-field="clear">${options(CLEARS,e.clear,{UNKNOWN:'未确认',TL:'TL · Track Lost',EC:'EC · Easy Clear',NC:'NC · Normal Clear',HC:'HC · Hard Clear',TC:'TC · Track Complete',FR:'FR · Full Recall',PM:'PM · Pure Memory'})}</select></label><div class="calculated"><span>${e.ratingOverride!=null?'单曲 Potential · 手动覆盖':'单曲 Potential · 自动计算'}</span><strong>${fmtRating(rating(e,p.settings.rule))}</strong></div></div><div class="field-pair">${field('Far','far',e.far,'number','min="0" step="1"')}${field('Lost','lost',e.lost,'number','min="0" step="1"')}</div><label class="field"><span>短评 <small>${e.comment.length} / 500</small></span><textarea data-field="comment" rows="4" placeholder="在这里输入或粘贴短评文字、emoji">${h(e.comment)}</textarea></label>${commentPreviewHtml(e)}<details class="advanced"><summary>更多字段 / 自定义 Potential</summary>${field('曲师','artist',e.artist)}${field('外号 / 素材匹配别名','alias',e.alias)}${field('Potential 覆盖值（留空按公式计算）','ratingOverride',e.ratingOverride,'number','min="0" max="20" step="0.0001"')}<label class="checkbox"><input type="checkbox" data-field="enabled" ${e.enabled?'checked':''}>参与 Best ${p.settings.count} 筛选</label></details>${e.sourceThumbnail?`<details class="source-preview"><summary>查看 OCR 原图与读数</summary><img src="${e.sourceThumbnail}" alt="原始成绩卡"><pre>${h(e.ocrRaw||'')}</pre></details>`:''}${errs.length?`<div class="validation error-text">${errs.map(h).join('<br>')}</div>`:!e.reviewed?`<div class="validation amber-text">${h((e.warnings||[]).slice(0,3).join('；')||'请对照原图确认识别结果。')}</div>`:''}<div class="inspector-bottom">${button('confirm',e.reviewed?'✓ 已确认':'✓ 确认此条成绩',e.reviewed?'confirmed':'primary',errs.length?'disabled':'')}${button('delete','删除','danger quiet')}</div></div>`;
}
function tableRows(){
  const ranks=new Map(best().map(e=>[e.id,e.rank]));
  const entries=[...p.entries].sort((a,b)=>(ranks.get(a.id)??999)-(ranks.get(b.id)??999));
  const shown=entries.filter(e=>(e.title+' '+e.difficulty+' '+e.alias).toLowerCase().includes(search.toLowerCase())).filter(e=>filter==='review'?(!e.reviewed||issues(e,p).length):filter==='video'?!e.video:true);
  if(!shown.length)return `<tr><td colspan="7" class="empty-row">${p.entries.length?'没有符合条件的成绩':'你的分表还是空白。导入长分表，或手动添加第一首。'}</td></tr>`;
  return shown.map(e=>{const errs=issues(e,p);return `<tr data-action="select" data-id="${e.id}" class="${selected===e.id?'selected':''}"><td><b class="rank">${ranks.has(e.id)?String(ranks.get(e.id)).padStart(2,'0'):'—'}</b></td><td><strong class="table-title">${h(e.title||'未命名曲目')}</strong><span class="table-sub"><b class="diff ${e.difficulty}">${e.difficulty}</b> ${e.constant??'—'} ${!e.enabled?' · 已停用':''}</span></td><td class="mono">${fmtScore(e.score)}<small class="table-grade">${e.score!=null?grade(e):''}</small></td><td class="mono table-rating">${fmtRating(rating(e,p.settings.rule))}${e.ratingOverride!=null?'<small>导入 / 覆盖值</small>':''}</td><td><span class="asset-dot ${e.video?'ready':''}" title="${h(e.video||'未配置影片')}">▧</span><span class="asset-dot ${e.audio?'ready':''}" title="${h(e.audio||'未配置独立音频')}">♫</span></td><td><span class="status ${errs.length?'bad':e.reviewed?'good':'pending'}">${errs.length?'字段待补全':e.reviewed?'已确认':'待校对'}</span></td><td><button class="row-arrow" data-action="edit-entry" data-id="${e.id}" aria-label="编辑 ${h(e.title)}">↗</button></td></tr>`;}).join('');
}
function filePicker(e,key,label,kind){const file=e[key];return `<div class="file-row"><span>${label}</span><div><button class="file-path ${file?'has-file':''}" data-action="pick-entry" data-id="${e.id}" data-key="${key}" data-kind="${kind}" title="${h(file||'选择本地文件')}">${file?'✓ '+h(file.split(/[\\/]/).pop()):'＋ 选择本地文件'}</button>${file?`<button class="icon-button" data-action="clear-entry-file" data-id="${e.id}" data-key="${key}" aria-label="移除${label}">×</button>`:''}</div></div>`;}
function mediaView(){return `${panelHeader('LOCAL MEDIA LIBRARY','素材','按曲名与难度匹配本地素材。')}<div class="hero-actions">${button('scan','⌑ 扫描素材目录','primary')}${button('match','自动匹配空白素材','outline',assets.length?'':'disabled')}</div><div class="library-note"><div class="library-icon">⌑</div><div><strong>${assetDir?h(assetDir):'选择一个保存谱面录像、歌曲音频与曲绘的文件夹'}</strong><p>${assets.length?`已找到 ${assets.filter(a=>a.kind==='video').length} 个视频、${assets.filter(a=>a.kind==='audio').length} 个音频、${assets.filter(a=>a.kind==='jacket').length} 张图片。手动指定的素材会优先保留。`:'支持 MP4 / MKV / MOV、MP3 / M4A / FLAC、JPG / PNG。子目录也会一起扫描。'}</p></div></div><div class="media-list">${best().map(e=>`<section class="media-card"><div class="media-card-title"><span class="rank">${String(e.rank).padStart(2,'0')}</span><h2>${h(e.title)}</h2><b class="diff ${e.difficulty}">${e.difficulty}</b><span>${e.constant??'—'}</span><button class="btn quiet" data-action="edit-entry" data-id="${e.id}">编辑成绩 ↗</button></div><div class="media-fields">${filePicker(e,'video','谱面影片','video')}${filePicker(e,'audio','独立音频','audio')}${filePicker(e,'jacket','本曲图片（供图片组件使用）','image')}</div><div class="timing-fields">${fieldForEntry(e,'影片起点（秒）','start',e.start)}${fieldForEntry(e,'音频起点（秒）','audioStart',e.audioStart)}${fieldForEntry(e,'展示时长（秒）','duration',e.duration)}<p>${e.probe?`影片长度 ${clock(e.probe.duration)} · ${e.probe.width||'—'} × ${e.probe.height||'—'}`:'独立音频优先，其次使用录像原声。'}</p></div></section>`).join('')||'<div class="empty-card">先在成绩中导入或填写成绩，再为它们搭配本地素材。</div>'}</div>`;}
function fieldForEntry(e,label,key,value){return `<label class="field"><span>${label}</span><input type="number" min="${key==='duration'?'.5':'0'}" max="${key==='duration'?'600':'86400'}" step=".1" data-field="${key}" data-id="${e.id}" value="${h(value)}"></label>`;}
function setting(label,key,type='number',attrs=''){return `<label class="field"><span>${label}</span><input data-setting="${key}" type="${type}" value="${h(p.settings[key])}" ${attrs}></label>`;}
function settingsView(){return `${panelHeader('MAKE IT YOURS','影片设置','')}<div class="impression-picker"><span>界面配色</span>${[['hikari','光'],['tairitsu','对立'],['sakuya','咲弥'],['luna','露娜']].map(([key,name])=>`<button class="impression ${uiTheme===key?'selected':''}" data-action="ui-theme" data-theme="${key}"><span aria-hidden="true" style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${({hikari:'#a6506b',tairitsu:'#626a9a',sakuya:'#4f866d',luna:'#786092'})[key]};margin:6px 4px"></span>${name}</button>`).join('')}</div><div class="settings-grid"><section class="settings-card"><div class="card-number"><span>玩家信息</span></div>${[['工程名称','name'],['玩家名称','player'],['账号 Potential（可选）','potential'],['记录日期','date']].map(([label,key])=>`<label class="field"><span>${label}</span><input data-project="${key}" value="${h(p[key])}" maxlength="60" type="${key==='date'?'date':'text'}"></label>`).join('')}<p class="help">账号 Potential 由你填写；成绩均值根据导入的 Best ${p.settings.count} 计算。</p></section><section class="settings-card"><div class="card-number"><span>画面与规则</span></div><div class="theme-grid">${[['dusk','暮光','深蓝紫画布'],['dawn','白昼','雾白画布']].map(([v,name,desc])=>`<button data-action="theme" data-theme="${v}" class="theme-card ${v} ${p.settings.theme===v?'selected':''}"><div><i></i><i></i><i></i></div><strong>${name} ${p.settings.theme===v?'✓':''}</strong><small>${desc}</small></button>`).join('')}</div><label class="field"><span>分表数量</span><select data-setting="count">${options([50,30],p.settings.count,{50:'Best 50 · 新版分表',30:'Best 30 · 历史分表'})}</select></label><label class="field"><span>Potential 规则</span><select data-setting="rule">${options(['v7','legacy'],p.settings.rule,{v7:'v7 · 基础 Potential + 通关奖励 0.2',legacy:'旧版 · 基础 Potential'})}</select></label><p class="help">有通关记录的 EC / NC / HC / TC / FR / PM 在 v7 规则下计入 0.2 奖励。UNKNOWN 不推测奖励；导入的 Potential 覆盖值优先。</p><div class="setting-file"><span>自定义背景</span>${button('pick-setting',p.settings.background?'✓ '+h(p.settings.background.split(/[\\/]/).pop()):'＋ 选择背景图片','outline','data-key="background" data-kind="image"')}${p.settings.background?button('clear-setting','移除','quiet','data-key="background"'):''}</div>${setting('背景模糊（px）','backgroundBlur','number','min="0" max="50" step="1"')}${setting('背景遮罩强度（0–1）','backgroundShade','number','min="0" max="1" step=".05"')}</section></div>`;}
function exportView(){
  const list=best(),plan=buildTimeline(p),timeline=plan.scenes,total=plan.duration,invalid=list.filter(e=>issues(e,p).length||!e.reviewed),mediaIssues=[...new Map([...plan.issues,...mediaCheck.issues].map(i=>[i.message,i])).values()],checking=mediaCheck.status!=='done';
  return `${panelHeader('READY FOR THE BIG SCREEN','导出','')}<div class="export-grid"><section class="settings-card"><div class="card-number"><span>导出规格</span></div><label class="field"><span>画面分辨率</span><select data-setting="width">${options([1920,1280],p.settings.width,{1920:'1920 × 1080 · Full HD',1280:'1280 × 720 · HD'})}</select></label><label class="field"><span>帧率</span><select data-setting="fps">${options([60,30],p.settings.fps,{60:'60 FPS · 流畅',30:'30 FPS · 轻量'})}</select></label><label class="field"><span>编码器</span><select data-setting="encoder">${options(['auto','software'],p.settings.encoder,{auto:'自动 · 优先硬件，失败回退软件',software:'软件编码 · H.264 / libx264'})}</select></label>${setting('画质 CRF / CQ（越小越清晰）','crf','number','min="14" max="30" step="1"')}<p class="help">建议 18–23。默认在本地检查硬件编码器，FFmpeg 随程序提供。</p><div class="export-buttons">${button('export','↗ 导出完整影片','primary',(!list.length||invalid.length||mediaIssues.length||checking||job?.kind==='export'&&!job.done)?'disabled':'')}${button('export-single','先导出当前单曲','outline',(!list.length||job?.kind==='export'&&!job.done)?'disabled':'')}</div></section><section class="export-summary"><div class="export-cover"><span>ARCAEA / BEST ${p.settings.count}</span><strong>${h(p.player)}</strong><p>${h(p.name)}</p><b>${clock(total)}</b></div><div class="export-summary-stats"><div><strong>${list.length}</strong><span>谱面</span></div><div><strong>${timeline.length}</strong><span>影片片段</span></div><div><strong>${clock(total)}</strong><span>预计总时长</span></div></div><div class="preflight"><div class="${invalid.length?'amber-text':'good-text'}">${invalid.length?'● '+invalid.length+' 条成绩需要补全或确认':'✓ 成绩数据已准备好'}</div><div>${info?.ffmpeg?'✓ 本地 FFmpeg 已就绪':'× 缺少 FFmpeg，请查看 README'}</div><div>${list.filter(e=>e.video).length} / ${list.length} 首已配置谱面影片</div><div class="${mediaIssues.length?'amber-text':'good-text'}">${checking?'正在检查素材余量…':mediaIssues.length?'● '+mediaIssues.length+' 个素材或剪辑问题':'✓ '+mediaCheck.files+' 个本地素材已检查'}</div>${mediaIssues.length?'<ul class="preflight-issues">'+mediaIssues.map(i=>'<li>'+h(i.message)+'</li>').join('')+'</ul>':''}<p>${invalid.length?'回到工作台逐条校对后，即可导出完整影片。':'动画、歌曲及全部总览页都需要足够素材余量。未配置录像的曲目可使用主题画面；图片请在“视频布局”中添加。'}</p>${button('check-media','重新检查素材','quiet',checking?'disabled':'')}</div></section></div><div id="job-block"></div>${lastExport?`<section class="success-card"><span>✓</span><div><h3>影片已保存到本机</h3><p>${h(lastExport.path)}</p><small>${lastExport.width} × ${lastExport.height} · ${lastExport.fps} FPS · ${clock(lastExport.duration)}</small></div>${button('reveal','在文件夹中查看','outline')}</section>`:''}`;
}
function updateJobs(){
  const el=$('#job-block');if(!el)return;
  el.innerHTML=job?`<section class="job-card"><div><span class="${job.done?'':'spinner'}">${job.done?(job.error?'!':'✓'):''}</span><div><h3>${h(job.stage||'本地任务')}</h3><p>${h(job.error||job.detail||'正在处理，请稍候…')}</p></div>${!job.done?button(job.kind==='ocr'?'cancel-ocr':'cancel-export','取消','outline'):''}</div><progress max="1" value="${job.ratio||0}"></progress><small>${Math.round((job.ratio||0)*100)}%${job.encoder?' · '+job.encoder:''}</small></section>`:'';
}
function modalView(){
  if(modal==='entry-edit'&&entryDraft)return `<div class="modal-backdrop"><section class="modal entry-edit-modal"><div class="modal-head"><div><h2>${entryIsNew?'添加成绩':'编辑成绩'}</h2><p>保存后更新成绩；取消保留原内容。</p></div>${button('cancel-entry','×','quiet')}</div><div class="entry-edit-body">${inspector()}</div><div class="modal-footer">${button('cancel-entry','取消','outline')}${button('save-entry','保存成绩','primary')}</div></section></div>`;
  if(modal==='ocr-import')return `<div class="modal-backdrop"><section class="modal ocr-config-modal"><div class="modal-head"><div><h2>导入长分表</h2><p>选择或拖入一张图片，下一步调整识别范围。</p></div>${button('close-ocr-config','×','quiet')}</div><div class="ocr-dropzone" data-action="browse-ocr" role="button" tabindex="0"><strong>将长分表图片拖到这里</strong><p>PNG / JPG / WEBP / BMP</p>${button('browse-ocr','选择图片','primary')}</div></section></div>`;

  if(modal==='ocr-config')return `<div class="modal-backdrop"><section class="modal ocr-config-modal">
    <div class="modal-head"><div><h2>导入长分表</h2><p>${h(ocrFile.split(/[\\/]/).pop())}</p></div>${button('close-ocr-config','×','quiet')}</div>
    <div class="ocr-config-body"><div class="ocr-image-container"><img src="${h(mediaUrl(ocrFile))}" alt="待识别分表"><div class="ocr-grid-preview" style="left:${ocrOptions.left*100}%;right:${(1-ocrOptions.right)*100}%;top:${ocrOptions.top*100}%;bottom:${(1-ocrOptions.bottom)*100}%;grid-template-columns:repeat(${ocrOptions.cols},1fr);grid-template-rows:repeat(${ocrOptions.rows},1fr)">${Array.from({length:Math.min(100,ocrOptions.cols*ocrOptions.rows)},()=>'<i></i>').join('')}</div></div>
    <div><label class="field"><span>分表版式</span><select data-ocr-option="layout">${options(['auto','player','poster'],ocrOptions.layout,{auto:'自动 · 根据图片比例选择',player:'Player Bests · 文字条目型',poster:'曲绘卡片型 · 5 × 10 等网格'})}</select></label><p class="help">Player Bests 自动定位；曲绘卡片型可调整网格。边界只框成绩区，不含页头与页脚。</p>
    <div class="field-pair">${ocrOption('列数','cols',1,10)}${ocrOption('行数','rows',1,30)}</div>
    <div class="field-pair">${ocrOption('左边界 %','left',0,90,true)}${ocrOption('右边界 %','right',10,100,true)}</div>
    <div class="field-pair">${ocrOption('上边界 %','top',0,90,true)}${ocrOption('下边界 %','bottom',10,100,true)}</div>
    <p class="help">最多 100 格。网格内字段位置需与所选版式一致。</p>${button('start-ocr','开始离线识别','primary')}</div></div></section></div>`;
  if(modal==='ocr-busy')return `<div class="modal-backdrop"><section class="modal progress-modal"><h2>正在识别分表</h2><p>识别完成后请逐条校对。</p><div id="ocr-progress-text">${h(job?.stage||'加载识别模型…')}</div><progress id="ocr-progress" max="1" value="${job?.ratio||0}"></progress>${button('cancel-ocr','取消识别','outline')}</section></div>`;
  if(modal!=='ocr-review'||!ocrDraft)return '';
  const e=ocrDraft[ocrIndex],errs=issues(e,p),total=ocrDraft.length;
  return `<div class="modal-backdrop"><section class="modal review-modal"><div class="modal-head"><div><h2>校对识别结果</h2><p>${total} 张成绩卡 · ${h(ocrFile.split(/[\\/]/).pop())}</p></div>${button('close-modal','×','quiet')}</div><div class="review-content"><div class="review-original"><div class="review-original-label">原始成绩卡 · 第 ${e.sourceIndex} 格</div><img src="${e.sourceThumbnail}" alt="原始成绩卡"><div class="review-card-picker">${ocrDraft.map((x,i)=>`<button data-action="ocr-select" data-index="${i}" class="${i===ocrIndex?'active':''} ${issues(x,p).length?'bad':''}">${i+1}</button>`).join('')}</div><details><summary>OCR 原始文本</summary><pre>${h(e.ocrRaw)}</pre></details><p class="help">曲名候选与定数来自内置离线表。无法确定的字段保留空白；图像识别仍需要人工检查。</p></div><div class="review-fields"><div class="review-count"><strong>${String(ocrIndex+1).padStart(2,'0')} <small>/ ${total}</small></strong><div>${button('ocr-prev','←','outline',ocrIndex===0?'disabled':'')}${button('ocr-next','→','outline',ocrIndex===total-1?'disabled':'')}</div></div>${ocrField('曲名','title',e.title)}${e.titleOptions?.length?`<label class="field"><span>本地曲库候选</span><select id="ocr-candidate"><option value="">选择候选曲名…</option>${e.titleOptions.map(x=>`<option value="${h(x.title)}">${h(x.title)}</option>`).join('')}</select></label>`:''}<div class="field-pair"><label class="field"><span>难度</span><select data-ocr-field="difficulty">${options(['',...DIFFICULTIES],e.difficulty,{'':'待确认'})}</select></label>${ocrField('定数','constant',e.constant,'number')}</div>${ocrField('分数','score',e.score)}<div class="field-pair"><label class="field"><span>通关状态</span><select data-ocr-field="clear">${options(CLEARS,e.clear)}</select></label><div class="calculated"><span>${e.ratingOverride!=null?'单曲 Potential · 手动覆盖':'单曲 Potential · 自动计算'}</span><strong>${fmtRating(rating(e,p.settings.rule))}</strong></div></div><div class="ocr-notice-slot">${ocrRatingNotice(e,p.settings.rule)}</div><div class="field-pair">${ocrField('Far','far',e.far,'number')}${ocrField('Lost','lost',e.lost,'number')}</div>${ocrField('单曲 Potential 覆盖值（留空自动计算）','ratingOverride',e.ratingOverride,'number')}<div class="rating-reference"><span>图中 Potential ${fmtRating(e.detectedRating)} · 公式 ${fmtRating(rating({...e,ratingOverride:null},p.settings.rule))}</span>${button('ocr-use-rating','使用图中值','quiet',Number.isFinite(e.detectedRating)?'':'disabled')}${button('ocr-reset-rating','恢复自动','quiet')}</div><div class="validation ${errs.length?'error-text':'amber-text'}">${h(errs.length?errs.join('；'):e.warnings.join('；')||'请检查识别结果。')}</div></div></div><div class="modal-footer"><span>不确定的条目可以先导入，继续校对。</span>${button('ocr-import-pending','导入，保留待校对','outline')}${button('ocr-import-confirmed','已核对全部，导入成绩','primary',ocrDraft.some(e=>issues(e,p).length)?'disabled':'')}</div></section></div>`;
}
function ocrOption(label,key,min,max,percent=false){return `<label class="field"><span>${label}</span><input type="number" data-ocr-option="${key}" data-percent="${percent}" min="${min}" max="${max}" step="${percent?'.1':'1'}" value="${Number((ocrOptions[key]*(percent?100:1)).toFixed(2))}"></label>`;}
function ocrRatingNotice(e,rule){
  const calculated=fmtRating(rating({...e,ratingOverride:null},rule));
  if(e.ratingOverride!=null)return `<p class="rating-notice">正在使用手动覆盖值 ${fmtRating(e.ratingOverride)}，公式值为 ${calculated}。点击“恢复自动”可清除覆盖。</p>`;
  if(e.clear==='UNKNOWN')return `<p class="rating-notice">通关状态待确认，自动计算未计通关奖励。图中 Potential ${fmtRating(e.detectedRating)}，当前公式 ${calculated}。</p>`;
  if(Number.isFinite(e.detectedRating)&&calculated!==fmtRating(e.detectedRating))return `<p class="rating-notice">图中 Potential ${fmtRating(e.detectedRating)} 与公式 ${calculated} 不一致，请核对分数、定数和通关状态。</p>`;
  return '';
}
function ocrField(label,key,value,type='text'){return `<label class="field"><span>${label}</span><input data-ocr-field="${key}" type="${type}" value="${h(value??'')}" ${type==='number'?'step="any" min="0"':''}></label>`;}
function stopPlayback(){pauseWorkbench();player.pause();}
function startPlayback(all=false){pauseWorkbench();if(player.running){player.pause();return;}const scene=currentScene();if(scene.duration<=0)return;player.play({all,from:(scene.at||0)+(all?0:Math.min(previewElapsed,scene.duration-.01))});}
async function action(a,el){
  if(a==='ui-theme'){uiTheme=el.dataset.theme;localStorage.setItem('arcshow.ui-theme',uiTheme);document.documentElement.dataset.impression=uiTheme;p.settings.impression=uiTheme;changed();render();return;}
  if(a==='ui-zoom-in'){setUiZoom(uiZoom+.1);return;}
  if(a==='ui-zoom-out'){setUiZoom(uiZoom-.1);return;}
  if(a==='ui-zoom-reset'){setUiZoom(1);return;}
  if(['nav','select','scene','edit-entry','overview-prev','overview-next'].includes(a))stopPlayback();
  if(a==='nav'){view=el.dataset.view==='media'?'entries':el.dataset.view;if(view==='layout'&&sceneType==='animation')sceneType='song';render();}
  if(a==='scene'){sceneType=el.dataset.scene==='overview'?'overview':'song';selectedClipId=sceneType==='overview'?'overview:'+(overviewPage+1):buildTimeline(p).scenes.find(s=>s.entry?.id===selected)?.clipId||ensureSequence(p).find(c=>c.type==='song')?.id||'';previewElapsed=0;render();}
  if(a==='edit-entry'){editEntry(el.dataset.id);return;}
  if(a==='select'){selected=el.dataset.id;const found=buildTimeline(p).scenes.find(s=>s.entry?.id===selected);if(found)selectClip(found.clipId);else editEntry(selected);return;}
  if(a==='add'){editEntry('',true);return;}
  if(a==='cancel-entry'){closeEntryEditor();return;}
  if(a==='save-entry'){if(!entryDraft)return;const errs=issues(entryDraft,p);if(errs.length)throw new Error(errs.join('；'));entryDraft.reviewed=true;if(entryIsNew){if(p.demo){p.entries=[];p.demo=false;}p.entries.push(entryDraft);}else{const i=p.entries.findIndex(e=>e.id===entryDraft.id);if(i<0)throw new Error('成绩已不存在');p.entries[i]=entryDraft;}entryDraft=null;modal=null;changed();render();return;}
  if(a==='overview-prev'||a==='overview-next'){overviewPage+=a==='overview-prev'?-1:1;selectedClipId='overview:'+(overviewPage+1);previewElapsed=0;render();return;}
  if(a==='browse-ocr'){const file=await api.pick('image');if(file){ocrFile=await api.acceptImage(file);modal='ocr-config';render();}return;}
  if(a==='new'){if(p.entries.length&&!confirm('新建一个空白工程？当前内容已自动保存；如需保留多个工程，请先点击“保存工程”。'))return;stopPlayback();p=newProject();selected='';projectPath='';lastExport=null;changed();render();}
  if(a==='demo'){stopPlayback();p=demoProject();selected=p.entries[7].id;changed();render();}
  if(a==='open'){const r=await api.open();if(r){stopPlayback();p=r.project;projectPath=r.path;selected=p.entries[0]?.id;dirty=false;saveText='已打开本地工程';changed();render();}}
  if(a==='save'){const r=await api.save(p,projectPath);if(r){projectPath=r.path;p.savedAt=r.savedAt;dirty=false;saveText='工程已保存';render();toast('工程已保存：'+r.path);}}
  if(a==='import'){const r=await api.importData();if(r){if(p.demo)p.entries=[];p.entries.push(...r.entries);selected=r.entries[0]?.id;p.demo=false;changed();render();toast(`已导入 ${r.entries.length} 条成绩`);}}
  if(a==='confirm'){const e=entry();if(e&&!issues(e,p).length){e.reviewed=true;changed();render();}}
  if(a==='delete'){const e=p.entries.find(x=>x.id===(el?.dataset.id||selected));if(e&&confirm(`删除「${e.title||'未命名曲目'}」？`)){p.entries=p.entries.filter(x=>x.id!==e.id);p.sequence=(p.sequence||[]).filter(c=>c.entryId!==e.id);p.audioGroups=(p.audioGroups||[]).filter(g=>!g.clipIds.includes('song:'+e.id));entryDraft=null;modal=null;selected=p.entries[0]?.id;selectedClipId='song:'+selected;changed();render();}}
  if(a==='theme'){p.settings.theme=el.dataset.theme;changed();render();}
  if(a==='scan'){toast('正在扫描本地素材…');const r=await api.scan();if(r){assets=r.files;assetDir=r.dir;render();toast(`找到 ${assets.length} 个素材${r.truncated?'（已达到扫描上限）':''}`);}}
  if(a==='match'){let count=0;for(const e of p.entries){const found=matchMedia(e,assets);if(Object.keys(found).length){Object.assign(e,found);count++;}}changed();render();toast(`已为 ${count} 首歌曲填充素材。重名且无法区分的文件请手动指定。`);}
  if(a==='pick-entry'){const e=p.entries.find(x=>x.id===el.dataset.id),key=el.dataset.key;const file=await api.pick(el.dataset.kind);if(file){const probe=await api.probe(file);e[key]=file;if(key==='video')e.probe=probe;changed();render();}}
  if(a==='clear-entry-file'){const e=p.entries.find(x=>x.id===el.dataset.id);e[el.dataset.key]='';changed();render();}
  if(a==='pick-setting'){const file=await api.pick(el.dataset.kind);if(file){await api.probe(file);p.settings[el.dataset.key]=file;changed();render();}}
  if(a==='clear-setting'){p.settings[el.dataset.key]='';changed();render();}
  if(a==='apply-duration'){if(!confirm('将全部曲目的展示时长设置为默认值？'))return;if(changeWorkbench(p=>{for(const e of p.entries)e.duration=p.settings.defaultDuration;}))toast('已更新所有曲目的展示时长');}
  if(a==='play')startPlayback();if(a==='play-all')startPlayback(true);
  if(a==='ocr'){stopPlayback();modal='ocr-import';render();}
  if(a==='close-ocr-config'){modal=null;render();}
  if(a==='start-ocr'){
    stopPlayback();modal='ocr-busy';ocrRunning=true;job={kind:'ocr',ratio:0,stage:'加载本地模型'};render();
    try{const r=await api.ocr(ocrFile,{...ocrOptions,rule:p.settings.rule});if(!r){modal=null;render();return;}ocrFile=r.file;ocrDraft=r.cards.map(c=>newEntry({title:c.title,difficulty:c.difficulty,constant:c.constant,score:c.score,clear:CLEARS.includes(c.clear)?c.clear:'UNKNOWN',far:c.far,lost:c.lost,detectedRating:c.detectedRating,sourceThumbnail:c.thumbnail,sourceIndex:c.index,titleOptions:c.titleOptions,ocrRaw:c.raw,warnings:c.warnings,reviewed:false,duration:p.settings.defaultDuration}));if(!ocrDraft.length)throw new Error('没有识别到可用成绩，请检查图片布局和清晰度');ocrIndex=0;modal='ocr-review';render();}
    catch(error){modal=null;render();throw error;}finally{ocrRunning=false;}
  }
  if(a==='cancel-ocr'){await api.cancelOcr();modal=null;render();}
  if(a==='ocr-use-rating'){ocrDraft[ocrIndex].ratingOverride=ocrDraft[ocrIndex].detectedRating;refreshOcrReview();}
  if(a==='ocr-reset-rating'){ocrDraft[ocrIndex].ratingOverride=null;refreshOcrReview();}
  if(a==='ocr-select'){ocrIndex=Number(el.dataset.index);refreshOcrReview();}
  if(a==='ocr-prev'){ocrIndex=Math.max(0,ocrIndex-1);refreshOcrReview();}
  if(a==='ocr-next'){ocrIndex=Math.min(ocrDraft.length-1,ocrIndex+1);refreshOcrReview();}
  if(a==='close-modal'){if(confirm('关闭本次识别结果？尚未导入的内容将不会保留。')){modal=null;ocrDraft=null;render();}}
  if(a==='ocr-import-pending'||a==='ocr-import-confirmed'){
    const confirmed=a==='ocr-import-confirmed';for(const e of ocrDraft)e.reviewed=confirmed;
    if(p.demo){p.entries=[];p.demo=false;}
    p.entries.push(...ocrDraft);selected=ocrDraft[0].id;const n=ocrDraft.length;ocrDraft=null;modal=null;view='entries';changed();render();toast(`已预填 ${n} 条成绩${confirmed?'，校对已确认':'，请继续校对黄色条目'}`);
  }
  if(a==='export'||a==='export-single'){
    stopPlayback();view='export';lastExport=null;render();
    try{const singleId=a==='export-single'?selected:undefined,check=await checkTimelineMedia(p,file=>api.probe(file),{singleId});if(check.issues.length)throw new Error(check.issues.map(i=>i.message).join('；'));const result=await api.export(p,singleId);if(result){lastExport=result;render();toast('影片已导出到本机');}}
    catch(error){job={kind:'export',done:true,error:error.message,stage:'导出未完成'};render();throw error;}
  }
  if(a==='check-media'){await checkMedia(true);return;}
  if(a==='cancel-export')await api.cancelExport();
  if(a==='reveal'&&lastExport)await api.reveal(lastExport.path);
}
root.addEventListener('click',async event=>{const el=event.target.closest('[data-action]');if(!el||el.disabled)return;try{await action(el.dataset.action,el);}catch(error){toast(error.message,true);}});
root.addEventListener('change',event=>{
  const el=event.target;
  if(el.dataset.ocrOption){ocrOptions[el.dataset.ocrOption]=el.dataset.ocrOption==='layout'?el.value:Number(el.value)/(el.dataset.percent==='true'?100:1);render();return;}
  if(el.id==='filter'){filter=el.value;render();return;}
  if(el.dataset.ocrField){const key=el.dataset.ocrField;ocrDraft[ocrIndex][key]=numKeys.has(key)?numeric(el.value):el.value;refreshOcrReview({editing:true,source:el});return;}
  if(el.id==='ocr-candidate'){if(el.value){ocrDraft[ocrIndex].title=el.value;const song=info.songs.entries.find(s=>s.title===el.value);if(song?.tiers[ocrDraft[ocrIndex].difficulty]!=null)ocrDraft[ocrIndex].constant=song.tiers[ocrDraft[ocrIndex].difficulty];refreshOcrReview({editing:true});}return;}
  if(el.dataset.overviewPage!==undefined){overviewPage=Number(el.value);selectedClipId='overview:'+(overviewPage+1);previewElapsed=0;stopPlayback();render();return;}
  if(el.dataset.field){if(!entryDraft||!el.isConnected)return;const key=el.dataset.field;entryDraft[key]=el.type==='checkbox'?el.checked:numKeys.has(key)?numeric(el.value):el.value;stopPlayback();refreshEntryEditor(el);return;}
  if(el.dataset.setting){const key=el.dataset.setting,value=el.type==='checkbox'?el.checked:['count','width','fps','crf','intro','overview','overviewBlur','transition','segmentGap','volume','defaultDuration','backgroundBlur','backgroundShade','audioTransition','cutBlur'].includes(key)?Number(el.value):el.value;if(el.closest('.workbench-global,.bookend-editor')){if(el.type==='number'&&(el.value.trim()===''||!Number.isFinite(value))){toast('请输入有效数字；已保留原来的设置。',true);refreshWorkbench({editing:true});return;}const bounded=el.type==='number'?Math.max(el.min!==''?Number(el.min):-Infinity,Math.min(el.max!==''?Number(el.max):Infinity,value)):value;changeWorkbench(project=>{project.settings[key]=bounded;},{editing:el.type!=='checkbox',source:el});return;}p.settings[key]=value;if(key==='order'){if(confirm('恢复该排序会断开共同配乐连接。')){p.audioGroups=[];resetSequence(p,el.value);}}stopPlayback();changed();render();}
  if(el.dataset.project){const key=el.dataset.project,value=el.value;if(el.closest('.bookend-editor')){changeWorkbench(project=>{project[key]=value;},{editing:true,source:el});return;}p[key]=value;changed();render();}
});
function editComment(event){
  const field=event.target;if(field.dataset.field!=='comment'||event.isComposing)return;
  const target=entryDraft;if(!target)return;
  const value=truncateComment(field.value),caret=field.selectionStart;
  if(value!==field.value){field.value=value;field.setSelectionRange(Math.min(caret,value.length),Math.min(caret,value.length));}
  target.comment=value;refreshEntryEditor(field);
}
root.addEventListener('input',editComment);
root.addEventListener('compositionend',editComment);
bindCommentClipboard(root,{onImagePaste:()=>toast('复制的内容是图片。短评支持文字和 emoji，请复制表情字符本身。')});
root.addEventListener('input',event=>{if(event.target.dataset.ocrField&&ocrDraft){const el=event.target,key=el.dataset.ocrField;ocrDraft[ocrIndex][key]=numKeys.has(key)?numeric(el.value):el.value;refreshOcrReview({editing:true,source:el});return;}if(event.target.id==='search'){search=event.target.value;const tbody=$('tbody');if(tbody)tbody.innerHTML=tableRows();}if(event.target.id==='scrub'){stopPlayback();previewElapsed=Number(event.target.value);player.seek((currentScene().at||0)+previewElapsed);const t=$('#play-time');if(t)t.textContent=`${clock(previewElapsed)} / ${clock(currentScene().duration)}`;}});
const player=createTimelinePlayer({project:()=>p,current:currentScene,frame:()=>$('#preview'),waitForSceneReady:true,error:message=>toast(message,true),status:message=>{const time=$('#play-time');if(time)time.textContent=message||clock(previewElapsed)+' / '+clock(currentScene().duration);},state:value=>{playing=value;const b=$('[data-action="play"]');if(b)b.textContent=value?'暂停':'播放片段';if(!value&&pendingPlaybackEditor)playbackEditor(pendingPlaybackEditor,false);},scene:s=>{
  previewGap=s.type==='gap';const card=previewGap?buildTimeline(p).scenes.find(next=>next.clipId===s.incomingClipId)||s:s;
  sceneType=card.type;selectedClipId=card.clipId;if(card.entry)selected=card.entry.id;if(card.type==='overview')overviewPage=card.page-1;
  root.querySelectorAll('[data-clip-id]').forEach(el=>el.classList.toggle('selected',el.dataset.clipId===card.clipId));
  const iframe=$('#preview');if(iframe)iframe.contentWindow.postMessage({type:'scene',payload:previewPayload(p,s,{editing:false,playing})},'*');
  playbackEditor(card.clipId);
  root.querySelectorAll('tr[data-id]').forEach(el=>el.classList.toggle('selected',el.dataset.id===selected));
},time:(local,duration)=>{previewElapsed=previewGap?0:local;const scrub=$('#scrub');if(scrub){scrub.disabled=previewGap;scrub.max=duration;scrub.value=local;}const time=$('#play-time');if(time)time.textContent=(previewGap?'留白 ':'')+clock(local)+' / '+clock(duration);const page=$('[data-overview-page]');if(page)page.value=overviewPage;}});
bindWorkbench(root,{project:()=>p,selected:()=>selectedClipId,replace:project=>{p=project;},refresh:refreshWorkbench,changed:()=>changed(false),stop:stopPlayback,stopTimeline:()=>player.pause(),error:message=>toast(message,true),edit:editEntry,select:selectClip,pick:kind=>testPickQueue.length?Promise.resolve(testPickQueue.shift()):api.pick(kind),listen:(from,to,project)=>{pauseWorkbench();player.play({from,to,project});}});
root.addEventListener('contextmenu',event=>{const tr=event.target.closest('tr[data-id]');if(!tr)return;event.preventDefault();document.querySelector('.row-menu')?.remove();const menu=document.createElement('div');menu.className='row-menu';menu.style.left=Math.min(event.clientX/uiZoom,innerWidth/uiZoom-180)+'px';menu.style.top=Math.min(event.clientY/uiZoom,innerHeight/uiZoom-110)+'px';menu.innerHTML=`${button('edit-entry','编辑成绩','quiet','data-id="'+tr.dataset.id+'"')}${button('delete','删除成绩','danger quiet','data-id="'+tr.dataset.id+'"')}`;root.append(menu);});
root.addEventListener('dblclick',event=>{const tr=event.target.closest('tr[data-id]');if(tr)editEntry(tr.dataset.id);});
root.addEventListener('click',event=>{if(!event.target.closest('.row-menu'))document.querySelector('.row-menu')?.remove();});
root.addEventListener('dragover',event=>{const zone=event.target.closest('.ocr-dropzone');if(zone){event.preventDefault();zone.classList.add('drag-over');}});
root.addEventListener('dragleave',event=>event.target.closest('.ocr-dropzone')?.classList.remove('drag-over'));
root.addEventListener('drop',async event=>{if(!event.target.closest('.ocr-dropzone'))return;event.preventDefault();try{if(event.dataTransfer.files.length!==1)throw new Error('每次请拖入一张长分表图片');ocrFile=await api.acceptImage(api.filePath(event.dataTransfer.files[0]));modal='ocr-config';render();}catch(e){toast(e.message,true);}});
addEventListener('message',event=>{if(event.source===$('#preview')?.contentWindow&&event.data?.type==='media-error')toast(event.data.message||'背景素材加载失败',true);});
bindLayoutEditor(root,{project:()=>p,scene:()=>sceneType,refresh:render,preview:updatePreview,changed,pick:kind=>testPickQueue.length?Promise.resolve(testPickQueue.shift()):api.pick(kind),error:message=>toast(message,true)});
api.onProgress(data=>{
  if(data.done&&data.kind==='ocr'){if(job?.kind==='ocr')job={...job,...data};}
  else job={...(job?.kind===data.kind?job:{}),...data};
  updateJobs();const text=$('#ocr-progress-text'),bar=$('#ocr-progress');if(text)text.textContent=job.stage;if(bar)bar.value=job.ratio||0;
});
addEventListener('keydown',event=>{
  if(event.ctrlKey||event.metaKey){
    if(['+','=','-','_','0'].includes(event.key)){event.preventDefault();setUiZoom(event.key==='0'?1:uiZoom+(['+','='].includes(event.key)?.1:-.1));return;}
    if(event.key==='s'){event.preventDefault();action('save').catch(e=>toast(e.message,true));}
  }
  if(event.key==='Escape'){if(playing)stopPlayback();document.querySelector('.row-menu')?.remove();if(modal==='entry-edit')closeEntryEditor();}
});
api.onZoom(command=>setUiZoom(command==='reset'?1:uiZoom+(command==='in'?.1:-.1)));
render();
try{info=await api.info();const recovered=await api.recover();if(recovered){p=recovered;selected=p.entries[0]?.id;saveText='已恢复上次的本地工程';}render();}catch(error){toast(error.message,true);}
if(new URLSearchParams(location.search).get('test')==='1')window.arcTest={
  queuePick:file=>testPickQueue.push(file),
  get:()=>p,set:project=>{stopPlayback();p=project;selected=p.entries[0]?.id;selectedClipId='song:'+selected;sceneType='song';overviewPage=0;changed();render();},
  showOcrConfig:file=>{ocrFile=file;modal='ocr-config';render();},
  view:name=>{view=name==='media'?'entries':name;render();},select:id=>selectClip('song:'+id),
  scene:type=>{sceneType=type;render();},getScene:currentScene,
  showOcr:r=>{ocrFile=r.file;ocrDraft=r.cards.map(c=>newEntry({title:c.title,difficulty:c.difficulty,constant:c.constant,score:c.score,clear:CLEARS.includes(c.clear)?c.clear:'UNKNOWN',far:c.far,lost:c.lost,detectedRating:c.detectedRating,sourceThumbnail:c.thumbnail,sourceIndex:c.index,titleOptions:c.titleOptions,ocrRaw:c.raw,warnings:c.warnings,reviewed:false,duration:p.settings.defaultDuration}));ocrIndex=0;modal='ocr-review';render();}
};

import {normalize,numeric,rating,ranked} from './rating.mjs';
import {ensureSequence,resetSequence,buildTimeline,overviewEntries} from './timeline.mjs';
export {normalize,numeric,rating,ranked,ensureSequence,resetSequence,buildTimeline,overviewEntries};
import {normalizeLayout} from './layout.mjs';
import {normalizeTextStyles} from './text-styles.mjs';
import {truncateComment} from './comment-text.mjs';
export const DIFFICULTIES = ['PST', 'PRS', 'FTR', 'BYD', 'ETR', 'INS'];
export const CLEARS = ['UNKNOWN', 'TL', 'EC', 'NC', 'HC', 'TC', 'FR', 'PM'];
export const uid = () => globalThis.crypto.randomUUID();
export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const fmtScore = n => n == null ? '—' : String(Math.round(n)).padStart(8, '0').replace(/(\d{2})(\d{3})(\d{3})$/, "$1'$2'$3");
// Match the scorecard's four-decimal rounding. Snap only binary noise at
// half-unit boundaries; keep the full rating for ranking and averages.
export const fmtRating = n => {
  if (!Number.isFinite(n)) return '—';
  const scaled=n*10000, half=Math.round(scaled*2)/2;
  const exact=Math.abs(scaled-half)<=Number.EPSILON*Math.max(1,Math.abs(scaled))*8 ? half : scaled;
  return (Math.round(exact)/10000).toFixed(4);
};
export const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export function grade(e) {
  const x = Number(e.score);
  return x >= 10000000 ? 'PM' : x >= 9900000 ? 'EX+' : x >= 9800000 ? 'EX' : x >= 9500000 ? 'AA' : x >= 9200000 ? 'A' : x >= 8900000 ? 'B' : x >= 8600000 ? 'C' : 'D';
}
export function newEntry(fields = {}) {
  const e={id: uid(), songId:'', title:'', artist:'', alias:'', difficulty:'FTR', constant:null, score:null, clear:'UNKNOWN', far:null, lost:null, ratingOverride:null, comment:'', video:'', audio:'', jacket:'', background:'', audioMode:'auto', start:0, audioStart:0, duration:15, enabled:true, reviewed:true, warnings:[], ...fields};
  for(const k of ['id','songId','title','artist','alias','difficulty','clear','comment','video','audio','jacket','background','audioMode'])e[k]=e[k]==null?'':String(e[k]);
  if(!e.id)e.id=uid();
  if(!['auto','audio','video','silent'].includes(e.audioMode))e.audioMode='auto';
  e.comment=truncateComment(e.comment);e.title=e.title.slice(0,200);e.artist=e.artist.slice(0,200);
  for(const k of ['constant','score','far','lost','ratingOverride'])e[k]=numeric(e[k]);
  for(const k of ['start','audioStart','duration'])e[k]=Number(e[k]);
  e.enabled=fields.enabled===false?false:true;e.reviewed=fields.reviewed===false?false:true;
  e.warnings=Array.isArray(e.warnings)?e.warnings.map(String):[];
  e.textStyles=normalizeTextStyles(e.textStyles);
  return e;
}
export function newProject() {
  return {format:'arcshow-b50videomaker', version:2, sequence:[], audioGroups:[], excludedEntryIds:[], name:'我的 Arcaea Best50', player:'Arcaea Player', potential:'', subtitle:'', date:new Date().toLocaleDateString('sv-SE'), entries:[], settings:{count:50, rule:'v7', theme:'dusk', impression:'', layout:'cinema', width:1920, fps:60, crf:20, encoder:'auto', overview:4, overviewBlur:.5, overviewOrder:'descending', transition:.8, segmentGap:1, sceneTransitions:{}, audioTransition:.35, cutBlur:.3, normalizeAudio:true, order:'countdown', globalBgm:'', background:'', backgroundBlur:0, backgroundShade:.25, volume:.8, videoAudio:true, defaultDuration:15}, savedAt:null};
}
export function issues(e, p) {
  const out = [];
  if (!String(e.title || '').trim()) out.push('缺少曲名');
  if (!DIFFICULTIES.includes(e.difficulty)) out.push('难度无效');
  if (!Number.isInteger(numeric(e.score)) || numeric(e.score)<0 || numeric(e.score)>10100000) out.push('分数应为 0–10,100,000 的整数');
  if (e.constant != null && (!Number.isFinite(numeric(e.constant)) || numeric(e.constant)<0 || numeric(e.constant)>15)) out.push('定数应为 0–15');
  const r=rating(e,p.settings.rule);
  if (!Number.isFinite(r) || r<0 || r>20) out.push('请填写定数或有效 Potential');
  if (!Number.isFinite(Number(e.duration)) || e.duration<.5 || e.duration>600) out.push('时长应为 0.5–600 秒');
  for (const k of ['start','audioStart']) if (!Number.isFinite(Number(e[k])) || e[k]<0) out.push('素材起点不能为负数');
  for (const k of ['far','lost']) if (e[k]!=null && (!Number.isInteger(numeric(e[k])) || e[k]<0)) out.push(`${k} 应为非负整数`);
  return out;
}
export function scenes(p, singleId) { return buildTimeline(p,{singleId}).scenes; }
export function parseCsv(text) {
  text=text.replace(/^\uFEFF/,'');
  const delimiter=text.split(/\r?\n/)[0].includes('\t')?'\t':',';
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===delimiter&&!quoted){row.push(cell);cell='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(quoted)throw new Error('CSV 有未闭合的双引号');
  row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
  if(rows.length<2)throw new Error('CSV 需要表头和至少一行成绩');
  const headers=rows.shift().map(x=>x.trim());
  return rows.map(r=>Object.fromEntries(headers.map((k,i)=>[k,r[i]??''])));
}
const aliases={title:['title','song_name','name','曲名','歌曲'],songId:['songId','song_id','id'],artist:['artist','曲师'],alias:['alias','外号'],difficulty:['difficulty','rating_class','难度'],constant:['constant','chart_constant','定数'],score:['score','分数','成绩'],clear:['clear','clear_type','clearStatus','通关状态'],far:['far','near_count','Far'],lost:['lost','miss_count','Lost'],ratingOverride:['ratingOverride','potentialOverride','potential','Potential','单曲Potential','单曲 Potential','rating','单曲Rating'],comment:['comment','短评','评价'],video:['video','pipVideo','录像'],audio:['audio','bgmAudio','音频'],jacket:['jacket','封面'],background:['background','背景'],audioMode:['audioMode','配乐方式'],start:['start','pipStart','视频起点'],audioStart:['audioStart','bgmStart','音频起点'],duration:['duration','时长']};
export function importRecords(text, extension='json', songs=[]) {
  let raw=extension.toLowerCase()==='csv'||extension==='tsv'?parseCsv(text):JSON.parse(text.replace(/^\uFEFF/,''));
  if(raw.content)raw=raw.content;
  const list=Array.isArray(raw)?raw:raw.entries??raw.best50_list??raw.best30_list??raw.scores??raw.records;
  if(!Array.isArray(list)||!list.length)throw new Error('没有找到成绩数组。支持 entries、best50_list、best30_list、scores、records 或直接数组。');
  if(list.length>10000)throw new Error('一次最多导入 10,000 条成绩');
  return list.map((r,i)=>{
    if(!r||typeof r!=='object')throw new Error(`第 ${i+1} 行不是成绩对象`);
    const fields={};
    for(const [key,names] of Object.entries(aliases)){const n=names.find(n=>r[n]!=null&&r[n]!=='');if(n)fields[key]=r[n];}
    fields.difficulty=DIFFICULTIES[fields.difficulty]??String(fields.difficulty??'FTR').toUpperCase();
    fields.clear=['TL','NC','FR','PM','HC','EC'][fields.clear]??String(fields.clear??'UNKNOWN').toUpperCase();
    if(fields.songId&&!fields.title){const song=songs.find(s=>s.id===fields.songId||s.title===fields.songId);fields.title=song?.title??fields.songId;}
    for(const k of ['constant','score','ratingOverride','far','lost','duration','start','audioStart'])if(fields[k]!=null)fields[k]=numeric(fields[k]);
    if(fields.constant==null&&fields.title){const song=songs.find(s=>normalize(s.title)===normalize(fields.title));fields.constant=song?.tiers?.[fields.difficulty]??null;}
    return newEntry(fields);
  });
}
export function validateProject(raw) {
  if(!raw||!['arc-reel','arcshow-b50videomaker'].includes(raw.format)||![1,2].includes(raw.version)||!Array.isArray(raw.entries))throw new Error('不是有效的 arcshow-b50videomaker 工程，或工程版本不受支持');
  if(raw.entries.length>10000)throw new Error('工程条目过多');
  const base=newProject();const p={...base,...raw,format:base.format,settings:{...base.settings,...raw.settings},entries:raw.entries.map(e=>newEntry(e)),sequence:Array.isArray(raw.sequence)?raw.sequence.map(c=>c&&typeof c==='object'?{...c}:c):[],version:2};
  for(const k of ['name','player','potential','subtitle','date'])p[k]=String(p[k]??'').slice(0,k==='subtitle'?100:60);
  for(const k of ['background','globalBgm'])p.settings[k]=String(p.settings[k]??'');
  delete p.settings.intro;delete p.settings.introArtwork;
  const sceneTransitions=p.settings.sceneTransitions??{};
  if(!sceneTransitions||typeof sceneTransitions!=='object'||Array.isArray(sceneTransitions))throw new Error('逐段转场设置无效');
  p.settings.sceneTransitions={};
  for(const [id,transition] of Object.entries(sceneTransitions)){
    if(!transition||typeof transition!=='object'||Array.isArray(transition))throw new Error(`片段 ${id} 的转场设置无效`);
    const next={};
    if(transition.mode!=null||transition.duration!=null){
      if(!['black','cut'].includes(transition.mode)||typeof transition.duration==='boolean'||transition.duration==null||transition.duration===''||!Number.isFinite(Number(transition.duration))||Number(transition.duration)<0||Number(transition.duration)>5)throw new Error(`片段 ${id} 的画面转场应为 0–5 秒`);
      Object.assign(next,{mode:transition.mode,duration:Number(transition.duration)});
    }
    if(transition.audioDuration!==undefined){
      const value=transition.audioDuration;
      if(typeof value==='boolean'||value==null||value===''||!Number.isFinite(Number(value))||Number(value)<0||Number(value)>2)throw new Error(`片段 ${id} 的音乐淡入淡出应为 0–2 秒`);
      next.audioDuration=Number(value);
    }
    if(transition.gapDuration!==undefined){
      const value=transition.gapDuration;
      if(typeof value==='boolean'||value==null||value===''||!Number.isFinite(Number(value))||Number(value)<0||Number(value)>5)throw new Error(`片段 ${id} 的段间留白应为 0–5 秒`);
      next.gapDuration=Number(value);
    }
    if(Object.keys(next).length)p.settings.sceneTransitions[id]=next;
  }
  p.settings.impression=['hikari','tairitsu','sakuya','luna'].includes(p.settings.impression)?p.settings.impression:'';
  p.settings.videoAudio=p.settings.videoAudio===true;
  p.settings.normalizeAudio=p.settings.normalizeAudio!==false;
  if(![30,50].includes(Number(p.settings.count)))throw new Error('展示数量应为 30 或 50');
  if(!['v7','legacy'].includes(p.settings.rule))throw new Error('未知 Potential 规则');
  for(const [key,min,max] of [['overview',0,60],['overviewBlur',0,5],['transition',0,5],['segmentGap',0,5],['audioTransition',0,2],['cutBlur',0,1],['backgroundBlur',0,50],['backgroundShade',0,1],['volume',0,1],['crf',14,30]])if(typeof p.settings[key]==='boolean'||p.settings[key]==null||p.settings[key]===''||!Number.isFinite(Number(p.settings[key]))||p.settings[key]<min||p.settings[key]>max)throw new Error(`工程设置 ${key} 无效`);
  if(!['descending','ascending'].includes(p.settings.overviewOrder))throw new Error('总览排列应为 Potential 从高到低或从低到高');
  if(![1280,1920].includes(Number(p.settings.width))||![30,60].includes(Number(p.settings.fps)))throw new Error('导出格式无效');
  if(!['auto','software'].includes(p.settings.encoder)||!['dusk','dawn'].includes(p.settings.theme)||!['countdown','ascending','custom'].includes(p.settings.order))throw new Error('未知的画面或编码设置');
  if(!Number.isFinite(Number(p.settings.defaultDuration))||p.settings.defaultDuration<.5||p.settings.defaultDuration>600)throw new Error('默认时长应为 0.5–600 秒');
  p.settings.componentLayout=normalizeLayout(p.settings.componentLayout);
  const ids=new Set();p.entries.forEach(e=>{if(ids.has(e.id))e.id=uid();ids.add(e.id);});
  p.excludedEntryIds=Array.isArray(raw.excludedEntryIds)?raw.excludedEntryIds.map(String):[];
  const finiteNumber=n=>(typeof n==='number'||typeof n==='string'&&n.trim()!=='')&&Number.isFinite(Number(n));
  for(const c of p.sequence){
    if(c?.type!=='animation')continue;
    for(const [key,min,max] of [['start',0,Infinity],['duration',Number.MIN_VALUE,Infinity],['originalVolume',0,1],['effectStart',0,Infinity],['effectDuration',Number.MIN_VALUE,Infinity],['effectVolume',0,1]]){
      if(c[key]!==undefined&&(!finiteNumber(c[key])||Number(c[key])<min||Number(c[key])>max))throw new Error(`动画 ${c.id||''} 的 ${key} 无效${key.endsWith('Duration')||key==='duration'?'，时长必须大于 0':''}`);
    }
  }
  p.audioGroups=Array.isArray(raw.audioGroups)?raw.audioGroups.filter(g=>g&&typeof g==='object').map(g=>{
    for(const [key,fallback,min,max] of [['sourceStart',0,0,Infinity],['volume',1,0,1]]){
      const value=g[key]===undefined?fallback:g[key];
      if(!finiteNumber(value)||Number(value)<min||Number(value)>max)throw new Error(`连续配乐 ${g.id||''} 的 ${key} 无效`);
    }
    if(g.offsets!==undefined&&(!g.offsets||typeof g.offsets!=='object'||Array.isArray(g.offsets)||Object.values(g.offsets).some(v=>!finiteNumber(v))))throw new Error(`连续配乐 ${g.id||''} 的音画偏移无效`);
    return {...g,id:String(g.id||uid()),clipIds:Array.isArray(g.clipIds)?g.clipIds.map(String):[],source:String(g.source||''),sourceStart:Number(g.sourceStart===undefined?0:g.sourceStart),volume:Number(g.volume===undefined?1:g.volume),offsets:g.offsets?Object.fromEntries(Object.entries(g.offsets).map(([k,v])=>[k,Number(v)])):{}};
  }):[];
  const groupIds=new Set();
  for(const g of p.audioGroups){
    if(groupIds.has(g.id))g.id=uid();groupIds.add(g.id);
    if(g.pendingClipIds!=null&&!Array.isArray(g.pendingClipIds))throw new Error('连续配乐待校准列表无效');
  }
  ensureSequence(p);
  return p;
}
export function matchMedia(entry, assets) {
  const titles=[entry.title,entry.alias,entry.songId].filter(Boolean).map(normalize);
  const result={};
  const terms={PST:['pst','past'],PRS:['prs','present'],FTR:['ftr','future'],BYD:['byd','beyond'],ETR:['etr','eternal'],INS:['ins','infinite']};
  for(const kind of ['video','audio','jacket']){
    if(entry[kind])continue;
    const candidates=assets.filter(a=>a.kind===kind).map(a=>{
      const clean=normalize(a.name.replace(/\.[^.]+$/,''));
      let score=Math.max(0,...titles.map(t=>clean===t?100:clean.includes(t)&&t.length>=3?75:0));
      if(!score)return {...a,score:0};
      const tags=Object.entries(terms).filter(([,ts])=>ts.some(t=>new RegExp(`(?:^|[^a-z])${t}(?:$|[^a-z])`,'i').test(a.name))).map(([d])=>d);
      if(tags.length&&!tags.includes(entry.difficulty))score=0;
      else if(tags.includes(entry.difficulty))score+=25;
      return {...a,score};
    }).filter(a=>a.score>0).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
    // A tie remains unassigned so an unrelated duplicate is never chosen silently.
    if(candidates[0]&&(!candidates[1]||candidates[0].score>candidates[1].score))result[kind]=candidates[0].path;
  }
  return result;
}
export function demoProject() {
  const p=newProject();p.name='Arcaea Best50';p.player='Hikari';p.subtitle='';
  const songs=[['Testify',12,'BYD'],['Tempestissimo',11.5,'BYD'],['Arcana Eden',11.4,'BYD'],['Pentiment',11.4,'BYD'],['Aegleseeker',11.3,'FTR'],['Ringed Genesis',10.8,'FTR'],['Stasis',10.8,'FTR'],['Inverted World',10.7,'ETR'],['Axium Crisis',10.6,'FTR'],['AttraqtiA',10.6,'FTR'],['Halcyon',10.5,'FTR'],['ALTER EGO',10.5,'FTR'],['Wish Upon a Snow',10.5,'FTR'],['Last Celebration',10.4,'FTR'],['Placebo♥Battler',10.4,'FTR']];
  p.entries=songs.map(([title,constant,difficulty],i)=>newEntry({title,constant,difficulty,score:9985432-i*2331,clear:i%3?'NC':'FR',far:3+i,lost:i%3,duration:12,comment:i===7?'短评示例：副歌段落需要注意换手。':''}));
  p.demo=true;return p;
}

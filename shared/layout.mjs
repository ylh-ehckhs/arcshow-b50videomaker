import {USER_DEFAULT_LAYOUT,USER_DEFAULT_BACKDROPS} from './default-layout.mjs';
export const FONT_FAMILIES=['Microsoft YaHei UI','Bahnschrift','Yu Gothic','SimSun','Consolas'];
const component=(label,x,y,w,h,fontSize=28,extra={})=>({label,x,y,w,h,fontSize,fontFamily:'Microsoft YaHei UI',fontWeight:400,color:'',background:'',align:'left',opacity:1,padding:0,radius:0,visible:true,...extra});
const footer=()=>component('页脚',72,1018,1776,34,14);
export const DEFAULT_LAYOUT={
  version:2,
  common:{
    brand:component('项目名称',72,36,830,44,22,{fontWeight:600}),
  },
  song:{
    video:component('谱面视频',72,260,1136,638,24,{background:'#080f16'}),
    title:component('曲名',72,142,1136,66,44,{fontWeight:600}),
    meta:component('难度与定数',72,213,1136,40,21),
    player:component('玩家',72,106,1136,32,18),
    score:component('分数',1280,200,568,120,66,{fontFamily:'Bahnschrift',padding:22,background:'#ffffff08',radius:4}),
    grade:component('评级',1656,231,170,80,66,{fontFamily:'Bahnschrift',align:'right'}),
    rating:component('单曲 Potential',1280,345,300,100,42,{fontFamily:'Bahnschrift'}),
    clear:component('通关状态',1630,345,218,100,36,{fontFamily:'Bahnschrift'}),
    judgements:component('FAR / LOST',1280,465,568,55,24),
    comment:component('短评',1280,560,568,340,28),
    rank:component('排名',1280,933,568,65,48,{fontFamily:'Bahnschrift'}),
    date:component('日期',72,924,1136,32,17),
    footer:footer(),
  },
  overview:{
    title:component('总览标题',90,140,1740,80,48),
    player:component('玩家',90,240,1300,55,24),
    page:component('页码',1440,240,390,55,24,{align:'right'}),
    grid:component('成绩列表',90,340,1740,610,24),
    footer:footer(),
  },
};
for(const scope of ['common','song','overview'])for(const [key,patch] of Object.entries(USER_DEFAULT_LAYOUT[scope]||{})){
  if(DEFAULT_LAYOUT[scope][key])Object.assign(DEFAULT_LAYOUT[scope][key],patch);
}
// Add presentation options without moving the user's saved components.
for(const scope of ['common','song','overview'])for(const [id,v] of Object.entries(DEFAULT_LAYOUT[scope])){
  v.readableText=scope==='song'?['score','grade','rating','clear','judgements','comment'].includes(id):scope==='overview'&&['grid','page'].includes(id);
  v.difficultyColor='difficulty';
}
export const makeBackdrop=(id,label='独立黑底',extra={})=>({id,...component(label,1240,185,640,735,24,{background:'#000000',opacity:.55,radius:10,...extra})});
DEFAULT_LAYOUT.backdrops=structuredClone(USER_DEFAULT_BACKDROPS);
export const makeImage=(id,label='图片',extra={})=>({id,...component(label,1280,560,400,300,24,{file:'',source:'file',fit:'contain',zIndex:1,...extra})});
DEFAULT_LAYOUT.images={song:[],overview:[]};
export const isBackdropKey=key=>/^(song|overview)\.backdrop:[\w-]+$/.test(key);
export const isImageKey=key=>/^(song|overview)\.image:[\w-]+$/.test(key);
export const layoutImageFile=(image,entry)=>image.visible===false?'':image.source==='jacket'?(entry?.jacket||''):(image.file||'');
export function layoutComponent(layout,key){
  const [scope,id]=String(key).split('.');
  if(isBackdropKey(key))return layout.backdrops?.[scope]?.find(v=>v.id===id.slice(9));
  if(isImageKey(key))return layout.images?.[scope]?.find(v=>v.id===id.slice(6));
  return layout[scope]?.[id];
}
export function moveImageLayer(layout,key,direction){
  if(!isImageKey(key)||!['up','down','front','back'].includes(direction))return false;
  const [scope]=key.split('.'),images=layout.images?.[scope],image=layoutComponent(layout,key);
  if(!image)return false;
  const others=images.filter(v=>v!==image),before=JSON.stringify(images);
  let index=images.indexOf(image),z=image.zIndex;
  if(direction==='front'){z=Math.min(999,Math.max(1,...others.map(v=>v.zIndex))+1);index=images.length-1;}
  if(direction==='back'){z=1;index=0;}
  if(direction==='up'){
    const next=[1,...others.map(v=>v.zIndex)].filter(value=>value>=z);
    if(next.length){z=Math.min(999,Math.min(...next)+1);index=images.length-1;}
  }
  if(direction==='down'){
    const next=[1,...others.map(v=>v.zIndex)].filter(value=>value<=z);
    z=Math.max(1,Math.max(...next)-1);index=0;
  }
  images.splice(images.indexOf(image),1);image.zIndex=z;images.splice(index,0,image);
  return before!==JSON.stringify(images);
}
const clamp=(n,a,b,fallback)=>Number.isFinite(Number(n))?Math.max(a,Math.min(b,Number(n))):fallback;
// Split former combined components once, preserving their region, style and visibility.
export function migrateLayout(raw){
  if(!raw||Number(raw.version)>=2)return raw;
  const source=structuredClone(raw),legacyFooter=source.common?.footer;
  for(const scope of ['song','overview']){
    source[scope]??={};
    if(legacyFooter&&!source[scope].footer)source[scope].footer={...legacyFooter};
  }
  const split=(part,x,y,w,h,extra={})=>({...part,x,y,w,h,...extra});
  const overview=source.overview.player;
  if(overview&&!source.overview.page){
    const p={...DEFAULT_LAYOUT.overview.player,...overview};
    source.overview.player=split(p,p.x,p.y,Math.round(p.w*.75),p.h);
    source.overview.page=split(p,p.x+Math.round(p.w*.8),p.y,Math.round(p.w*.2),p.h,{align:'right'});
  }
  const score=source.song.score;
  if(score&&!source.song.grade){
    const p={...DEFAULT_LAYOUT.song.score,...score},padding=Number(p.padding)||0;
    source.song.grade=split(p,p.x+p.w-padding-Math.min(110,p.w*.25),p.y+padding,Math.min(110,p.w*.25),28,{fontSize:16,fontFamily:'Microsoft YaHei UI',padding:0,radius:0,background:'',align:'right'});
  }
  source.version=2;return source;
}
export function normalizeLayout(raw){
  raw=migrateLayout(raw);const out={version:2};
  for(const scope of ['common','song','overview']){
    out[scope]={};
    for(const [id,base] of Object.entries(DEFAULT_LAYOUT[scope])){
      const r=raw?.[scope]?.[id]||{},v={...base};
      v.w=Math.round(clamp(r.w,40,1920,base.w));v.h=Math.round(clamp(r.h,24,1080,base.h));
      v.x=Math.round(clamp(r.x,0,1920-v.w,base.x));v.y=Math.round(clamp(r.y,0,1080-v.h,base.y));
      v.fontSize=clamp(r.fontSize,10,200,base.fontSize);
      v.fontFamily=FONT_FAMILIES.includes(r.fontFamily)?r.fontFamily:base.fontFamily;
      v.fontWeight=[400,500,600,700].includes(Number(r.fontWeight))?Number(r.fontWeight):base.fontWeight;
      v.align=['left','center','right'].includes(r.align)?r.align:base.align;
      for(const k of ['color','background'])v[k]=typeof r[k]==='string'&&/^#[a-f\d]{6}([a-f\d]{2})?$/i.test(r[k])?r[k]:base[k];
      v.opacity=clamp(r.opacity,0,1,base.opacity);v.padding=clamp(r.padding,0,100,base.padding);v.radius=clamp(r.radius,0,100,base.radius);
      v.visible=r.visible===undefined?base.visible:r.visible!==false;out[scope][id]=v;
      v.readableText=(r.readableText??r.textBackdrop)===undefined?base.readableText:(r.readableText??r.textBackdrop)===true;
      v.difficultyColor=['difficulty','theme'].includes(r.difficultyColor)?r.difficultyColor:base.difficultyColor;
    }
  }
  out.backdrops={};
  for(const scope of ['song','overview']){
    const list=Array.isArray(raw?.backdrops?.[scope])?raw.backdrops[scope]:DEFAULT_LAYOUT.backdrops[scope],seen=new Set();
    out.backdrops[scope]=list.slice(0,32).filter(v=>v&&typeof v==='object').map((r,index)=>{
      let id=typeof r.id==='string'&&/^[\w-]{1,64}$/.test(r.id)?r.id:`panel-${index+1}`;
      const stem=id.slice(0,55);let suffix=2;while(seen.has(id))id=stem+'-'+suffix++;seen.add(id);
      const v=makeBackdrop(id,String(r.label||'独立黑底').slice(0,30));
      v.w=Math.round(clamp(r.w,40,1920,v.w));v.h=Math.round(clamp(r.h,24,1080,v.h));
      v.x=Math.round(clamp(r.x,0,1920-v.w,v.x));v.y=Math.round(clamp(r.y,0,1080-v.h,v.y));
      v.background=typeof r.background==='string'&&/^#[a-f\d]{6}([a-f\d]{2})?$/i.test(r.background)?r.background:v.background;
      v.opacity=clamp(r.opacity,0,1,v.opacity);v.radius=clamp(r.radius,0,100,v.radius);v.visible=r.visible!==false;
      return v;
    });
  }
  out.images={};
  for(const scope of ['song','overview']){
    const list=Array.isArray(raw?.images?.[scope])?raw.images[scope]:[],seen=new Set();
    out.images[scope]=list.slice(0,32).filter(v=>v&&typeof v==='object').map((r,index)=>{
      let id=typeof r.id==='string'&&/^[\w-]{1,64}$/.test(r.id)?r.id:`image-${index+1}`;
      const stem=id.slice(0,55);let suffix=2;while(seen.has(id))id=stem+'-'+suffix++;seen.add(id);
      const v=makeImage(id,String(r.label||'图片').slice(0,30));
      v.w=Math.round(clamp(r.w,40,1920,v.w));v.h=Math.round(clamp(r.h,24,1080,v.h));
      v.x=Math.round(clamp(r.x,0,1920-v.w,v.x));v.y=Math.round(clamp(r.y,0,1080-v.h,v.y));
      v.file=typeof r.file==='string'?r.file:'';
      v.source=scope==='song'&&r.source==='jacket'?'jacket':'file';
      v.fit=['contain','cover','fill'].includes(r.fit)?r.fit:'contain';
      v.zIndex=Math.round(clamp(r.zIndex,1,999,1));
      v.opacity=clamp(r.opacity,0,1,v.opacity);v.radius=clamp(r.radius,0,100,v.radius);v.visible=r.visible!==false;
      return v;
    });
  }
  return out;
}
export function getLayout(project){return normalizeLayout(project.settings.componentLayout);}
export function videoRect(project){
  const v=getLayout(project).song.video;
  return {...v,x:Math.round(v.x/2)*2,y:Math.round(v.y/2)*2,w:Math.floor(v.w/2)*2,h:Math.floor(v.h/2)*2};
}
export function componentStyle(v){
  // Scene text uses CSS layer 2. Image depth 1 shares that layer, before
  // text in DOM order; depth 2+ goes above it while retaining old layouts.
  return `left:${v.x}px;top:${v.y}px;width:${v.w}px;height:${v.h}px;font-size:${v.fontSize}px;font-family:'${v.fontFamily}';font-weight:${v.fontWeight};text-align:${v.align};opacity:${v.opacity};padding:${v.padding}px;border-radius:${v.radius}px;${Number.isInteger(v.zIndex)?`z-index:${v.zIndex+1};`:''}${v.color?`color:${v.color};`:''}${v.background?`background:${v.background};`:''}${v.visible?'':'display:none;'}`;
}

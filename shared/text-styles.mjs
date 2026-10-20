import {DEFAULT_LAYOUT,FONT_FAMILIES,getLayout} from './layout.mjs';

// Store only explicit changes: unset properties keep following the project layout.
export const TEXT_COMPONENTS=[['all','全部文字'],...['common','song'].flatMap(scope=>Object.entries(DEFAULT_LAYOUT[scope]).filter(([id])=>id!=='video').map(([id,v])=>[scope+'.'+id,v.label]))];
const keys=new Set(TEXT_COMPONENTS.map(([key])=>key));
export const TEXT_SHADOWS={none:'none',soft:'0 1px 3px #0008',strong:'0 1px 2px #000,0 0 5px #000,0 0 10px #000b'};
export function normalizeTextStyles(raw){
  const out={};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return out;
  for(const [key,value] of Object.entries(raw)){
    if(!keys.has(key)||!value||typeof value!=='object'||Array.isArray(value))continue;
    const patch={};
    if(typeof value.color==='string'&&/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value.color.trim()))patch.color=value.color.trim();
    if(FONT_FAMILIES.includes(value.fontFamily))patch.fontFamily=value.fontFamily;
    if([400,500,600,700].includes(Number(value.fontWeight)))patch.fontWeight=Number(value.fontWeight);
    if(value.fontSize!==''&&value.fontSize!=null&&typeof value.fontSize!=='boolean'&&Number.isFinite(Number(value.fontSize)))patch.fontSize=Math.max(10,Math.min(200,Number(value.fontSize)));
    if(Object.hasOwn(TEXT_SHADOWS,value.textShadow))patch.textShadow=value.textShadow;
    if(Object.keys(patch).length)out[key]=patch;
  }
  return out;
}
export function textStylePatch(entry,key){
  const styles=normalizeTextStyles(entry?.textStyles);
  return key==='all'?styles.all||{}:{...styles.all,...styles[key]};
}
export function setTextStyle(entry,key,field,value){
  if(!entry||!keys.has(key)||!['color','fontFamily','fontWeight','fontSize','textShadow'].includes(field))return;
  const styles=normalizeTextStyles(entry.textStyles),patch={...styles[key]};
  if(value===''||value==null)delete patch[field];else patch[field]=value;
  styles[key]=patch;entry.textStyles=normalizeTextStyles(styles);
}
export function resolveTextLayout(project,entry){
  const layout=getLayout(project),styles=normalizeTextStyles(entry?.textStyles);
  for(const [key] of TEXT_COMPONENTS){
    if(key==='all')continue;
    const [scope,id]=key.split('.'),patch={...styles.all,...styles[key]};
    Object.assign(layout[scope][id],patch);
    if(patch.color)layout[scope][id].textColorOverride=true;
  }
  return layout;
}

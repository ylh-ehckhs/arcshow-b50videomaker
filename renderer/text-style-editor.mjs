import {escapeHtml as h} from '../shared/core.mjs';
import {FONT_FAMILIES,getLayout} from '../shared/layout.mjs';
import {TEXT_COMPONENTS,normalizeTextStyles,setTextStyle} from '../shared/text-styles.mjs';

let selected='all',expanded=false;
const options=(items,value)=>items.map(([key,label])=>`<option value="${h(key)}" ${String(value??'')===String(key)?'selected':''}>${h(label)}</option>`).join('');
export function textStyleView(project,entry){
  if(!entry)return '';
  const styles=normalizeTextStyles(entry.textStyles),patch=styles[selected]||{},layout=getLayout(project);
  const [scope,id]=selected.split('.'),inherited=selected==='all'?{}:{...layout[scope][id],...styles.all};
  const field=(label,key,items)=>{
    const inheritedLabel=items.find(([value])=>String(value)===String(inherited[key]))?.[1]??inherited[key];
    return `<label class="field"><span>${label}</span><select data-text-style-field="${key}">${options([['','继承'+(inheritedLabel?' · '+inheritedLabel:'视频布局')],...items],patch[key])}</select></label>`;
  };
  const count=Object.keys(styles).length,color=patch.color||inherited.color||'#ffffff';
  return `<details class="clip-text-styles" ${expanded?'open':''}><summary>本曲文字 <small data-text-style-status>${count?'已自定义 '+count+' 组':'继承视频布局'}</small></summary><p>只调整当前歌曲。留空的项目继续跟随“视频布局”；单独组件的设置优先于“全部文字”。难度标签保留原配色。</p>
  <div class="clip-fields"><label class="field"><span>调整范围</span><select data-text-style-component>${options(TEXT_COMPONENTS,selected)}</select></label>
  <label class="field"><span>文字颜色</span><div class="text-color-control"><input type="color" data-text-color-picker value="${h(color.slice(0,7))}" aria-label="选择本曲文字颜色"><input type="text" data-text-style-field="color" value="${h(patch.color||'')}" placeholder="${h(inherited.color?'继承 · '+inherited.color:'留空继承视频布局')}" maxlength="9" spellcheck="false" aria-label="本曲文字色值"></div></label>
  <label class="field"><span>字号（px）</span><input type="number" data-text-style-field="fontSize" value="${patch.fontSize??''}" min="10" max="200" step="1" placeholder="${inherited.fontSize?'继承 · '+inherited.fontSize:'各组件原字号'}"></label>
  ${field('字体','fontFamily',FONT_FAMILIES.map(v=>[v,v]))}${field('字重','fontWeight',[400,500,600,700].map(v=>[v,String(v)]))}${field('文字阴影','textShadow',[['none','无阴影'],['soft','轻微黑色阴影'],['strong','增强黑色阴影']])}</div>
  <div class="text-style-actions"><div><button class="btn outline" data-text-style-action="light">浅色文字</button><button class="btn outline" data-text-style-action="dark">深色文字</button><button class="btn quiet" data-text-style-action="reset-component" ${Object.keys(patch).length?'':'disabled'}>${selected==='all'?'恢复统一设置继承':'恢复本组件继承'}</button></div><button class="btn quiet" data-text-style-action="reset-all" ${count?'':'disabled'}>本曲全部恢复继承</button></div></details>`;
}
export function bindTextStyleEditor(root,{entry,commit,refresh,error}){
  root.addEventListener('toggle',event=>{if(event.target.classList?.contains('clip-text-styles'))expanded=event.target.open;},true);
  root.addEventListener('change',event=>{
    const el=event.target;
    if(el.hasAttribute('data-text-style-component')){selected=el.value;refresh({textStyles:true});return;}
    const field=el.hasAttribute('data-text-color-picker')?'color':el.dataset.textStyleField;
    if(!field)return;
    const e=entry();if(!e)return;
    const value=el.value.trim();
    if(field==='color'&&value&&!/^#[\da-f]{6}([\da-f]{2})?$/i.test(value)){
      error('文字颜色请使用 #RRGGBB 或 #RRGGBBAA；留空继承视频布局。');refresh({editing:true,source:el});return;
    }
    if(field==='fontSize'&&value&&(!Number.isFinite(Number(value))||Number(value)<10||Number(value)>200)){
      error('字号请填写 10–200；留空继承原字号。');refresh({editing:true,source:el});return;
    }
    commit(()=>setTextStyle(e,selected,field,value),{editing:true,source:el});
  });
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-text-style-action]');if(!button||button.disabled)return;
    event.preventDefault();const e=entry();if(!e)return;
    const action=button.dataset.textStyleAction;
    commit(()=>{
      if(action==='reset-all')e.textStyles={};
      else if(action==='reset-component'){e.textStyles=normalizeTextStyles(e.textStyles);delete e.textStyles[selected];}
      else if(action==='light'||action==='dark')setTextStyle(e,selected,'color',action==='light'?'#f7f5fc':'#20202a');
    },{editing:true,source:button});
  });
}

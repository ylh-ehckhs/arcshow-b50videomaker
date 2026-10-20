import {DEFAULT_LAYOUT,FONT_FAMILIES,getLayout,normalizeLayout,layoutComponent,isBackdropKey,makeBackdrop,isImageKey,makeImage,moveImageLayer} from '../shared/layout.mjs';
import {escapeHtml as h} from '../shared/core.mjs';
let selected='song.title',snap=true;
const opts=(list,value)=>list.map(x=>`<option ${String(x)===String(value)?'selected':''}>${h(x)}</option>`).join('');
export function layoutSelection(){return {selectedComponent:selected,snap};}
export function layoutView(p,sceneType){
  if(!DEFAULT_LAYOUT[sceneType])sceneType='song';
  const layout=getLayout(p);
  if((!selected.startsWith(sceneType+'.')&&!selected.startsWith('common.'))||!layoutComponent(layout,selected))selected=sceneType+'.'+Object.keys(DEFAULT_LAYOUT[sceneType])[0];
  const [scope,id]=selected.split('.'),v=layoutComponent(layout,selected),backdrop=isBackdropKey(selected),picture=isImageKey(selected);
  const textComponents=[...Object.entries(layout[sceneType]).map(([key,c])=>[sceneType+'.'+key,c]),...Object.entries(layout.common).map(([key,c])=>['common.'+key,c])];
  const plates=layout.backdrops[sceneType].map(v=>[sceneType+'.backdrop:'+v.id,v]),pictures=layout.images[sceneType].map(v=>[sceneType+'.image:'+v.id,v]),components=[...textComponents,...plates,...pictures];
  const componentRow=([key,c])=>`<div class="layout-component-row ${key===selected?'selected':''}"><input type="checkbox" data-layout-visible="${key}" aria-label="显示${h(c.label)}" ${c.visible?'checked':''}><button data-layout-select="${key}" type="button" aria-pressed="${key===selected}">${h(c.label)}</button></div>`;
  const field=(label,key,type='number',extra='')=>`<label class="field"><span>${label}</span><input data-layout-field="${key}" type="${type}" value="${h(v[key])}" ${extra}></label>`;
  const image=id==='video'&&scope==='song'||backdrop||picture;
  return `<div class="page-title"><h1>视频布局</h1><p>拖动组件，拖动右下角调整大小。布局保存到工程。</p></div>
    <div class="layout-toolbar"><div class="segmented">${[['song','单曲'],['overview','总览']].map(([key,name])=>`<button data-action="scene" data-scene="${key}" class="${sceneType===key?'active':''}">${name}</button>`).join('')}</div><label class="checkbox"><input id="layout-snap" type="checkbox" ${snap?'checked':''}>10 px 对齐</label><button class="btn outline" data-layout-action="reset-scene">重置此页布局</button></div>
    <div class="layout-workbench"><section class="layout-stage-panel"><div class="layout-canvas"><iframe id="preview" src="frame.html" title="布局画布"></iframe></div><p class="help layout-canvas-help">画布 1920 × 1080。拖动组件或右下角调整大小；隐藏组件可从右侧重新显示。</p></section>
    <aside class="layout-properties"><section class="layout-component-section"><h2>组件与显示</h2><div class="layout-component-list">${textComponents.map(componentRow).join('')}</div><div class="layout-backdrop-heading"><h2>独立黑底</h2><button type="button" class="btn quiet" data-layout-action="add-backdrop" ${plates.length>=32?'disabled':''}>＋ 添加黑底</button></div><div class="layout-component-list">${plates.map(componentRow).join('')||'<span class="help">添加后可拖动并调整大小。</span>'}</div><div class="layout-backdrop-heading"><h2>图片</h2><button type="button" class="btn quiet" data-layout-action="add-image" ${pictures.length>=32?'disabled':''}>＋ 添加图片</button></div><div class="layout-component-list">${pictures.map(componentRow).join('')||'<span class="help">选择本地图片，自由调整位置和大小。</span>'}</div></section><section class="layout-property-fields"><label class="field"><span>当前组件</span><select id="layout-component">${components.map(([key,c])=>`<option value="${key}" ${key===selected?'selected':''}>${h(c.label)}${c.visible?'':'（隐藏）'}</option>`).join('')}</select></label>
    ${picture?`${field('名称','label','text','maxlength="30"')}${scope==='song'?`<label class="field"><span>图片来源</span><select data-layout-field="source"><option value="file" ${v.source==='file'?'selected':''}>指定图片</option><option value="jacket" ${v.source==='jacket'?'selected':''}>跟随本曲图片</option></select></label>`:''}${v.source==='jacket'?'<p class="help">在“成绩与剪辑”中为每首歌选择“本曲图片”；未选择的歌曲不显示此组件。</p>':`<div class="layout-image-file"><button type="button" class="btn outline" data-layout-action="replace-image" title="${h(v.file)}">${v.file?'更换图片':'选择图片'}</button><span title="${h(v.file)}">${h(v.file.split(/[\\/]/).pop()||'未选择图片')}</span></div>`}<label class="field"><span>图片适应方式</span><select data-layout-field="fit">${[['contain','完整显示（保持比例）'],['cover','裁切填满（保持比例）'],['fill','拉伸填满']].map(([key,label])=>`<option value="${key}" ${v.fit===key?'selected':''}>${label}</option>`).join('')}</select></label>`:''}
    <div class="field-pair">${field('X','x','number','min="0" max="1880" step="1"')}${field('Y','y','number','min="0" max="1056" step="1"')}</div>
    <div class="field-pair">${field('宽度','w','number','min="40" max="1920" step="2"')}${field('高度','h','number','min="24" max="1080" step="2"')}</div>
    ${picture?`${field('图层深度','zIndex','number','min="1" max="999" step="1"')}<div class="layout-layer-actions">${[['down','下移一层'],['up','上移一层'],['back','置底'],['front','置顶']].map(([key,label])=>`<button type="button" class="btn quiet" data-layout-action="image-layer-${key}">${label}</button>`).join('')}</div><p class="help">数值越大越靠前。1 在文字下方，2 及以上可覆盖文字；图片始终位于谱面视频上方。</p>`:''}
    ${image?'':`<div class="field-pair">${field('字号','fontSize','number','min="10" max="200"')}<label class="field"><span>字重</span><select data-layout-field="fontWeight">${opts([400,500,600,700],v.fontWeight)}</select></label></div><div class="field-pair"><label class="field"><span>字体</span><select data-layout-field="fontFamily">${opts(FONT_FAMILIES,v.fontFamily)}</select></label><label class="field"><span>对齐</span><select data-layout-field="align">${['left','center','right'].map((x,i)=>`<option value="${x}" ${v.align===x?'selected':''}>${['左','居中','右'][i]}</option>`).join('')}</select></label></div>${scope==='song'&&id==='grade'?'<button type="button" class="btn quiet" data-layout-action="match-score-font">与分数字号相同</button>':''}`}
    ${picture?'':`<div class="${backdrop?'':'field-pair'}">${backdrop?'':`<label class="field"><span>文字颜色</span><input data-layout-field="color" type="text" value="${v.color}" placeholder="跟随主题 / #FFFFFF"></label>`}<label class="field"><span>${backdrop?'黑底颜色':'背景颜色'}</span><input data-layout-field="background" type="text" value="${v.background}" placeholder="透明 / #FFFFFF80"></label></div>`}
    ${image?'':`<label class="checkbox"><input data-layout-field="readableText" type="checkbox" ${v.readableText?'checked':''}>浅色高对比文字</label>`}
    ${scope==='song'&&id==='meta'||scope==='overview'&&id==='grid'?`<label class="field"><span>难度标签配色</span><select data-layout-field="difficultyColor"><option value="difficulty" ${v.difficultyColor==='difficulty'?'selected':''}>跟随难度</option><option value="theme" ${v.difficultyColor==='theme'?'selected':''}>跟随印象界面</option></select></label>`:''}
    <div class="${backdrop||picture?'':'field-pair'}">${backdrop||picture?'':field('内边距','padding','number','min="0" max="100"')}${field('圆角','radius','number','min="0" max="100"')}</div>
    ${field('不透明度','opacity','number','min="0" max="1" step=".05"')}
    ${picture?'<button class="btn quiet danger" data-layout-action="delete-image">删除此图片</button>':backdrop?'<button class="btn quiet danger" data-layout-action="delete-backdrop">删除此黑底</button>':'<button class="btn quiet" data-layout-action="reset-component">重置此组件</button>'}</section></aside></div>`;
}
export function bindLayoutEditor(root,{project,scene,refresh,preview,changed,pick,error=()=>{}}){
  const apply=(patch,key=selected)=>{const p=project(),layout=getLayout(p),component=layoutComponent(layout,key);if(!component)return;Object.assign(component,patch);p.settings.componentLayout=normalizeLayout(layout);changed();};
  const refreshProperties=()=>{const temp=document.createElement('div');temp.innerHTML=layoutView(project(),scene());const current=root.querySelector('.layout-properties'),scroll=current?.scrollTop||0;current?.replaceWith(temp.querySelector('.layout-properties'));const next=root.querySelector('.layout-properties');if(next)next.scrollTop=scroll;};
  root.addEventListener('change',event=>{
    const el=event.target;
    if(el.dataset.layoutVisible){apply({visible:el.checked},el.dataset.layoutVisible);refreshProperties();preview();return;}
    if(el.id==='layout-component'){selected=el.value;refresh();return;}
    if(el.id==='layout-snap'){snap=el.checked;preview();return;}
    if(el.dataset.layoutField){const key=el.dataset.layoutField;
      if(['color','background'].includes(key)&&el.value&&!/^#[a-f\d]{6}([a-f\d]{2})?$/i.test(el.value)){el.setCustomValidity('使用 #RRGGBB 或 #RRGGBBAA，留空跟随主题');el.reportValidity();return;}
      el.setCustomValidity('');apply({[key]:el.type==='checkbox'?el.checked:['color','background','fontFamily','align','difficultyColor','label','source','fit'].includes(key)?el.value:Number(el.value)});if(['source','label'].includes(key))refreshProperties();preview();
    }
  });
  root.addEventListener('click',async event=>{
    const key=event.target.closest('[data-layout-select]')?.dataset.layoutSelect;if(key){selected=key;refreshProperties();preview();return;}
    const a=event.target.closest('[data-layout-action]')?.dataset.layoutAction;if(!a)return;
    const p=project(),layout=getLayout(p),[scope,id]=selected.split('.');
    if(a.startsWith('image-layer-')){if(!moveImageLayer(layout,selected,a.slice(12)))return;}
    if(a==='add-image'||a==='replace-image'){
      const target=scene(),images=layout.images[target];if(a==='add-image'&&images.length>=32)return;
      if(a==='replace-image'&&!isImageKey(selected))return;
      let file;try{file=await pick('image');}catch(reason){error(reason.message||String(reason));return;}if(!file)return;
      if(a==='add-image'){
        const picture=makeImage(globalThis.crypto.randomUUID(),'图片 '+(images.length+1),{file,w:360,h:360});images.push(picture);selected=target+'.image:'+picture.id;
      }else Object.assign(layoutComponent(layout,selected),{file,source:'file'});
    }
    if(a==='add-backdrop'){
      const target=scene(),panels=layout.backdrops[target];if(panels.length>=32)return;
      const panel=makeBackdrop(globalThis.crypto.randomUUID(),'黑底 '+(panels.length+1),{x:800,y:300,w:600,h:400});panels.push(panel);selected=target+'.backdrop:'+panel.id;
    }
    if(a==='delete-backdrop'&&isBackdropKey(selected)){layout.backdrops[scope]=layout.backdrops[scope].filter(v=>v.id!==id.slice(9));selected=scope+'.title';}
    if(a==='delete-image'&&isImageKey(selected)){layout.images[scope]=layout.images[scope].filter(v=>v.id!==id.slice(6));selected=scope+'.title';}
    if(a==='reset-component')layout[scope][id]={...DEFAULT_LAYOUT[scope][id]};
    if(a==='match-score-font'&&scope==='song'&&id==='grade'){layout.song.grade.fontSize=layout.song.score.fontSize;layout.song.grade.h=Math.max(layout.song.grade.h,Math.ceil(layout.song.grade.fontSize*1.35));}
    if(a==='reset-scene'){if(!confirm('恢复此页的默认布局？'))return;layout[scene()]=structuredClone(DEFAULT_LAYOUT[scene()]);layout.backdrops[scene()]=structuredClone(DEFAULT_LAYOUT.backdrops[scene()]);layout.images[scene()]=[];}
    p.settings.componentLayout=normalizeLayout(layout);changed();refresh();
  });
  addEventListener('message',event=>{
    if(event.source!==root.querySelector('#preview')?.contentWindow)return;
    const data=event.data;if(!['layout-select','layout-change'].includes(data?.type))return;
    if(!layoutComponent(getLayout(project()),String(data.key)))return;
    selected=data.key;
    if(data.type==='layout-select'){
      // Keep the iframe and pointer capture alive during dragging.
      refreshProperties();
    }else{apply(data.patch);refresh();}
  });
}

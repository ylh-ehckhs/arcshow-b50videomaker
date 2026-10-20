import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry,validateProject,buildTimeline} from '../shared/core.mjs';
import {getLayout,makeImage} from '../shared/layout.mjs';
import {normalizeTextStyles,resolveTextLayout,setTextStyle,textStylePatch} from '../shared/text-styles.mjs';
import {bindTextStyleEditor,textStyleView} from '../renderer/text-style-editor.mjs';

test('unset song text styles preserve every existing component and old project',()=>{
  const p=newProject(),e=newEntry({title:'旧工程'}),layout=getLayout(p);
  assert.deepEqual(e.textStyles,{});assert.deepEqual(resolveTextLayout(p,e),layout);
  assert.deepEqual(resolveTextLayout(p,null),layout);
  p.entries=[e];delete p.entries[0].textStyles;
  assert.deepEqual(validateProject(p).entries[0].textStyles,{});
  assert.deepEqual(resolveTextLayout(validateProject(p),validateProject(p).entries[0]),layout);
});

test('per-song text inherits dynamically and changes neither geometry nor image layers',()=>{
  const p=newProject(),a=newEntry(),b=newEntry(),layout=getLayout(p);
  layout.images.song=[makeImage('overlay','图片',{file:'local.png',zIndex:7})];
  layout.song.title.color='#123456';layout.song.title.fontSize=60;p.settings.componentLayout=layout;
  const before=structuredClone(p);
  setTextStyle(a,'all','color','#ffffff');setTextStyle(a,'all','textShadow','strong');
  setTextStyle(a,'song.title','color','#00ddff');setTextStyle(a,'song.score','fontWeight',600);
  const resolved=resolveTextLayout(p,a);
  assert.equal(resolved.song.title.color,'#00ddff');assert.equal(resolved.song.title.fontSize,60);
  assert.equal(resolved.song.title.textShadow,'strong');assert.equal(resolved.song.score.color,'#ffffff');
  assert.equal(resolved.song.score.fontWeight,600);assert.equal(resolved.common.brand.color,'#ffffff');
  assert.deepEqual(resolved.images,layout.images);assert.deepEqual(resolved.backdrops,layout.backdrops);
  assert.deepEqual(resolved.song.video,layout.song.video);assert.deepEqual(resolved.overview,layout.overview);
  assert.deepEqual(p,before);assert.deepEqual(resolveTextLayout(p,b),getLayout(p));
  p.settings.componentLayout.song.title.fontSize=72;
  assert.equal(resolveTextLayout(p,a).song.title.fontSize,72);
  setTextStyle(a,'song.title','color','');assert.equal(resolveTextLayout(p,a).song.title.color,'#ffffff');
  setTextStyle(a,'all','color','');assert.equal(resolveTextLayout(p,a).song.title.color,'#123456');
  assert.equal(resolveTextLayout(p,a).song.title.textColorOverride,undefined);
  assert.deepEqual(textStylePatch(a,'song.title'),{textShadow:'strong'});
});

test('text overrides are sparse, bounded, sanitized and survive project serialization',()=>{
  const raw={all:{color:' #AbCdEf80 ',fontFamily:'Consolas',fontWeight:'600',fontSize:999,textShadow:'strong',x:500,visible:false,background:'#000000'},'song.video':{color:'#000000'},'song.title':{color:'red;opacity:0',fontFamily:'x;display:none',fontWeight:800,fontSize:false,textShadow:'x'},'song.score':{fontSize:28},'overview.grid':{color:'#000000'},bad:{color:'#000000'}};
  const before=structuredClone(raw),styles=normalizeTextStyles(raw);
  assert.deepEqual(raw,before);
  assert.deepEqual(styles,{all:{color:'#AbCdEf80',fontFamily:'Consolas',fontWeight:600,fontSize:200,textShadow:'strong'},'song.score':{fontSize:28}});
  assert.deepEqual(normalizeTextStyles(styles),styles);
  for(const invalid of [null,[],true,'text',42])assert.deepEqual(normalizeTextStyles(invalid),{});
  const p=newProject();p.entries=[newEntry({id:'a',title:'A',constant:10,score:9900000,textStyles:raw}),newEntry({id:'b',title:'B',constant:11,score:9900000})];
  const restored=validateProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(restored.entries[0].textStyles,styles);assert.deepEqual(restored.entries[1].textStyles,{});
  const scene=buildTimeline(restored).scenes.find(s=>s.entry?.id==='a');assert.deepEqual(scene.entry.textStyles,styles);
  setTextStyle(restored.entries[0],'all','fontFamily','');assert.equal(restored.entries[0].textStyles.all.fontFamily,undefined);
});

test('song text editor edits only the chosen component and supports clear, reset and validation',()=>{
  const p=newProject();p.entries=[newEntry(),newEntry()];let entry=p.entries[0],changes=0,refreshes=0,errors=[];
  const handlers=new Map(),root={addEventListener:(type,fn)=>handlers.set(type,fn)};
  bindTextStyleEditor(root,{entry:()=>entry,commit:edit=>{edit();changes++;},refresh:()=>refreshes++,error:message=>errors.push(message)});
  const change=(field,value)=>handlers.get('change')({target:{value,dataset:{textStyleField:field},hasAttribute:()=>false}});
  const select=value=>handlers.get('change')({target:{value,dataset:{},hasAttribute:attr=>attr==='data-text-style-component'}});
  const click=action=>handlers.get('click')({preventDefault(){},target:{closest:()=>({dataset:{textStyleAction:action},disabled:false})}});
  select('all');change('color','#ffffff');change('textShadow','strong');
  select('song.title');change('fontSize','60');change('color','#20202a');
  assert.equal(entry.textStyles['song.title'].fontSize,60);assert.equal(entry.textStyles.all.color,'#ffffff');
  let view=textStyleView(p,entry);assert.match(view,/本曲文字/);assert.match(view,/已自定义 2 组/);assert.match(view,/value="60"/);
  const before=structuredClone(entry),count=changes;change('color','red;opacity:0');change('fontSize','0');
  assert.equal(errors.length,2);assert.equal(changes,count);assert.deepEqual(entry,before);
  change('color','');assert.equal(entry.textStyles['song.title'].color,undefined);
  click('reset-component');assert.equal(entry.textStyles['song.title'],undefined);assert.equal(entry.textStyles.all.color,'#ffffff');
  entry=p.entries[1];click('dark');assert.equal(entry.textStyles['song.title'].color,'#20202a');
  assert.equal(p.entries[0].textStyles['song.title'],undefined);
  click('reset-all');assert.deepEqual(entry.textStyles,{});select('all');
  view=textStyleView(p,entry);assert.match(view,/继承视频布局/);assert.ok(refreshes>=4);
  assert.equal(textStyleView(p,null),'');
});

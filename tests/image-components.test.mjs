import test from 'node:test';
import assert from 'node:assert/strict';
import {getLayout,normalizeLayout,makeImage,isImageKey,layoutComponent,layoutImageFile,moveImageLayer,componentStyle} from '../shared/layout.mjs';
import {newProject,newEntry,validateProject} from '../shared/core.mjs';
import {checkTimelineMedia} from '../shared/media-check.mjs';
import {bindLayoutEditor,layoutView} from '../renderer/layout-editor.mjs';
import projectMedia from '../main/project-media.cjs';

test('independent images round-trip with paths, crop modes, transparency and separate scene geometry',()=>{
  const p=newProject(),layout=getLayout(p),before=structuredClone(layout.song);
  layout.images.song=[makeImage('cover','自选图片',{file:'E:\\素材 文件夹\\图片.png',x:800,y:300,w:400,h:200,opacity:.65,radius:12,fit:'cover'}),makeImage('per-song','本曲图片',{source:'jacket',visible:false})];
  layout.images.overview=[makeImage('end','总览图片',{file:'end.webp',fit:'fill'})];
  p.settings.componentLayout=layout;
  const restored=getLayout(validateProject(JSON.parse(JSON.stringify(p))));
  assert.deepEqual(restored.images,layout.images);assert.deepEqual(restored.song,before);
  assert.equal(layoutComponent(restored,'song.image:cover').file,layout.images.song[0].file);
  assert.equal(layoutComponent(restored,'song.image:missing'),undefined);
  assert.equal(isImageKey('song.image:cover'),true);assert.equal(isImageKey('common.image:cover'),false);
  restored.images.song=[];p.settings.componentLayout=restored;
  assert.deepEqual(getLayout(validateProject(p)).images.song,[]);
  assert.equal(getLayout(validateProject(p)).images.overview.length,1);
});

test('image normalization bounds geometry, limits count, repairs IDs and rejects styling injection',()=>{
  const raw={images:{song:[null,...Array.from({length:40},()=>({id:'duplicate',file:123,label:'x'.repeat(50),x:-4,y:9000,w:9000,h:9000,fit:'cover;opacity:0',source:'invalid',opacity:2,radius:-4}))],overview:[{id:'../unsafe',source:'jacket',file:'end.png'}]}};
  const before=structuredClone(raw),layout=normalizeLayout(raw);
  assert.deepEqual(raw,before);assert.equal(layout.images.song.length,31);
  assert.equal(new Set(layout.images.song.map(v=>v.id)).size,31);
  for(const image of layout.images.song){assert.equal(image.file,'');assert.equal(image.source,'file');assert.equal(image.fit,'contain');assert.equal(image.opacity,1);assert.equal(image.radius,0);assert.equal(image.label.length,30);assert.equal(image.x,0);assert.equal(image.y,0);assert.equal(image.w,1920);assert.equal(image.h,1080);}
  assert.equal(layout.images.overview[0].source,'file');assert.match(layout.images.overview[0].id,/^[\w-]+$/);
  assert.deepEqual(normalizeLayout(layout),layout);
});

test('image sources resolve only the selected file or current chart image and honor visibility',()=>{
  const picture=makeImage('a','图片',{file:'fixed.png'});
  assert.equal(layoutImageFile(picture,{jacket:'chart.png'}),'fixed.png');
  picture.source='jacket';assert.equal(layoutImageFile(picture,{jacket:'chart.png'}),'chart.png');
  assert.equal(layoutImageFile(picture,{jacket:'next.png'}),'next.png');assert.equal(layoutImageFile(picture,{}),'');
  picture.visible=false;assert.equal(layoutImageFile(picture,{jacket:'chart.png'}),'');
});

test('editor adds, replaces, resizes, hides and removes images; picker cancellation leaves the project intact',async()=>{
  const p=newProject(),listeners=new Map(),picks=['first.png',null,'second.webp',null,'end.png'],oldListen=globalThis.addEventListener,oldDocument=globalThis.document;
  let scene='song',changes=0;
  globalThis.addEventListener=()=>{};globalThis.document={createElement:()=>({innerHTML:'',querySelector:()=>null})};
  const root={addEventListener:(key,fn)=>listeners.set(key,fn),querySelector:()=>null};
  const click=action=>listeners.get('click')({target:{closest:selector=>selector==='[data-layout-action]'?{dataset:{layoutAction:action}}:null}});
  const change=(key,value,type='text')=>listeners.get('change')({target:{dataset:{layoutField:key},type,value,setCustomValidity(){}}});
  try{
    bindLayoutEditor(root,{project:()=>p,scene:()=>scene,refresh:()=>{},preview:()=>{},changed:()=>changes++,pick:async kind=>{assert.equal(kind,'image');return picks.shift();}});
    await click('add-image');let image=getLayout(p).images.song[0],key='song.image:'+image.id;
    assert.equal(image.file,'first.png');assert.equal(changes,1);
    const html=layoutView(p,'song');assert.match(html,/data-layout-action="replace-image"/);assert.match(html,/data-layout-action="delete-image"/);assert.doesNotMatch(html,/data-layout-field="fontSize"|data-layout-field="background"/);
    const before=JSON.stringify(p);await click('replace-image');assert.equal(JSON.stringify(p),before);assert.equal(changes,1);
    await click('replace-image');assert.equal(getLayout(p).images.song[0].file,'second.webp');
    change('w','700','number');change('opacity','.4','number');change('fit','cover');change('source','jacket');
    image=getLayout(p).images.song[0];assert.equal(image.w,700);assert.equal(image.opacity,.4);assert.equal(image.fit,'cover');assert.equal(image.source,'jacket');
    assert.match(layoutView(p,'song'),/跟随本曲图片/);
    listeners.get('change')({target:{dataset:{layoutVisible:key},checked:false}});assert.equal(getLayout(p).images.song[0].visible,false);
    const count=changes;await click('add-image');assert.equal(changes,count);assert.equal(getLayout(p).images.song.length,1);
    scene='overview';layoutView(p,scene);await click('add-image');assert.equal(getLayout(p).images.overview[0].file,'end.png');
    await click('delete-image');assert.deepEqual(getLayout(p).images.overview,[]);assert.equal(getLayout(p).images.song.length,1);
    scene='song';listeners.get('change')({target:{id:'layout-component',dataset:{},value:key}});await click('delete-image');assert.deepEqual(getLayout(p).images.song,[]);
  }finally{
    if(oldListen===undefined)delete globalThis.addEventListener;else globalThis.addEventListener=oldListen;
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  }
});

test('preflight checks visible image components without demanding unused legacy jackets',async()=>{
  const p=newProject();Object.assign(p.settings,{overview:0,segmentGap:0,audioTransition:0});
  p.entries=[newEntry({id:'a',title:'A',constant:10,score:9900000,duration:1,jacket:'unused.png',audioMode:'silent'})];
  const layout=getLayout(p);layout.images.song=[makeImage('a','装饰图片',{file:'broken.png'}),makeImage('b','隐藏图片',{file:'hidden.png',visible:false})];layout.images.overview=[makeImage('end','总览图片',{file:'not-in-film.png'})];p.settings.componentLayout=layout;
  const calls=[],result=await checkTimelineMedia(p,async file=>{calls.push(file);throw Error('不存在');});
  assert.deepEqual(calls,['broken.png']);assert.equal(result.issues.length,1);assert.match(result.issues[0].message,/装饰图片/);
  layout.images.song[0].source='jacket';p.settings.componentLayout=layout;calls.length=0;
  await checkTimelineMedia(p,async file=>{calls.push(file);return {video:true};});assert.deepEqual(calls,['unused.png']);
});

test('project path relocation visits fixed image paths in both scene types including hidden images',()=>{
  const p=newProject();p.entries=[newEntry({video:'a.mp4',jacket:'a.png'})];p.settings.background='bg.png';
  const layout=getLayout(p);layout.images.song=[makeImage('a','图片',{file:'images/custom.png',visible:false})];layout.images.overview=[makeImage('b','图片',{file:'images/end.webp'})];p.settings.componentLayout=layout;
  const calls=[];projectMedia.visitMedia(p,file=>{calls.push(file);return 'project/'+file;});
  assert.equal(p.settings.componentLayout.images.song[0].file,'project/images/custom.png');assert.equal(p.settings.componentLayout.images.overview[0].file,'project/images/end.webp');
  assert.equal(p.entries[0].video,'project/a.mp4');assert.equal(p.entries[0].jacket,'project/a.png');assert.equal(p.settings.background,'project/bg.png');assert.equal(calls.length,5);
});

test('image depth persists while old images retain their former position below text',()=>{
  const p=newProject(),layout=getLayout(p),old=makeImage('old','旧图片',{file:'a.png'});delete old.zIndex;
  layout.images.song=[old,makeImage('front','上层图片',{file:'b.png',zIndex:8})];p.settings.componentLayout=layout;
  const restored=getLayout(validateProject(JSON.parse(JSON.stringify(p))));
  assert.equal(restored.images.song[0].zIndex,1);assert.equal(restored.images.song[1].zIndex,8);
  assert.match(componentStyle(restored.images.song[1]),/z-index:9;/);
  assert.deepEqual(restored.song,layout.song);assert.deepEqual(normalizeLayout(restored),restored);
  const invalid=normalizeLayout({images:{song:[{id:'low',zIndex:-50},{id:'high',zIndex:10000},{id:'fraction',zIndex:3.6},{id:'injection',zIndex:'2;display:none'}]}});
  assert.deepEqual(invalid.images.song.map(v=>v.zIndex),[1,999,4,1]);
});

test('image layer actions cross the text layer, order overlapping images and leave other scenes untouched',()=>{
  const layout=getLayout(newProject());layout.images.song=[makeImage('a','A',{file:'a.png'}),makeImage('b','B',{file:'b.png',zIndex:4})];layout.images.overview=[makeImage('end','End',{file:'end.png',zIndex:7})];
  const before=structuredClone({song:layout.song,common:layout.common,backdrops:layout.backdrops,overview:layout.images.overview});
  assert.equal(moveImageLayer(layout,'song.image:a','up'),true);assert.equal(layoutComponent(layout,'song.image:a').zIndex,2);
  moveImageLayer(layout,'song.image:a','up');assert.equal(layoutComponent(layout,'song.image:a').zIndex,5);
  moveImageLayer(layout,'song.image:a','down');assert.equal(layoutComponent(layout,'song.image:a').zIndex,3);
  moveImageLayer(layout,'song.image:a','front');assert.equal(layoutComponent(layout,'song.image:a').zIndex,5);assert.equal(layout.images.song.at(-1).id,'a');
  moveImageLayer(layout,'song.image:a','back');assert.equal(layoutComponent(layout,'song.image:a').zIndex,1);assert.equal(layout.images.song[0].id,'a');
  assert.deepEqual({song:layout.song,common:layout.common,backdrops:layout.backdrops,overview:layout.images.overview},before);
  assert.equal(moveImageLayer(layout,'song.image:missing','front'),false);assert.equal(moveImageLayer(layout,'song.title','front'),false);assert.equal(moveImageLayer(layout,'song.image:a','invalid'),false);
});

test('layer boundaries use array order to make front and back deterministic even at equal depth',()=>{
  const layout=getLayout(newProject());layout.images.song=[makeImage('a','A',{zIndex:999}),makeImage('b','B',{zIndex:999})];
  moveImageLayer(layout,'song.image:a','front');assert.deepEqual(layout.images.song.map(v=>v.id),['b','a']);assert.equal(layout.images.song[1].zIndex,999);
  moveImageLayer(layout,'song.image:a','back');assert.equal(layout.images.song[0].id,'a');assert.equal(layout.images.song[0].zIndex,1);
  moveImageLayer(layout,'song.image:a','down');assert.equal(layout.images.song[0].zIndex,1);
});

test('editor binds the image depth field and layer buttons to the saved project',async()=>{
  const p=newProject(),listeners=new Map(),oldListen=globalThis.addEventListener;globalThis.addEventListener=()=>{};
  const root={addEventListener:(key,fn)=>listeners.set(key,fn),querySelector:()=>null};
  const click=action=>listeners.get('click')({target:{closest:selector=>selector==='[data-layout-action]'?{dataset:{layoutAction:action}}:null}});
  try{
    bindLayoutEditor(root,{project:()=>p,scene:()=>'song',refresh:()=>{},preview:()=>{},changed:()=>{},pick:async()=> 'a.png'});
    await click('add-image');const html=layoutView(p,'song');assert.match(html,/data-layout-field="zIndex"/);assert.match(html,/image-layer-front/);assert.match(html,/image-layer-back/);
    listeners.get('change')({target:{dataset:{layoutField:'zIndex'},type:'number',value:'8',setCustomValidity(){}}});assert.equal(getLayout(p).images.song[0].zIndex,8);
    await click('image-layer-back');assert.equal(getLayout(p).images.song[0].zIndex,1);
    await click('image-layer-up');assert.equal(getLayout(p).images.song[0].zIndex,2);
    await click('image-layer-down');assert.equal(getLayout(p).images.song[0].zIndex,1);
    await click('image-layer-front');assert.equal(getLayout(p).images.song[0].zIndex,2);
  }finally{if(oldListen===undefined)delete globalThis.addEventListener;else globalThis.addEventListener=oldListen;}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEFAULT_LAYOUT,getLayout,migrateLayout,normalizeLayout,layoutComponent} from '../shared/layout.mjs';
import {newProject,validateProject} from '../shared/core.mjs';
import {bindLayoutEditor,layoutView} from '../renderer/layout-editor.mjs';

const captured=JSON.parse(readFileSync(new URL('./fixtures/captured-layout.json',import.meta.url),'utf8'));
// New options are layered onto the captured geometry and typography.
for(const scope of ['common','song','overview'])for(const [id,v] of Object.entries(captured[scope])){
  v.readableText=scope==='song'?['score','grade','rating','clear','judgements','comment'].includes(id):scope==='overview'&&['grid','page'].includes(id);
  v.difficultyColor='difficulty';
}
captured.backdrops=JSON.parse(readFileSync(new URL('./fixtures/captured-backdrops.json',import.meta.url),'utf8'));
captured.song.meta.fontWeight=600;
captured.song.rank.fontWeight=600;
captured.images={song:[],overview:[]};

test('new projects use the captured user layout including every position, font, colour and visibility',()=>{
  const layout=getLayout(newProject());
  assert.deepEqual(layout,captured);
  assert.deepEqual(DEFAULT_LAYOUT,captured);
  assert.deepEqual(Object.keys(layout),['version','common','song','overview','backdrops','images']);
  assert.deepEqual(Object.keys(layout.song),['video','title','meta','player','score','grade','rating','clear','judgements','comment','rank','date','footer']);
  assert.deepEqual(Object.keys(layout.overview),['title','player','page','grid','footer']);
  assert.equal(layout.song.title.x,70);assert.equal(layout.song.title.fontSize,55);
  assert.equal(layout.song.meta.fontSize,35);assert.equal(layout.song.grade.fontSize,60);
  assert.equal(layout.song.meta.fontWeight,600);assert.equal(layout.song.rank.fontWeight,600);
  assert.equal(layout.song.judgements.fontSize,45);assert.equal(layout.song.comment.fontSize,50);
  assert.equal(layout.song.player.visible,false);assert.equal(layout.song.date.visible,false);
  assert.equal(layout.overview.player.visible,false);assert.equal(layout.overview.page.visible,true);
  assert.equal(layout.overview.grid.x,100);assert.equal(layout.overview.grid.y,300);
  assert.equal(layout.overview.grid.fontSize,30);
  const fresh=getLayout(newProject());layout.song.title.fontSize=99;
  assert.equal(fresh.song.title.fontSize,55);assert.equal(DEFAULT_LAYOUT.song.title.fontSize,55);
});

test('independent backdrops persist their geometry and deletion without tying them to text boxes',()=>{
  const p=newProject(),layout=getLayout(p),before=structuredClone(layout.song);
  assert.equal(layout.backdrops.song.length,2);assert.equal(layout.backdrops.overview.length,1);
  const panel=layout.backdrops.song[0];Object.assign(panel,{x:1100,y:170,w:780,h:750,opacity:.4,radius:24});
  p.settings.componentLayout=layout;const restored=getLayout(validateProject(p));
  assert.deepEqual(restored.song,before);assert.deepEqual(restored.backdrops.song[0],panel);
  assert.equal(layoutComponent(restored,'song.backdrop:'+panel.id).w,780);
  restored.backdrops.song=[];p.settings.componentLayout=restored;assert.deepEqual(getLayout(validateProject(p)).backdrops.song,[]);
  assert.equal(layoutComponent(restored,'song.backdrop:missing'),undefined);
});

test('layout editor adds, resizes, hides and deletes independent black panels',async()=>{
  const p=newProject(),listeners=new Map(),oldListen=globalThis.addEventListener,oldDocument=globalThis.document;
  globalThis.addEventListener=()=>{};
  globalThis.document={createElement:()=>({innerHTML:'',querySelector:()=>null})};
  const root={addEventListener:(key,fn)=>listeners.set(key,fn),querySelector:()=>null};
  try{
    bindLayoutEditor(root,{project:()=>p,scene:()=>'song',refresh:()=>{},preview:()=>{},changed:()=>{}});
    const click=action=>listeners.get('click')({target:{closest:selector=>selector==='[data-layout-action]'?{dataset:{layoutAction:action}}:null}});
    await click('add-backdrop');const layout=getLayout(p),added=layout.backdrops.song.at(-1),key='song.backdrop:'+added.id;
    assert.equal(layout.backdrops.song.length,3);
    assert.match(layoutView(p,'song'),/data-layout-action="delete-backdrop"/);
    const el={dataset:{layoutField:'w'},value:'900',type:'number',setCustomValidity(){}};listeners.get('change')({target:el});
    assert.equal(getLayout(p).backdrops.song.at(-1).w,900);
    listeners.get('change')({target:{dataset:{layoutVisible:key},checked:false}});assert.equal(getLayout(p).backdrops.song.at(-1).visible,false);
    await click('delete-backdrop');assert.equal(getLayout(p).backdrops.song.length,2);assert.equal(getLayout(p).song.score.x,1255);
  }finally{if(oldListen===undefined)delete globalThis.addEventListener;else globalThis.addEventListener=oldListen;if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;}
});

test('version 1 layouts migrate score, overview page and footers while dropping obsolete intro content',()=>{
  const old={version:1,common:{footer:{x:50,y:990,w:1600,h:40,visible:false,color:'#abcdef',fontSize:20}},song:{score:{x:1200,y:190,w:600,h:130,fontSize:70,visible:false}},intro:{player:{x:100,y:430,w:1500,h:100,fontSize:50,visible:false,color:'#ffeedd'},stats:{x:120,y:700,w:1500,h:180,fontSize:60,visible:false,fontFamily:'Yu Gothic'},artwork:{visible:true}},overview:{player:{x:80,y:230,w:1700,h:70,visible:false,color:'#aabbcc'}}};
  const before=structuredClone(old),out=normalizeLayout(old);
  assert.equal(out.version,2);assert.deepEqual(old,before);
  for(const scope of ['song','overview']){
    assert.equal(out[scope].footer.visible,false);assert.equal(out[scope].footer.x,50);
    assert.equal(out[scope].footer.fontSize,20);assert.equal(out[scope].footer.color,'#abcdef');
  }
  assert.equal(out.overview.player.visible,false);assert.equal(out.overview.player.x,80);
  assert.equal(out.overview.page.visible,false);assert.equal(out.overview.page.x,1440);
  assert.equal(out.overview.page.color,'#aabbcc');assert.equal(out.overview.page.align,'right');
  assert.equal(out.song.score.fontSize,70);assert.equal(out.song.grade.visible,false);
  assert.equal(out.song.grade.fontSize,16);assert.equal(out.song.grade.x,1668);
  assert.equal(out.common.footer,undefined);assert.equal(out.intro,undefined);
  assert.deepEqual(normalizeLayout(out),out);
});

test('existing version 2 custom layouts survive save and load without the new defaults replacing them',()=>{
  const custom=normalizeLayout();
  Object.assign(custom.common.brand,{x:140,y:50,color:'#c0d0e0'});
  Object.assign(custom.song.title,{x:380,y:200,w:1300,h:115,fontSize:83,fontFamily:'Yu Gothic',fontWeight:700,color:'#ffcc00',background:'#11223380',align:'right',opacity:.75,padding:13,radius:11,visible:false});
  Object.assign(custom.song.grade,{x:1550,y:300,fontSize:83,visible:false});
  Object.assign(custom.song.player,{visible:true});Object.assign(custom.song.footer,{visible:false});
  Object.assign(custom.overview.grid,{x:120,y:360,w:1600,h:600,fontSize:27,color:'#abcdef',background:'#01020304'});
  Object.assign(custom.overview.player,{visible:true});Object.assign(custom.overview.page,{x:1500,w:300,visible:false});
  const old=newProject();old.format='arc-reel';old.settings.componentLayout=custom;
  const original=structuredClone(old),restored=validateProject(JSON.parse(JSON.stringify(old)));
  assert.deepEqual(getLayout(restored),custom);assert.deepEqual(old,original);
  assert.deepEqual(normalizeLayout(JSON.parse(JSON.stringify(custom))),custom);
  assert.equal(restored.format,'arcshow-b50videomaker');
});

test('normalization removes obsolete scopes and components, clamps geometry and does not mutate input',()=>{
  const raw={version:2,intro:{artwork:{x:40,visible:true}},common:{footer:{visible:true}},song:{title:{x:-25,y:2000,w:4000,h:1,fontSize:600,fontFamily:'Unknown Font',fontWeight:900,align:'sideways',color:'red',background:'#12345678',opacity:2,padding:-5,radius:400,visible:false},removed:{x:99}},overview:{player:{visible:true},page:{visible:false},retired:{visible:true}}};
  const before=structuredClone(raw),out=normalizeLayout(raw);
  assert.deepEqual(raw,before);assert.equal(out.intro,undefined);assert.equal(out.common.footer,undefined);
  assert.equal(out.song.removed,undefined);assert.equal(out.overview.retired,undefined);
  assert.equal(out.song.title.x,0);assert.equal(out.song.title.y,1056);
  assert.equal(out.song.title.w,1920);assert.equal(out.song.title.h,24);assert.equal(out.song.title.fontSize,200);
  assert.equal(out.song.title.fontFamily,DEFAULT_LAYOUT.song.title.fontFamily);
  assert.equal(out.song.title.fontWeight,DEFAULT_LAYOUT.song.title.fontWeight);
  assert.equal(out.song.title.align,DEFAULT_LAYOUT.song.title.align);
  assert.equal(out.song.title.color,DEFAULT_LAYOUT.song.title.color);assert.equal(out.song.title.background,'#12345678');
  assert.equal(out.song.title.opacity,1);assert.equal(out.song.title.padding,0);assert.equal(out.song.title.radius,100);
  assert.equal(out.song.title.visible,false);assert.equal(out.overview.player.visible,true);assert.equal(out.overview.page.visible,false);
  for(const scope of ['common','song','overview'])for(const value of Object.values(out[scope])){
    assert.ok(value.x>=0&&value.x+value.w<=1920);assert.ok(value.y>=0&&value.y+value.h<=1080);
  }
  assert.deepEqual(normalizeLayout(out),out);assert.equal(migrateLayout(null),null);
});

test('layout editor component and scene resets restore the captured defaults and preserve other customizations',async()=>{
  let currentScene='song';const p=newProject(),listeners=new Map();
  let changes=0,refreshes=0;
  const root={addEventListener:(name,handler)=>listeners.set(name,handler),querySelector:()=>null};
  const oldListen=globalThis.addEventListener,oldConfirm=globalThis.confirm;
  globalThis.addEventListener=()=>{};globalThis.confirm=()=>true;
  const select=value=>listeners.get('change')({target:{id:'layout-component',dataset:{},value}});
  const click=action=>listeners.get('click')({target:{closest:selector=>selector==='[data-layout-action]'?{dataset:{layoutAction:action}}:null}});
  try{
    bindLayoutEditor(root,{project:()=>p,scene:()=>currentScene,refresh:()=>refreshes++,preview:()=>{},changed:()=>changes++});
    p.settings.componentLayout=normalizeLayout();
    Object.assign(p.settings.componentLayout.song.title,{fontSize:99,x:400,visible:false,color:'#abcdef'});
    Object.assign(p.settings.componentLayout.overview.grid,{fontSize:19,y:350});
    select('song.title');await click('reset-component');
    assert.deepEqual(p.settings.componentLayout.song.title,captured.song.title);
    assert.equal(p.settings.componentLayout.overview.grid.fontSize,19);
    p.settings.componentLayout.song.player.visible=true;p.settings.componentLayout.song.grade.fontSize=100;
    const customOverview=structuredClone(p.settings.componentLayout.overview);
    await click('reset-scene');assert.deepEqual(p.settings.componentLayout.song,captured.song);
    assert.deepEqual(p.settings.componentLayout.overview,customOverview);
    currentScene='overview';select('overview.grid');await click('reset-scene');
    assert.deepEqual(p.settings.componentLayout.overview,captured.overview);
    assert.equal(changes,3);assert.ok(refreshes>=3);
    for(const scene of ['song','overview','intro']){
      const html=layoutView(p,scene);assert.doesNotMatch(html,/data-scene="intro"|data-layout-artwork|intro\.artwork/);
    }
  }finally{
    if(oldListen===undefined)delete globalThis.addEventListener;else globalThis.addEventListener=oldListen;
    if(oldConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=oldConfirm;
  }
});

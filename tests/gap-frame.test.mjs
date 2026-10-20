import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newEntry} from '../shared/core.mjs';

test('frame clears the previous video for a pure black gap, then restores normal song components',async t=>{
  const names=['document','window','parent','innerWidth','innerHeight','addEventListener'];
  const saved=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const messages=[],listeners=new Map(),oldVideo={pauses:0,pause(){this.pauses++;}};let video=oldVideo,html='';
  const blurSurface={style:{backdropFilter:'',transform:''}};
  const root={className:'',style:{setProperty(){},transform:''},querySelectorAll:selector=>selector==='video'&&video?[video]:[],querySelector:()=>null,addEventListener(){},get innerHTML(){return html;},set innerHTML(value){html=value;video=null;}};
  globalThis.document={querySelector:selector=>selector==='#scene-blur'?blurSurface:selector==='#stage'?root:null,fonts:{ready:Promise.resolve()}};
  globalThis.window={};globalThis.parent={postMessage:data=>messages.push(data)};
  globalThis.innerWidth=1920;globalThis.innerHeight=1080;globalThis.addEventListener=(type,handler)=>listeners.set(type,handler);
  t.after(()=>{for(const [key,descriptor] of saved)descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];});
  await import('../renderer/frame.mjs?gap-frame-test');
  assert.equal(root.style.transform,'scale(1)');assert.equal(blurSurface.style.transform,root.style.transform);
  globalThis.innerWidth=1000;globalThis.innerHeight=700;listeners.get('resize')();
  assert.equal(root.style.transform,`scale(${1000/1920})`);assert.equal(blurSurface.style.transform,root.style.transform);
  const p=newProject();
  const result=await window.setScene({project:p,scene:{type:'gap',clipId:'gap:song:b',incomingClipId:'song:b',at:1,duration:1}});
  assert.equal(result.ready,true);assert.equal(oldVideo.pauses,1);
  assert.match(root.innerHTML,/background:#000/);
  assert.doesNotMatch(root.innerHTML,/component|video|background-shade|arcshow/);
  assert.equal(root.style.filter,'');assert.equal(blurSurface.style.backdropFilter,'');
  assert.deepEqual(messages.at(-1),{type:'scene-ready',clipId:'gap:song:b'});
  const entry={...newEntry({id:'b',title:'Restored song',constant:10,score:9900000}),rating:11,rank:1};
  await window.setScene({project:p,scene:{type:'song',clipId:'song:b',entry,at:2,duration:1}});
  assert.match(root.innerHTML,/Restored song/);assert.match(root.innerHTML,/arcshow-b50videomaker/);
  assert.match(root.innerHTML,/scene-transition/);assert.deepEqual(messages.at(-1),{type:'scene-ready',clipId:'song:b'});

  const scene={type:'song',clipId:'song:b',entry,at:2,duration:1,blurOpacity:.5};
  await window.setScene({project:p,scene});
  assert.equal(root.style.filter,'');assert.equal(blurSurface.style.backdropFilter,'blur(6px)');
  await listeners.get('message')({data:{type:'sync',seconds:.1,playing:false,blurOpacity:.25}});
  assert.equal(root.style.filter,'');assert.equal(blurSurface.style.backdropFilter,'blur(3px)');
  await listeners.get('message')({data:{type:'sync',seconds:.2,playing:false,blurOpacity:0}});
  assert.equal(root.style.filter,'');assert.equal(blurSurface.style.backdropFilter,'');

  await window.setScene({project:p,scene});
  assert.equal(root.style.filter,'');assert.equal(blurSurface.style.backdropFilter,'blur(6px)');
  await window.setScene({project:p,scene,editing:true});
  assert.equal(root.style.filter,'');assert.equal(blurSurface.style.backdropFilter,'');
  await listeners.get('message')({data:{type:'sync',seconds:.1,playing:false,blurOpacity:1}});
  assert.equal(root.style.filter,'');assert.equal(blurSurface.style.backdropFilter,'');

  await window.setScene({project:p,scene});
  assert.equal(root.style.filter,'');assert.equal(blurSurface.style.backdropFilter,'blur(6px)');
  await window.setScene({project:p,scene,still:true,layer:'foreground'});
  assert.match(root.className,/layer-foreground/);
  assert.equal(root.style.filter,'');assert.equal(blurSurface.style.backdropFilter,'');
  await listeners.get('message')({data:{type:'sync',seconds:.1,playing:false,blurOpacity:1}});
  assert.equal(root.style.filter,'');assert.equal(blurSurface.style.backdropFilter,'');

  await window.setScene({project:p,scene});
  assert.equal(root.style.filter,'');assert.equal(blurSurface.style.backdropFilter,'blur(6px)');
  await window.setScene({project:p,scene:{type:'gap',clipId:'gap:song:c',at:3,duration:1}});
  assert.equal(root.style.filter,'');assert.equal(blurSurface.style.backdropFilter,'');
});

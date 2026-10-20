import test from 'node:test';
import assert from 'node:assert/strict';
import {transitionFor,sceneTransitions,withSceneTransitions,blackOpacity,blurOpacity,ffmpegFadeFilters,ffmpegVisualFilters} from '../shared/transitions.mjs';

const scene=(clipId,duration=4)=>({clipId,duration});
const project=(settings={})=>({settings:{fps:60,transition:.8,...settings}});

test('visual transitions split around existing picture cuts without adding outer film fades',()=>{
  const scenes=[scene('intro'),scene('song:a'),scene('animation:x'),scene('overview:1')];
  const before=JSON.stringify(scenes),fades=sceneTransitions(project(),scenes);
  assert.deepEqual(fades,[{fadeIn:0,fadeOut:.4},{fadeIn:.4,fadeOut:.4},{fadeIn:.4,fadeOut:.4},{fadeIn:.4,fadeOut:0}]);
  assert.equal(JSON.stringify(scenes),before);
  const planned=withSceneTransitions(project(),scenes);
  assert.equal(planned.reduce((sum,s)=>sum+s.duration,0),16);
  assert.deepEqual(planned.map(s=>s.visualTransition),fades);
});

test('each incoming clip can use a black fade or a true zero-second cut',()=>{
  const p=project({sceneTransitions:{'song:a':{mode:'black',duration:2},'animation:x':{mode:'cut',duration:4},'song:b':{mode:'black',duration:0}}});
  const fades=sceneTransitions(p,[scene('intro'),scene('song:a'),scene('animation:x'),scene('song:b')]);
  assert.deepEqual(fades,[{fadeIn:0,fadeOut:1},{fadeIn:1,fadeOut:0},{fadeIn:0,fadeOut:0},{fadeIn:0,fadeOut:0}]);
  assert.deepEqual(transitionFor(p,'song:a'),{mode:'black',duration:2,inherited:false});
  assert.equal(transitionFor(p,'song:missing').inherited,true);
  assert.deepEqual(ffmpegFadeFilters(fades[2],4),[]);
  assert.equal(blackOpacity(fades[2],0,4),0);
});

test('all overview pages inherit the one editable overview transition',()=>{
  const p=project({sceneTransitions:{'overview:1':{mode:'cut',duration:0}}});
  assert.equal(transitionFor(p,'overview:3').mode,'cut');
  assert.deepEqual(sceneTransitions(p,[scene('song:a'),scene('overview:1'),scene('overview:2')]),[{fadeIn:0,fadeOut:0},{fadeIn:0,fadeOut:0},{fadeIn:0,fadeOut:0}]);
});

test('an audio-only join override keeps inheriting future global visual changes',()=>{
  const p=project({sceneTransitions:{'song:b':{audioDuration:0}}});
  assert.deepEqual(transitionFor(p,'song:b'),{mode:'black',duration:.8,inherited:true});
  p.settings.transition=0;
  assert.deepEqual(transitionFor(p,'song:b'),{mode:'black',duration:0,inherited:true});
  p.settings.transition=2;
  assert.equal(sceneTransitions(p,[scene('song:a'),scene('song:b')])[1].fadeIn,1);
});

test('long transitions are frame-aligned and bounded to avoid overlapping within short clips',()=>{
  for(const fps of [30,60]){
    const fades=sceneTransitions(project({fps,transition:5}),[scene('song:a',.5),scene('animation:x',.5),scene('song:b',.5)]);
    for(const fade of fades){
      assert.ok(fade.fadeIn+fade.fadeOut<=.5+1e-9);
      for(const seconds of Object.values(fade))assert.ok(Math.abs(seconds*fps-Math.round(seconds*fps))<1e-9);
    }
  }
  assert.equal(transitionFor(project({transition:99}),'song:a').duration,5);
});

test('black overlay and FFmpeg filters use the same linear enter and exit envelopes',()=>{
  const transition={fadeIn:.4,fadeOut:.4};
  assert.equal(blackOpacity(transition,0,4),1);
  assert.equal(blackOpacity(transition,.2,4),.5);
  assert.equal(blackOpacity(transition,2,4),0);
  assert.ok(Math.abs(blackOpacity(transition,3.8,4)-.5)<1e-9);
  assert.equal(blackOpacity(transition,4,4),1);
  assert.deepEqual(ffmpegFadeFilters(transition,4),['fade=t=in:st=0:d=0.4','fade=t=out:st=3.6:d=0.4']);
});

test('gapless song and animation-to-song joins share the 0.3-second picture cue without black or extra time',()=>{
  for(const previousType of ['song','animation'])for(const fps of [30,60]){
    const scenes=[{...scene(`${previousType}:a`),type:previousType},{...scene('song:b'),type:'song',connectedFromPrevious:true}];
    const p=project({fps,cutBlur:.3}),fades=sceneTransitions(p,scenes);
    assert.equal(fades[0].fadeOut,0);assert.equal(fades[1].fadeIn,0);
    assert.equal(fades[0].blurOut,Math.floor(.3*fps/2)/fps);
    assert.equal(fades[1].blurIn,Math.ceil(.3*fps/2)/fps);
    assert.ok(Math.abs(fades[0].blurOut+fades[1].blurIn-.3)<1e-8);
    assert.equal(blurOpacity(fades[0],4,4),1);assert.equal(blurOpacity(fades[0],3.7,4),0);
    assert.equal(blurOpacity(fades[1],0,4),1);assert.equal(blurOpacity(fades[1],.3,4),0);
    assert.equal(blackOpacity(fades[1],0,4),0);
    assert.equal(withSceneTransitions(p,scenes).reduce((sum,s)=>sum+s.duration,0),8);
    assert.ok(ffmpegVisualFilters(fades[0],4).some(f=>f.includes('gblur=')));
    assert.ok(ffmpegVisualFilters(fades[1],4).some(f=>f.includes('gblur=')));
    p.settings.cutBlur=0;assert.deepEqual(sceneTransitions(p,scenes),[{fadeIn:0,fadeOut:0},{fadeIn:0,fadeOut:0}]);
  }
});

test('an explicit cut or a zero inherited transition can blur animation-to-song joins without an audio connection',()=>{
  const scenes=[{...scene('animation:a'),type:'animation'},{...scene('song:b'),type:'song'}];
  for(const settings of [
    {sceneTransitions:{'song:b':{mode:'cut',duration:4}}},
    {transition:0},
    {sceneTransitions:{'song:b':{mode:'black',duration:0}}}
  ]){
    assert.deepEqual(sceneTransitions(project(settings),scenes),[{fadeIn:0,fadeOut:0,blurOut:.15},{fadeIn:0,fadeOut:0,blurIn:.15}]);
  }
});

test('cut blur stays out of animation targets, overview pages and black gaps',()=>{
  for(const [previousType,incomingType] of [
    ['song','animation'],['animation','animation'],['song','overview'],['animation','overview'],['overview','song'],['gap','song'],['song','gap']
  ]){
    const scenes=[{...scene(`${previousType}:a`),type:previousType},{...scene(`${incomingType}:b`),type:incomingType,connectedFromPrevious:true}];
    const p=project({transition:0,cutBlur:.3});
    assert.deepEqual(sceneTransitions(p,scenes),[{fadeIn:0,fadeOut:0},{fadeIn:0,fadeOut:0}],`${previousType} to ${incomingType}`);
  }
  const scenes=[{...scene('animation:a'),type:'animation'},{...scene('gap:a',1),type:'gap'},{...scene('song:b'),type:'song'}];
  assert.deepEqual(sceneTransitions(project({transition:0}),scenes),scenes.map(()=>({fadeIn:0,fadeOut:0})));
});

test('explicit black transitions replace the direct-cut blur even for connected animation-to-song joins',()=>{
  const scenes=[{...scene('animation:a'),type:'animation'},{...scene('song:b'),type:'song',connectedFromPrevious:true}];
  const p=project({sceneTransitions:{'song:b':{mode:'black',duration:.8}}});
  const fades=sceneTransitions(p,scenes);
  assert.deepEqual(fades,[{fadeIn:0,fadeOut:.4},{fadeIn:.4,fadeOut:0}]);
  for(let index=0;index<fades.length;index++)assert.ok(ffmpegVisualFilters(fades[index],scenes[index].duration).every(f=>!f.includes('gblur=')));
});

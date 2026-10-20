import test from 'node:test';
import assert from 'node:assert/strict';
import {lockPlaybackEditor,refreshPlaybackEditor} from '../renderer/playback-editor.mjs';
function harness(){
  const controls=[{disabled:false},{disabled:true}],attributes={};
  const editor={inert:true,dataset:{clipId:'song:a'},scrollTop:300,classList:{toggle(){}},setAttribute:(k,v)=>attributes[k]=v,querySelectorAll:()=>controls};
  return {editor,controls,attributes};
}
test('preview locks individual controls while the scrolling editor stays non-inert and keeps its content',()=>{
  const h=harness();lockPlaybackEditor(h.editor,true);assert.equal(h.editor.inert,false);assert.deepEqual(h.controls.map(c=>c.disabled),[true,true]);assert.equal(h.editor.scrollTop,300);
  lockPlaybackEditor(h.editor,true);lockPlaybackEditor(h.editor,false);assert.deepEqual(h.controls.map(c=>c.disabled),[false,true]);assert.equal(h.attributes['aria-busy'],'false');
});
test('stopping the same card leaves source video, details panels and their DOM untouched',()=>{
  const h=harness();let renders=0;const render=()=>renders++;
  assert.equal(refreshPlaybackEditor(h.editor,'song:a',{playing:true,render}),false);
  assert.equal(refreshPlaybackEditor(h.editor,'song:a',{playing:false,render}),true);
  assert.equal(renders,0);assert.equal(h.editor.scrollTop,300);assert.equal(h.editor.dataset.clipId,'song:a');
});
test('continuous preview defers editor card changes until playback stops and then renders exactly once',()=>{
  const h=harness(),ids=[],render=(editor,id)=>ids.push(id);
  for(const id of ['song:b','animation:unlock','song:c'])refreshPlaybackEditor(h.editor,id,{playing:true,render});
  assert.deepEqual(ids,[]);assert.equal(h.editor.dataset.clipId,'song:a');
  refreshPlaybackEditor(h.editor,'song:c',{render});refreshPlaybackEditor(h.editor,'song:c',{render});assert.deepEqual(ids,['song:c']);assert.equal(h.editor.dataset.clipId,'song:c');
});

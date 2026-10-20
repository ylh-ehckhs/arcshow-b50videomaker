import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewBufferAudio} from '../renderer/preview-audio.mjs';

function fixture(){
  const sources=[],context={currentTime:10,createGain:()=>({gain:{value:1},connect(){},disconnect(){}}),createBufferSource(){
    const node={connect(){},disconnect(){},stop(){this.stopped=true;},start(when,offset){this.when=when;this.offset=offset;}};sources.push(node);return node;
  }};
  return {context,sources,audio:createPreviewBufferAudio(context,{duration:20},{sourceStart:93})};
}

test('decoded preview audio preserves original source seconds and pauses exactly',async()=>{
  const {context,sources,audio}=fixture();assert.equal(audio.currentTime,93);assert.equal(audio.duration,113);
  audio.currentTime=100;await audio.play();assert.equal(sources[0].offset,7);
  context.currentTime=11.25;assert.equal(audio.currentTime,101.25);
  audio.pause();context.currentTime=40;assert.equal(audio.currentTime,101.25);assert.equal(sources[0].stopped,true);
  await audio.play();context.currentTime=41;assert.equal(audio.currentTime,102.25);
});

test('the next decoded original audio can start on a future shared audio clock',()=>{
  const {context,sources,audio}=fixture();audio.playAt(12);
  assert.equal(sources[0].when,12);context.currentTime=11.9;assert.equal(audio.currentTime,93);
  context.currentTime=12.1;assert.ok(Math.abs(audio.currentTime-93.1)<1e-7);
  audio.pause();context.currentTime=20;assert.ok(Math.abs(audio.currentTime-93.1)<1e-7);
});

test('seeking a playing decoded track cancels the old source and ignores its late end callback',async()=>{
  const {context,sources,audio}=fixture();await audio.play();const oldEnded=sources[0].onended;
  context.currentTime=11;audio.currentTime=105;oldEnded();
  assert.equal(audio.paused,false);assert.equal(sources[1].offset,12);assert.equal(audio.currentTime,105);
  audio.dispose();assert.equal(sources[1].stopped,true);assert.equal(audio.buffer,null);assert.throws(()=>audio.playAt(12),/已释放/);
});

test('natural completion remains ended until a new seek or playback request',async()=>{
  const {context,sources,audio}=fixture();await audio.play();context.currentTime=30;sources[0].onended();
  assert.equal(audio.ended,true);assert.equal(audio.paused,true);assert.equal(audio.currentTime,113);
  audio.currentTime=100;assert.equal(audio.ended,false);await audio.play();assert.equal(audio.ended,false);
});

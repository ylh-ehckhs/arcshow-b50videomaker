import test from 'node:test';
import assert from 'node:assert/strict';
import {createScenePreparationCache,scenePreparationKey} from '../renderer/preview-scene.mjs';

test('scene preparation key ignores playback clocks but invalidates changed visible cards and layouts',()=>{
  const data={project:{settings:{theme:'dusk',background:'background.jpg'}},scene:{type:'song',clipId:'song:a',entry:{title:'Testify',score:9900000},previewSeconds:0,previewPlaying:false,blackOpacity:0,blurOpacity:0}};
  const key=scenePreparationKey(data);
  assert.equal(scenePreparationKey({...data,playing:true,scene:{...data.scene,previewSeconds:.08,previewPlaying:true,blackOpacity:.5,blurOpacity:.8}}),key);
  assert.notEqual(scenePreparationKey({...data,scene:{...data.scene,entry:{...data.scene.entry,score:9999999}}}),key);
  assert.notEqual(scenePreparationKey({...data,project:{settings:{theme:'dawn',background:'background.jpg'}}}),key);
  assert.notEqual(scenePreparationKey({...data,editing:true}),key);
  assert.notEqual(scenePreparationKey({...data,layer:'foreground'}),key);
});

test('prepared cards share asynchronous construction and are consumed without rebuilding or disposal',async()=>{
  let calls=0;const disposed=[],node={card:'a'},cache=createScenePreparationCache({build:async()=>{calls++;return node;},dispose:value=>disposed.push(value)});
  const first=cache.prepare('a',{}),second=cache.prepare('a',{});assert.equal(first,second);assert.equal(await first,node);assert.equal(calls,1);assert.equal(cache.get('a'),node);
  assert.equal(cache.consume('a'),node);assert.equal(cache.size,0);cache.clear();assert.deepEqual(disposed,[]);
});

test('scene cache remains bounded and protects the pending incoming card from speculative eviction',async()=>{
  const disposed=[],cache=createScenePreparationCache({build:async data=>data,dispose:value=>disposed.push(value),maxEntries:2});
  cache.protect('incoming');await cache.prepare('incoming','incoming');await cache.prepare('next','next');await cache.prepare('later','later');
  assert.equal(cache.size,2);assert.equal(cache.get('incoming'),'incoming');assert.equal(cache.get('next'),null);assert.deepEqual(disposed,['next']);
  cache.protect(null);cache.clear();assert.equal(cache.size,0);assert.deepEqual(new Set(disposed),new Set(['incoming','next','later']));
});

test('eviction aborts unfinished card preparation and disposes a late result',async()=>{
  let finish,signal;const disposed=[],cache=createScenePreparationCache({maxEntries:1,build:async(data,abortSignal)=>{
    if(data==='first'){signal=abortSignal;return new Promise(resolve=>{finish=resolve;});}return data;
  },dispose:value=>disposed.push(value)});
  const first=cache.prepare('a','first'),rejected=assert.rejects(first,{name:'AbortError'});await Promise.resolve();
  const second=cache.prepare('b','second');assert.equal(signal.aborted,true);finish('old completed card');await rejected;assert.equal(await second,'second');assert.deepEqual(disposed,['old completed card']);assert.equal(cache.get('a'),null);cache.clear();
});

test('a failed future card can be retried without displacing the current picture',async()=>{
  let calls=0;const cache=createScenePreparationCache({build:async()=>{if(++calls===1)throw new Error('background unavailable');return 'ready';}});
  await assert.rejects(cache.prepare('a',{}),/background unavailable/);assert.equal(cache.size,0);assert.equal(await cache.prepare('a',{}),'ready');assert.equal(calls,2);cache.clear();
});

test('clearing pending scene preparations aborts work and cannot resurrect a cached card',async()=>{
  let finish,signal;const disposed=[],cache=createScenePreparationCache({build:async(_data,abortSignal)=>{signal=abortSignal;return new Promise(resolve=>{finish=resolve;});},dispose:value=>disposed.push(value)});
  const pending=cache.prepare('a',{}),rejected=assert.rejects(pending,{name:'AbortError'});await Promise.resolve();cache.clear();assert.equal(signal.aborted,true);finish('late');await rejected;assert.equal(cache.size,0);assert.deepEqual(disposed,['late']);
});

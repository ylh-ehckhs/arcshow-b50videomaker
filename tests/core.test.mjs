import test from 'node:test';
import assert from 'node:assert/strict';
import {rating,fmtRating,newEntry,newProject,ranked,scenes,parseCsv,importRecords,validateProject,matchMedia,issues} from '../shared/core.mjs';
import {getLayout} from '../shared/layout.mjs';

test('four-decimal ratings match exact rational rounding across constants and score boundaries',()=>{
  let checks=0;
  for(let tenth=10;tenth<=129;tenth++)for(const rule of ['v7','legacy'])for(const clear of ['NC','TL']){
    const bonus=rule==='v7'&&clear==='NC'?2n:0n,c=BigInt(tenth);
    const scores=[0,9199999,9200000,9499999,9500000,9500030,9799999,9800000,9800020,9899999,9900000,9999980,9999999,10000000,10002000];
    for(let s=9500000;s<10000000;s+=7919)scores.push(s);
    for(const score of scores){
      const x=BigInt(score);
      const [num,den]=x>=10000000n?[(c+20n+bonus),10n]:x>=9800000n?[(c+10n+bonus)*20000n+x-9800000n,200000n]:[(c+bonus)*30000n+x-9500000n,300000n];
      const units=num>0n?(num*10000n+den/2n)/den:0n;
      const expected=`${units/10000n}.${String(units%10000n).padStart(4,'0')}`;
      assert.equal(fmtRating(rating({constant:tenth/10,score,clear},rule)),expected,`${tenth/10}/${score}/${clear}/${rule}`);checks++;
    }
  }
  assert.ok(checks>30000);
});

test('the real Alone & Lorn card rounds 11.39207 to 11.3921 without an override',()=>{
  const e=newEntry({title:'Alone & Lorn',constant:9.6,score:9918414,clear:'NC'});
  assert.equal(rating(e),11.39207);assert.equal(fmtRating(rating(e)),'11.3921');
  assert.equal(e.ratingOverride,null);
});

test('legacy projects preserve score overrides and editable layouts through save/load',()=>{
  const p=newProject();p.format='arc-reel';p.entries=[newEntry({title:'Test',constant:10,score:9900000,clear:'NC',ratingOverride:11.7001})];
  const layout=getLayout(p);Object.assign(layout.song.title,{x:500,y:450,fontSize:72,color:'#ffcc00',fontFamily:'Yu Gothic'});layout.song.date.visible=false;p.settings.componentLayout=layout;
  const q=validateProject(JSON.parse(JSON.stringify(p)));
  assert.equal(q.format,'arcshow-b50videomaker');assert.equal(ranked(q)[0].rating,11.7001);
  assert.equal(getLayout(q).song.title.x,500);assert.equal(getLayout(q).song.title.fontSize,72);assert.equal(getLayout(q).song.date.visible,false);
  assert.equal(getLayout(newProject()).song.title.x,70);
});
test('v7 boundary ratings, clear bonuses, clamp, explicit imported rating',()=>{
  const e={constant:10,clear:'NC'};
  assert.equal(rating({...e,score:9500000}),10.2);
  assert.equal(rating({...e,score:9800000}),11.2);
  assert.ok(Math.abs(rating({...e,score:9999999})-12.199995)<1e-9);
  assert.equal(rating({...e,score:10000000}),12.2);
  assert.equal(rating({...e,score:10005000}),12.2);
  assert.equal(rating({...e,score:9800000},'legacy'),11);
  assert.equal(rating({...e,clear:'TL',score:9800000}),11);
  assert.equal(rating({...e,clear:'UNKNOWN',score:9800000}),11);
  assert.equal(rating({...e,constant:1,score:0}),0);
  assert.equal(rating({...e,score:null}),null);
  assert.equal(rating({...e,score:9800000,ratingOverride:12.3456}),12.3456);
});
test('top50 deduplicates chart and preserves different difficulties with countdown ranks',()=>{
  const p=newProject();p.entries=Array.from({length:55},(_,i)=>newEntry({title:'song '+i,difficulty:'FTR',constant:10,score:10000000-i*1000,clear:'NC'}));
  p.entries.push(newEntry({title:'song 0',difficulty:'FTR',constant:10,score:9990000,clear:'NC'}));
  p.entries.push(newEntry({title:'song 0',difficulty:'BYD',constant:11,score:10000000,clear:'NC'}));
  const list=ranked(p);assert.equal(list.length,50);assert.equal(list[0].difficulty,'BYD');assert.equal(list.filter(x=>x.title==='song 0'&&x.difficulty==='FTR').length,1);
  const songs=scenes(p).filter(s=>s.type==='song');assert.equal(songs[0].entry.rank,50);assert.equal(songs.at(-1).entry.rank,1);assert.equal(scenes(p).filter(s=>s.type==='overview').length,5);
});
test('CSV handles BOM, apostrophe scores, commas and multiline comments',()=>{
  const csv='\uFEFF曲名,难度,定数,分数,通关状态,短评\r\n"Title, 1",FTR,10.5,"09\'980\'001",NC,"Line one\nLine ""two"""';
  const [e]=importRecords(csv,'csv');assert.equal(e.title,'Title, 1');assert.equal(e.score,9980001);assert.equal(e.comment,'Line one\nLine "two"');assert.equal(e.difficulty,'FTR');
  assert.throws(()=>parseCsv('a,b\n"unclosed'),/未闭合/);
});
test('BotArc-style score arrays and missing fields',()=>{
  const [e]=importRecords(JSON.stringify({content:{best30_list:[{song_id:'abc',rating_class:3,score:9999999,clear_type:2,rating:12.3456}]}}),'json',[{id:'abc',title:'Song',tiers:{BYD:11}}]);assert.equal(e.title,'Song');assert.equal(e.difficulty,'BYD');assert.equal(e.clear,'FR');assert.equal(e.constant,11);assert.equal(e.ratingOverride,12.3456);
  const p=newProject();assert.ok(issues(newEntry(),p).length>=3);assert.throws(()=>validateProject({format:'other'}));
  p.settings.volume=100;assert.throws(()=>validateProject(p),/volume/);
});
test('local asset matching refuses wrong difficulty and ambiguous duplicates',()=>{
  const e=newEntry({title:'Inverted World',difficulty:'ETR'});
  assert.deepEqual(matchMedia(e,[{name:'[Future] Inverted World.mp4',kind:'video',path:'wrong'}]),{});
  assert.equal(matchMedia(e,[{name:'[Eternal 10.7] Inverted World.mp4',kind:'video',path:'right'}]).video,'right');
  assert.deepEqual(matchMedia(e,[{name:'Inverted World.mp4',kind:'video',path:'a'},{name:'Inverted World.mkv',kind:'video',path:'b'}]),{});
  assert.deepEqual(matchMedia({...e,video:'manual'},[{name:'Inverted World.mp4',kind:'video',path:'x'}]),{});
});
test('malformed record types do not crash UI or ranking and punctuation titles stay distinct',()=>{
  const [e]=importRecords(JSON.stringify([{title:123,score:9990000,constant:10,comment:42}]));assert.equal(e.title,'123');assert.equal(e.comment,'42');
  const p=newProject();p.entries=[newEntry({title:'~_+',constant:10,score:9990000}),newEntry({title:'!!!',constant:10,score:9990000})];assert.equal(ranked(p).length,2);
  const q=validateProject({...p,name:123,settings:{...p.settings,background:null}});assert.equal(q.name,'123');assert.equal(q.settings.background,'');
});

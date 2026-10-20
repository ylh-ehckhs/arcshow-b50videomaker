import test from 'node:test';
import assert from 'node:assert/strict';
import {commentHtml,truncateComment} from '../shared/comments.mjs';
import {commentEmojiAsset} from '../shared/comment-emoji.mjs';
import {COMMENT_EMOJI_FILES} from '../shared/comment-emoji-data.mjs';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {newEntry,newProject,validateProject,buildTimeline} from '../shared/core.mjs';
import {previewPayload} from '../renderer/preview-payload.mjs';

test('all five user-specified Unicode faces use the approved local artwork and retain their exact code points',()=>{
  for(const code of [0x1F621,0x1F62D,0x1F913,0x1F630,0x1F914]){
    const text=String.fromCodePoint(code),src=commentEmojiAsset(text);
    assert.ok(src.endsWith('/'+code.toString(16)+'.png'));
    assert.equal(commentHtml({comment:text}),`<img class="comment-emoji" src="${src}" alt="${text}" draggable="false">`);
  }
});

test('ordinary text stays escaped and emoji support is not restricted to five faces',()=>{
  const html=commentHtml({comment:'短评 <img onerror="bad"> 😋😊🥹🫠\n& 好'});
  assert.equal((html.match(/class="comment-emoji"/g)||[]).length,4);
  assert.ok(html.includes('&lt;img onerror=&quot;bad&quot;&gt;'));assert.ok(html.includes('\n&amp; 好'));
  assert.equal(commentHtml({comment:'普通文字 [微笑] 123 ABC'}),'普通文字 [微笑] 123 ABC');
});

test('skin tones, ZWJ expressions, flags, selectors and keycaps are kept as whole graphemes',()=>{
  for(const text of ['👍🏽','👩🏽‍💻','👨‍👩‍👧‍👦','🏳️‍🌈','🇨🇳','❤️','1️⃣','😶‍🌫️','😵‍💫','🫨']){
    assert.ok(commentEmojiAsset(text),'local sequence: '+text);
    assert.equal(commentHtml({comment:text}),`<img class="comment-emoji" src="${commentEmojiAsset(text)}" alt="${text}" draggable="false">`,text);
  }
  assert.equal(commentHtml({comment:'♥\uFE0E'}),'♥\uFE0E');
  assert.equal(commentHtml({comment:'© ® ™ ♥ ↔'}),'© ® ™ ♥ ↔');
  assert.ok(commentEmojiAsset('♥\uFE0F'));
});

test('emoji comments survive normalization, saved JSON and lean preview transfer without token conversion',()=>{
  const comment='😡😭🤓😰🤔\n中文与 emoji 混排 👍🏽';
  const p=newProject();p.entries=[newEntry({title:'Emoji',constant:10,score:9900000,clear:'NC',comment,duration:2})];
  const restored=validateProject(JSON.parse(JSON.stringify(p))),entry=restored.entries[0];assert.equal(entry.comment,comment);
  const scene=buildTimeline(restored).scenes.find(s=>s.type==='song');assert.equal(previewPayload(restored,scene).scene.entry.comment,comment);
});

test('the 500-unit comment limit does not split emoji, joiners, modifiers or combining marks',()=>{
  assert.equal(truncateComment('字'.repeat(498)+'😊'),'字'.repeat(498)+'😊');
  for(const text of ['😊','👍🏽','👩🏽‍💻','👨‍👩‍👧‍👦','🏳️‍🌈','🇨🇳','1️⃣','e\u0301'])assert.equal(truncateComment('字'.repeat(499)+text),'字'.repeat(499));
  assert.equal(newEntry({comment:'字'.repeat(499)+'😊'}).comment.length,499);
});

test('the entire packaged artwork manifest resolves locally and keeps the selected legacy faces',{skip:!fs.existsSync(new URL('../resources/emoji/apple/images/1f621.png',import.meta.url))},()=>{
  const root=new URL('../resources/emoji/apple/',import.meta.url);
  const manifest=JSON.parse(fs.readFileSync(new URL('manifest.json',root),'utf8'));
  assert.ok(manifest.glyphCount>3700);assert.equal(Object.keys(COMMENT_EMOJI_FILES).length,manifest.glyphCount);
  for(const [key,asset] of Object.entries(manifest.assets)){
    assert.equal(COMMENT_EMOJI_FILES[key],asset.file);
    assert.match(asset.file,/^[0-9a-f-]+\.png$/);
    const bytes=fs.readFileSync(new URL('images/'+asset.file,root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256,key);
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  }
  for(const key of ['1f621','1f62d','1f913','1f630','1f914','1f60b'])assert.equal(manifest.assets[key].version,'3.0.0');
  for(const key of ['1f979','1fae0','1fae8','1f635-200d-1f4ab'])assert.equal(manifest.assets[key].version,'16.0.0');
});

test('unknown future emoji retain their Unicode instead of creating a broken image',()=>{
  const future='😡\u200d😡';assert.equal(commentEmojiAsset(future),'');
  assert.equal(commentHtml({comment:future}),`<span class="comment-emoji-fallback">${future}</span>`);
});

import {COMMENT_EMOJI_FILES} from './comment-emoji-data.mjs';

const root=new URL('../resources/emoji/apple/images/',import.meta.url);
const presentation=/[\p{Emoji_Presentation}\u20e3]/u;

export function isCommentEmoji(text){
  return !text.includes('\uFE0E')&&(presentation.test(text)||text.includes('\uFE0F'));
}

export function commentEmojiAsset(text){
  if(!isCommentEmoji(text))return '';
  const key=Array.from(text,c=>c.codePointAt(0)).filter(cp=>cp!==0xFE0F).map(cp=>cp.toString(16).padStart(4,'0')).join('-');
  const file=COMMENT_EMOJI_FILES[key];
  return file?new URL(file,root).href:'';
}

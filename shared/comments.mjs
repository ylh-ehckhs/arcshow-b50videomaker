import {commentEmojiAsset,isCommentEmoji} from './comment-emoji.mjs';
import {truncateComment} from './comment-text.mjs';
export {truncateComment} from './comment-text.mjs';

const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'});

export function commentHtml(entry){
  let html='';
  for(const {segment} of graphemes.segment(truncateComment(entry?.comment))){
    const text=escape(segment);
    const asset=commentEmojiAsset(segment);
    // Keep the exact Unicode as alt text and in the saved comment. Only the
    // composed movie substitutes artwork, so changing Windows fonts cannot
    // change the approved faces. Unknown future sequences remain readable.
    html+=asset?`<img class="comment-emoji" src="${escape(asset)}" alt="${text}" draggable="false">`:isCommentEmoji(segment)?`<span class="comment-emoji-fallback">${text}</span>`:text;
  }
  return html;
}

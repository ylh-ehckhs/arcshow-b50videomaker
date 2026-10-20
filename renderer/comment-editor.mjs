import {commentHtml,truncateComment} from '../shared/comments.mjs';
import {isCommentEmoji} from '../shared/comment-emoji.mjs';

// Keep native text editing and IME handling, but show the same local artwork
// beside it that the scene renderer and exporter use.
export function commentPreviewHtml(entry){
  return `<div class="comment-preview" data-comment-preview${truncateComment(entry?.comment)?'':' hidden'}><span class="comment-preview-label">Apple 效果预览 · 只读</span><div class="comment-preview-text">${commentHtml(entry)}</div></div>`;
}

export function refreshCommentPreview(host,entry){
  const preview=host.querySelector('[data-comment-preview]');
  if(!preview)return;
  preview.hidden=!truncateComment(entry?.comment);
  const text=preview.querySelector('.comment-preview-text');
  const html=commentHtml(entry);
  if(text.innerHTML!==html)text.innerHTML=html;
}

function fragmentText(node){
  if(node.nodeType===3)return node.nodeValue||'';
  if(node.nodeType!==1&&node.nodeType!==11)return '';
  if(['SCRIPT','STYLE','TEMPLATE','NOSCRIPT'].includes(node.tagName))return '';
  if(node.tagName==='IMG')return isCommentEmoji(node.getAttribute('alt')||'')?node.getAttribute('alt'):'';
  if(node.tagName==='BR')return '\n';
  const text=Array.from(node.childNodes,fragmentText).join('');
  return ['P','DIV','LI'].includes(node.tagName)&&text&&!text.endsWith('\n')?text+'\n':text;
}

export function bindCommentClipboard(host,{onImagePaste=()=>{}}={}){
  host.addEventListener('paste',event=>{
    const field=event.target;
    if(field.dataset?.field!=='comment'||field.disabled||field.readOnly||!event.clipboardData)return;
    // Let Chromium handle ordinary text so native editing and undo stay intact.
    if(event.clipboardData.getData('text/plain'))return;
    const imageOnly=Array.from(event.clipboardData.items||[]).some(item=>item.type?.startsWith('image/'));
    const html=event.clipboardData.getData('text/html');
    if(!html){if(imageOnly){event.preventDefault();onImagePaste();}return;}
    const fragment=html.match(/<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i)?.[1]||html;
    const template=field.ownerDocument.createElement('template');template.innerHTML=fragment;
    const text=fragmentText(template.content).replace(/^\n+|\n+$/g,'');
    if(!text){if(imageOnly||template.content.querySelector('img')){event.preventDefault();onImagePaste();}return;}
    event.preventDefault();
    if(!field.ownerDocument.execCommand('insertText',false,text)){
      field.setRangeText(text,field.selectionStart,field.selectionEnd,'end');
      field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste',data:text}));
    }
  });
  host.addEventListener('copy',event=>{
    const selection=host.ownerDocument.getSelection();
    if(!selection?.rangeCount||selection.isCollapsed||!event.clipboardData)return;
    const range=selection.getRangeAt(0),node=range.startContainer;
    const preview=(node.nodeType===1?node:node.parentElement)?.closest('.comment-preview-text');
    if(!preview||!preview.contains(range.endContainer))return;
    const text=fragmentText(range.cloneContents());if(!text)return;
    event.clipboardData.setData('text/plain',text);event.preventDefault();
  });
}

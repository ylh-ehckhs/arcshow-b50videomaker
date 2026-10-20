// Preserve the scrolling editor and its paint/content state during playback.
// Lock form controls individually instead of applying inert to the subtree.
const disabledBeforePlayback=new WeakMap();
export function lockPlaybackEditor(editor,locked){
  if(!editor)return;
  editor.inert=false;
  editor.classList.toggle('playback-editor-locked',locked);
  editor.setAttribute('aria-busy',String(locked));
  for(const control of editor.querySelectorAll('button,input,select,textarea')){
    if(locked){
      if(!disabledBeforePlayback.has(control))disabledBeforePlayback.set(control,control.disabled);
      control.disabled=true;
    }else if(disabledBeforePlayback.has(control)){
      control.disabled=disabledBeforePlayback.get(control);disabledBeforePlayback.delete(control);
    }
  }
}

export function refreshPlaybackEditor(editor,id,{playing=false,render}={}){
  if(!editor)return false;
  lockPlaybackEditor(editor,playing);
  if(playing)return false;
  if(editor.dataset.clipId!==id){render(editor,id);editor.dataset.clipId=id;}
  return true;
}

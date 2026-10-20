const aborted=()=>Object.assign(new Error('预览场景准备已取消'),{name:'AbortError'});

// The clock and transition envelope change every frame, but the composed card
// does not. Keep those transient values out of its reusable preparation key.
export function scenePreparationKey(data){
  const {previewSeconds,previewPlaying,blackOpacity,blurOpacity,...scene}=data.scene;
  return JSON.stringify({project:data.project,scene,still:!!data.still,layer:data.layer||'complete',editing:!!data.editing,selectedComponent:data.selectedComponent||''});
}

/** Bounded preparation of full upcoming cards, in addition to media decoders. */
export function createScenePreparationCache({build,dispose=value=>value?.remove?.(),maxEntries=2}){
  const entries=new Map();let stamp=0,protectedKey=null;
  const capacity=Math.max(1,Math.trunc(maxEntries)||2);
  function release(entry){
    if(entry.released)return;entry.released=true;entry.controller.abort();
    if(entry.ready)dispose(entry.value);
  }
  function trim(){
    while(entries.size>capacity){
      const entry=[...entries.values()].filter(item=>item.key!==protectedKey).sort((a,b)=>a.used-b.used)[0];
      if(!entry)break;entries.delete(entry.key);release(entry);
    }
  }
  function prepare(key,data){
    const existing=entries.get(key);
    if(existing){existing.used=++stamp;return existing.promise;}
    const entry={key,used:++stamp,ready:false,released:false,controller:new AbortController(),value:null,promise:null};
    entries.set(key,entry);
    entry.promise=Promise.resolve().then(()=>{
      if(entry.released)throw aborted();return build(data,entry.controller.signal);
    }).then(value=>{
      if(entry.released){dispose(value);throw aborted();}
      entry.value=value;entry.ready=true;return value;
    }).catch(error=>{if(entries.get(key)===entry)entries.delete(key);release(entry);throw error;});
    entry.promise.catch(()=>{});trim();return entry.promise;
  }
  return {
    prepare,
    get(key){const entry=entries.get(key);if(entry?.ready&&!entry.released){entry.used=++stamp;return entry.value;}return null;},
    protect(key){protectedKey=key;trim();},
    consume(key){const entry=entries.get(key);if(!entry?.ready)return null;entries.delete(key);return entry.value;},
    clear(){for(const entry of entries.values())release(entry);entries.clear();protectedKey=null;},
    get size(){return entries.size;}
  };
}

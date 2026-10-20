// OCR review data is useful in the editor, but must never be cloned into the
// preview iframe on each picture cut. The frame renders one scene at a time.
const previewEntry=entry=>{
  if(!entry)return entry;
  const {sourceThumbnail,ocrRaw,titleOptions,warnings,...visible}=entry;
  return visible;
};

export function previewPayload(project,scene,options={}){
  const {entries,sequence,audioGroups,excludedEntryIds,...presentation}=project;
  const picture={...scene};
  if(scene.entry)picture.entry=previewEntry(scene.entry);
  if(scene.entries)picture.entries=scene.entries.map(previewEntry);
  return {...options,project:presentation,scene:picture};
}

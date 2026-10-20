// Visit every persisted local media path for project relocation and permissions.
function visitMedia(project,visit){
  for(const entry of project.entries||[])for(const key of ['video','audio','jacket','background'])if(entry[key])entry[key]=visit(entry[key]);
  for(const clip of project.sequence||[])for(const key of ['file','effectFile'])if(clip[key])clip[key]=visit(clip[key]);
  for(const group of project.audioGroups||[])if(group.source)group.source=visit(group.source);
  for(const key of ['background','globalBgm'])if(project.settings?.[key]&&!project.settings[key].startsWith('partner:'))project.settings[key]=visit(project.settings[key]);
  for(const scope of ['song','overview'])for(const image of project.settings?.componentLayout?.images?.[scope]||[])if(image.file)image.file=visit(image.file);
}
module.exports={visitMedia};

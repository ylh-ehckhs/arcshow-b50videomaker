const {contextBridge,ipcRenderer,webUtils}=require('electron');
const invoke=channel=>(...args)=>ipcRenderer.invoke(channel,...args);
contextBridge.exposeInMainWorld('arc',{
  filePath:file=>webUtils.getPathForFile(file),acceptImage:invoke('image:accept'),
  waveform:invoke('audio:waveform'),align:invoke('audio:align'),cancelAlign:invoke('audio:cancel-align'),loudness:invoke('audio:loudness'),cancelLoudness:invoke('audio:cancel-loudness'),
  previewAudio:invoke('audio:preview'),cancelPreviewAudio:invoke('audio:cancel-preview'),
  info:invoke('app:info'),pick:invoke('file:pick'),importData:invoke('data:import'),save:invoke('project:save'),open:invoke('project:open'),recover:invoke('project:recover'),autosave:invoke('project:autosave'),scan:invoke('media:scan'),probe:invoke('media:probe'),ocr:invoke('ocr:start'),cancelOcr:invoke('ocr:cancel'),export:invoke('export:start'),cancelExport:invoke('export:cancel'),reveal:invoke('file:reveal'),snapshot:invoke('scene:snapshot'),
  onProgress:callback=>{const h=(_,data)=>callback(data);ipcRenderer.on('job:progress',h);return()=>ipcRenderer.removeListener('job:progress',h);},
  onZoom:callback=>{const h=(_,command)=>callback(command);ipcRenderer.on('ui:zoom',h);return()=>ipcRenderer.removeListener('ui:zoom',h);},
  testCapture:invoke('test:capture')
});

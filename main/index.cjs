const {app,BrowserWindow,ipcMain,dialog,shell,protocol,screen,nativeImage,Menu}=require('electron');
const fs=require('node:fs/promises');
const fsSync=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {Readable}=require('node:stream');
const {pathToFileURL}=require('node:url');
const {exportMovie,probe,binary}=require('./exporter.cjs');
const ROOT=path.join(__dirname,'..');
app.setName('arcshow-b50videomaker');
app.setPath('userData',process.env.ARCSHOW_USER_DATA||process.env.ARC_REEL_USER_DATA||path.join(app.getPath('appData'),'ARC REEL')); // Keep existing autosave and browser preferences.
require('./loudness.cjs').configureCache(path.join(app.getPath('userData'),'loudness-cache-v1'));
require('./preview-audio-cache.cjs').configureCache(path.join(app.getPath('userData'),'preview-audio-cache-v1'));
app.commandLine.appendSwitch('disable-gpu-process-priority');
protocol.registerSchemesAsPrivileged([{scheme:'arc-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
let win,renderWindow,exportJob=null,ocrJob=null,alignController=null;
let renderChain=Promise.resolve(),captureGeneration=0;
const allowed=new Set();
const loudnessRequests=new Map();
const previewRequests=new Map();
app.on('before-quit',()=>{for(const controller of [...loudnessRequests.values(),...previewRequests.values()])controller.abort();});
const permit=file=>{if(typeof file==='string'&&file)allowed.add(path.resolve(file));};
const {visitMedia}=require('./project-media.cjs');
const permitProject=p=>visitMedia(p,file=>{permit(file);return file;});
const progress=data=>{if(win&&!win.isDestroyed())win.webContents.send('job:progress',data);};
const core=()=>import(pathToFileURL(path.join(ROOT,'shared/core.mjs')));
async function atomicJson(file,data){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(data,null,2),'utf8');await fs.rename(tmp,file);}
const filters={data:[{name:'成绩文件',extensions:['json','csv','tsv']}],image:[{name:'图片',extensions:['png','jpg','jpeg','webp','bmp']}],video:[{name:'录像',extensions:['mp4','mkv','mov','webm','avi','m4v']}],audio:[{name:'音频',extensions:['mp3','m4a','aac','flac','wav','ogg','opus']}],sound:[{name:'共同音源（音频或录像）',extensions:['mp3','m4a','aac','flac','wav','ogg','opus','mp4','mkv','mov','webm','avi','m4v']}],project:[{name:'arcshow-b50videomaker 工程',extensions:['arcshow','arcreel']}]};
async function pick(kind){const r=await dialog.showOpenDialog(win,{properties:kind==='directory'?['openDirectory']:['openFile'],filters:filters[kind]||[]});if(r.canceled)return null;const file=r.filePaths[0];permit(file);return file;}
async function renderScene(payload){
  const task=async()=>{
    if(!renderWindow||renderWindow.isDestroyed()){
      renderWindow=new BrowserWindow({width:1920,height:1082,useContentSize:true,show:false,transparent:true,backgroundColor:'#00000000',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
      // Initial window bounds can be clamped to the monitor's logical work area.
      renderWindow.setContentSize(1920,1082);
      await renderWindow.loadFile(path.join(ROOT,'renderer/frame.html'));
    }
    permitProject(payload.project);
    await renderWindow.webContents.executeJavaScript(`window.setScene(${JSON.stringify(payload)})`,true);
    // Reserve two extra rows outside the movie canvas for a scene token. Paint
    // events can already be queued for an earlier scene when setScene resolves.
    const token=++captureGeneration%65536;
    const markerGradient='linear-gradient(to right,'+Array.from({length:16},(_,i)=>{const c=token&(1<<i)?'#fff':'#000';return `${c} ${i*2}px,${c} ${(i+1)*2}px`;}).join(',')+')';
    await renderWindow.webContents.executeJavaScript(`(()=>{let marker=document.getElementById('capture-token');if(!marker){marker=document.createElement('div');marker.id='capture-token';document.body.append(marker);}marker.style.cssText=${JSON.stringify('position:fixed;left:0;bottom:0;width:32px;height:2px;z-index:2147483647;background:'+markerGradient)};})()`);
    await renderWindow.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    // Hidden native windows can return a frame before image layers reach the
    // compositor. Offscreen rendering supplies a fully painted bitmap instead.
    const png=await new Promise((resolve,reject)=>{
      const contents=renderWindow.webContents;
      let settled=false;
      const cleanup=()=>{settled=true;clearTimeout(timer);contents.removeListener('paint',paint);};
      const repaint=()=>setTimeout(()=>{if(!settled&&!contents.isDestroyed())contents.invalidate();},16);
      const paint=(_event,_dirtyRect,frame)=>{
        if(frame.isEmpty()){repaint();return;}
        const size=frame.getSize(),normalized=size.width===1920&&size.height===1082?frame:frame.resize({width:1920,height:1082,quality:'best'});
        const pixels=normalized.toBitmap();let paintedToken=0,opaque=true;
        for(let i=0;i<16;i++){const at=(1081*1920+i*2+1)*4;if(pixels[at+3]<240)opaque=false;if(Math.max(pixels[at],pixels[at+1],pixels[at+2])>128)paintedToken|=1<<i;}
        if(!opaque||paintedToken!==token){repaint();return;}
        const bytes=normalized.crop({x:0,y:0,width:1920,height:1080}).toPNG({scaleFactor:1});
        if(bytes.length<24){repaint();return;}cleanup();resolve(bytes);
      };
      const timer=setTimeout(()=>{cleanup();reject(new Error('影片画面绘制超时，请重试导出'));},10000);
      contents.on('paint',paint);contents.startPainting();contents.invalidate();
    });
    // Respect Windows DPI in the GUI while keeping exported frames exactly 1080p.
    if(png.readUInt32BE(16)!==1920||png.readUInt32BE(20)!==1080){
      return nativeImage.createFromBuffer(png).resize({width:1920,height:1080,quality:'best'}).toPNG();
    }
    return png;
  };
  const result=renderChain.then(task,task);renderChain=result.catch(()=>{});return result;
}
app.whenReady().then(async()=>{
  await fs.mkdir(app.getPath('userData'),{recursive:true});
  protocol.handle('arc-media',async request=>{
    try{
      const file=path.resolve(new URL(request.url).searchParams.get('path')||'');
      if(!allowed.has(file))return new Response('Forbidden',{status:403});
      const stat=await fs.stat(file);if(!stat.isFile())return new Response('Not found',{status:404});
      const mime={'.mp4':'video/mp4','.mkv':'video/x-matroska','.webm':'video/webm','.mov':'video/quicktime','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.wav':'audio/wav','.ogg':'audio/ogg','.flac':'audio/flac','.opus':'audio/ogg','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.bmp':'image/bmp'}[path.extname(file).toLowerCase()]||'application/octet-stream';
      const range=request.headers.get('Range');let start=0,end=stat.size-1,status=200;
      if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m)return new Response(null,{status:416});if(!m[1])start=Math.max(0,stat.size-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}if(start>end||start>=stat.size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${stat.size}`}});status=206;}
      const headers={'Content-Type':mime,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Access-Control-Allow-Origin':'*'};if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
      if(request.method==='HEAD')return new Response(null,{status,headers});
      return new Response(Readable.toWeb(fsSync.createReadStream(file,{start,end})),{status,headers});
    }catch{return new Response('File unavailable',{status:404});}
  });
  const workArea=screen.getPrimaryDisplay().workAreaSize;
  win=new BrowserWindow({width:Math.min(1600,workArea.width),height:Math.min(1000,workArea.height),minWidth:Math.min(960,workArea.width),minHeight:Math.min(600,workArea.height),show:false,backgroundColor:'#f4f5ef',title:'arcshow-b50videomaker',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.once('ready-to-show',()=>{win.maximize();win.show();});
  require('./text-editing.cjs').bindTextContextMenu(win,Menu);
  win.webContents.on('before-input-event',(event,input)=>{
    if(!(input.control||input.meta)||input.type!=='keyDown')return;
    const command=['+','=','Add'].includes(input.key)?'in':['-','_','Subtract'].includes(input.key)?'out':input.key==='0'?'reset':null;
    if(command){event.preventDefault();win.webContents.send('ui:zoom',command);}
  });
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url!==win.webContents.getURL())event.preventDefault();});
  win.on('close',event=>{if(exportJob||ocrJob){const choice=dialog.showMessageBoxSync(win,{type:'question',buttons:['继续等待','取消任务并退出'],defaultId:0,cancelId:0,message:'本地任务仍在运行，是否退出？'});if(choice===0){event.preventDefault();return;}for(const job of [exportJob,ocrJob])if(job){job.cancelled=true;job.child?.kill();}}});
  await win.loadFile(path.join(ROOT,'renderer/index.html'),process.env.ARC_REEL_TEST==='1'?{query:{test:'1'}}:{});
});
app.on('window-all-closed',()=>{app.quit();});
app.on('before-quit',()=>{alignController?.abort();exportJob?.child?.kill();ocrJob?.child?.kill();renderWindow?.destroy();});
ipcMain.handle('app:info',async()=>({version:app.getVersion(),ffmpeg:fsSync.existsSync(binary('ffmpeg')),ocr:fsSync.existsSync(path.join(ROOT,'dist/ocr.cjs'))&&fsSync.existsSync(path.join(ROOT,'resources/onnx-models/rec_ch_v5.onnx')),songs:JSON.parse(await fs.readFile(path.join(ROOT,'data/songs.json'),'utf8')),platform:process.platform}));
ipcMain.handle('file:pick',(_,kind)=>pick(kind));
ipcMain.handle('image:accept',async(_,file)=>{
  if(typeof file!=='string'||!file)throw new Error('请拖入本机图片文件');
  const full=path.resolve(file);if(!filters.image[0].extensions.includes(path.extname(full).slice(1).toLowerCase()))throw new Error('仅支持 PNG、JPG、WEBP、BMP 图片');
  const stat=await fs.stat(full);if(!stat.isFile()||stat.size===0||stat.size>100*1024*1024)throw new Error('图片无效或超过 100 MB');
  // nativeImage does not decode WEBP on the bundled Windows Electron build.
  if(nativeImage.createFromPath(full).isEmpty()){
    const meta=await probe(full).catch(()=>null);if(!meta?.video||!(meta.width>0)||!(meta.height>0))throw new Error('图片无法解码，请换用有效的 PNG、JPG、WEBP 或 BMP 图片');
  }
  permit(full);return full;
});
ipcMain.handle('audio:waveform',async(_,file,options={})=>{permit(file);return require('./audio-tools.cjs').waveform(file,{points:Math.min(3000,Math.max(100,Number(options.points)||1200))});});
ipcMain.handle('audio:align',async(_,input)=>{if(alignController)throw new Error('已有音频对齐任务正在运行');const controller=new AbortController();alignController=controller;try{permit(input?.source);permit(input?.target);return await require('./audio-tools.cjs').align(input,{signal:controller.signal,onProgress:data=>progress({kind:'alignment',...data})});}finally{if(alignController===controller)alignController=null;progress({kind:'alignment',done:true});}});
ipcMain.handle('audio:cancel-align',()=>{alignController?.abort();return true;});
ipcMain.handle('audio:loudness',async(_,tracks,requestId)=>{
  if(typeof requestId!=='string'||!requestId||requestId.length>100||loudnessRequests.has(requestId))throw new Error('响度分析请求无效');
  if(!Array.isArray(tracks)||tracks.length>1000)throw new Error('响度分析音轨列表无效');
  const controller=new AbortController();loudnessRequests.set(requestId,controller);
  try{for(const track of tracks)permit(track.file);return await require('./loudness.cjs').normalizeTracks(tracks,{signal:controller.signal});}
  finally{loudnessRequests.delete(requestId);}
});
ipcMain.handle('audio:cancel-loudness',(_,id)=>{loudnessRequests.get(id)?.abort();return true;});
ipcMain.handle('audio:preview',async(_,tracks,requestId)=>{
  if(typeof requestId!=='string'||!requestId||requestId.length>100||previewRequests.has(requestId))throw new Error('预览音轨请求无效');
  if(!Array.isArray(tracks)||tracks.length>1000||tracks.some(track=>!track||typeof track!=='object'||typeof track.file!=='string'||!track.file.trim()||!Number.isFinite(Number(track.start??0))||Number(track.start??0)<0||!Number.isFinite(Number(track.duration))||Number(track.duration)<=0))throw new Error('预览音轨列表或取用范围无效');
  const controller=new AbortController();previewRequests.set(requestId,controller);
  try{
    for(const track of tracks)permit(track.file);
    const result=await require('./preview-audio-cache.cjs').prepareTracks(tracks,{signal:controller.signal});
    for(const track of result)permit(track.file);
    return result;
  }finally{previewRequests.delete(requestId);}
});
ipcMain.handle('audio:cancel-preview',(_,id)=>{previewRequests.get(id)?.abort();return true;});
ipcMain.handle('file:reveal',(_,file)=>{if(typeof file==='string')shell.showItemInFolder(file);});
ipcMain.handle('data:import',async()=>{const file=await pick('data');if(!file)return null;const {importRecords}=await core();const songs=JSON.parse(await fs.readFile(path.join(ROOT,'data/songs.json'),'utf8'));const entries=importRecords(await fs.readFile(file,'utf8'),path.extname(file).slice(1),songs.entries);const base=path.dirname(file);for(const e of entries)for(const k of ['video','audio','jacket','background'])if(e[k]){e[k]=path.resolve(base,e[k]);permit(e[k]);}return {entries,file};});
ipcMain.handle('project:save',async(_,raw,currentPath)=>{const {validateProject}=await core();const p=validateProject(raw);const r=await dialog.showSaveDialog(win,{defaultPath:currentPath||`${p.name.replace(/[<>:"/\\|?*]/g,'_')}.arcshow`,filters:filters.project});if(r.canceled)return null;p.savedAt=new Date().toISOString();await atomicJson(r.filePath,p);return {path:r.filePath,savedAt:p.savedAt};});
ipcMain.handle('project:open',async()=>{const file=await pick('project');if(!file)return null;const {validateProject}=await core();const p=validateProject(JSON.parse(await fs.readFile(file,'utf8')));visitMedia(p,value=>path.resolve(path.dirname(file),value));permitProject(p);return {project:p,path:file};});
ipcMain.handle('project:recover',async()=>{try{const {validateProject}=await core();const p=validateProject(JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'autosave.json'),'utf8')));permitProject(p);return p;}catch{return null;}});
let saveChain=Promise.resolve();
ipcMain.handle('project:autosave',(_,raw)=>{const task=async()=>{const {validateProject}=await core();const p=validateProject(raw);permitProject(p);await atomicJson(path.join(app.getPath('userData'),'autosave.json'),p);return true;};const r=saveChain.then(task,task);saveChain=r.catch(()=>{});return r;});
ipcMain.handle('media:probe',async(_,file)=>{permit(file);return probe(file);});
ipcMain.handle('media:scan',async()=>{
  const dir=await pick('directory');if(!dir)return null;const files=[];let scanned=0;
  const types={video:['.mp4','.mkv','.mov','.webm','.avi','.m4v'],audio:['.mp3','.flac','.wav','.m4a','.aac','.ogg','.opus'],jacket:['.png','.jpg','.jpeg','.webp','.bmp']};
  async function walk(folder,depth){if(depth>12||scanned>30000)return;for(const ent of await fs.readdir(folder,{withFileTypes:true})){scanned++;const file=path.join(folder,ent.name);if(ent.isSymbolicLink())continue;if(ent.isDirectory()){if(!['node_modules','.git','System Volume Information','$RECYCLE.BIN'].includes(ent.name))await walk(file,depth+1);}else{const kind=Object.keys(types).find(k=>types[k].includes(path.extname(file).toLowerCase()));if(kind){permit(file);files.push({path:file,name:ent.name,kind});}}}}
  await walk(dir,0);return {dir,files,truncated:scanned>30000};
});
ipcMain.handle('ocr:start',async(_,provided,options={})=>{
  if(ocrJob)throw new Error('已有 OCR 识别任务正在运行');
  const file=provided||await pick('image');if(!file)return null;permit(file);
  const job={cancelled:false,child:null};ocrJob=job;
  progress({kind:'ocr',ratio:0,stage:'加载本地 OCR 模型',detail:path.basename(file)});
  try{return await new Promise((resolve,reject)=>{
    const env={...process.env,ARC_USER_DATA:path.join(app.getPath('userData'),'ocr-worker')};delete env.ELECTRON_RUN_AS_NODE;
    const args=[...(process.defaultApp?[app.getAppPath()]:[]),'--arc-ocr-worker',file,JSON.stringify(options)];
    const child=spawn(process.execPath,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});job.child=child;
    let pending='',result=null,error='',stderr='';
    child.stdout.on('data',chunk=>{pending+=chunk;const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines){try{if(line.startsWith('ARC_PROGRESS '))progress({kind:'ocr',...JSON.parse(line.slice(13))});if(line.startsWith('ARC_RESULT '))result=JSON.parse(line.slice(11));if(line.startsWith('ARC_ERROR '))error=JSON.parse(line.slice(10)).error;}catch{}}});
    child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-6000));child.on('error',reject);
    child.on('close',code=>{if(job.cancelled)reject(new Error('已取消识别'));else if(result&&code===0)resolve({...result,file});else reject(new Error(error||stderr||'OCR 进程意外退出'));});
  });}finally{ocrJob=null;progress({kind:'ocr',done:true});}
});
ipcMain.handle('ocr:cancel',()=>{if(ocrJob){ocrJob.cancelled=true;ocrJob.child?.kill();}return true;});
ipcMain.handle('scene:snapshot',async(_,payload)=>{const r=await dialog.showSaveDialog(win,{defaultPath:'arcaea-preview.png',filters:[{name:'PNG',extensions:['png']}]});if(r.canceled)return null;await fs.writeFile(r.filePath,await renderScene(payload));return r.filePath;});
ipcMain.handle('export:start',async(_,project,singleId)=>{
  if(exportJob)throw new Error('已有导出任务正在运行');
  const testOutput=process.env.ARC_REEL_TEST==='1'?process.env.ARC_REEL_OUTPUT:null;
  const r=testOutput?{filePath:testOutput}:await dialog.showSaveDialog(win,{defaultPath:`${String(project.name).replace(/[<>:"/\\|?*]/g,'_')}${singleId?'-preview':''}.mp4`,filters:[{name:'MP4 影片',extensions:['mp4']}]});
  if(r.canceled||!r.filePath)return null;
  const job={cancelled:false,child:null};exportJob=job;
  try{permitProject(project);const result=await exportMovie({project,output:r.filePath,singleId,render:renderScene,progress:data=>progress({kind:'export',...data}),job});progress({kind:'export',ratio:1,done:true,stage:'导出完成',file:result.path});return result;}
  catch(error){progress({kind:'export',done:true,error:error.message});throw error;}
  finally{exportJob=null;}
});
ipcMain.handle('export:cancel',()=>{if(exportJob){exportJob.cancelled=true;exportJob.child?.kill();}return true;});
if(process.env.ARC_REEL_TEST==='1')ipcMain.handle('test:capture',async()=>{return (await win.webContents.capturePage()).toPNG().toString('base64');});

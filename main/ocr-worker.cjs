const {app,nativeImage}=require('electron');
const path=require('node:path');
app.disableHardwareAcceleration();
app.setName('arcshow-b50videomaker OCR');
// If the parent exits or cancels OCR, stop quietly instead of opening an
// uncaught-exception dialog for a write to its closed output pipe.
for(const stream of [process.stdout,process.stderr])stream.on('error',error=>{
  if(error.code==='EPIPE')app.exit(0);
  else throw error;
});
if(process.env.ARC_USER_DATA)app.setPath('userData',process.env.ARC_USER_DATA);
process.env.BEST30_OCR_ENGINE='onnx';
process.env.BEST30_ONNX_MODELS=path.join(__dirname,'..','resources','onnx-models');
const emit=(type,data)=>console.log(`ARC_${type} ${JSON.stringify(data)}`);
app.whenReady().then(async()=>{
  try{
    const {recognizeSheet}=require('../dist/ocr.cjs');
    const flag=process.argv.indexOf('--arc-ocr-worker');
    const input=flag<0?2:flag+1;
    const file=process.argv[input];
    const options=JSON.parse(process.argv[input+1]||'{}');
    const dimensions=nativeImage.createFromPath(file).getSize();
    if(options.layout==='poster'||(options.layout!=='player'&&dimensions.height/dimensions.width>1.4)){
      const {recognizePoster}=require('../dist/poster-ocr.cjs');
      const result=await recognizePoster(file,options,data=>emit('PROGRESS',data));emit('RESULT',result);app.exit(0);return;
    }
    const result=await recognizeSheet(file,{onStage:stage=>emit('PROGRESS',{stage}),onProgress:(done,total)=>emit('PROGRESS',{ratio:done/Math.max(1,total),stage:`正在识别 ${done} / ${total} 张成绩卡`})});
    if(!result.ok)throw new Error(result.error);
    const {enhancePlayer}=require('../dist/player-enhance.cjs');
    await enhancePlayer(file,result,data=>emit('PROGRESS',data));
    const image=nativeImage.createFromPath(file),size=image.getSize();
    result.cards=result.cards.map(card=>{
      const c=card.candidate,v=card.validation;
      const r=card.rect;let thumbnail='';
      try{const x=Math.max(0,Math.floor(r.x)),y=Math.max(0,Math.floor(r.y));thumbnail=image.crop({x,y,width:Math.max(1,Math.min(size.width-x,Math.ceil(r.w))),height:Math.max(1,Math.min(size.height-y,Math.ceil(r.h)))}).resize({width:500}).toDataURL();}catch{}
      return {index:card.index,row:card.row,col:card.col,title:v.matchedTitle||c.title||'',titleOptions:v.titleOptions||[],difficulty:v.difficulty||'',constant:v.constant?.value??c.constant??null,score:c.score??null,clear:v.clearStatus||c.grade||'UNKNOWN',far:c.faults?.far??null,lost:c.faults?.lost??null,detectedRating:v.potential?.value??c.potential??null,warnings:[...(v.reasons||[]),...(c.warnings||[]),...(card.error?[card.error]:[])],notes:v.notes||[],raw:card.items.map(x=>x.text).join('\n'),confidence:c.confidence,thumbnail};
    }).filter(c=>c.title||c.score!=null);
    emit('RESULT',result);app.exit(0);
  }catch(error){emit('ERROR',{error:error.message});app.exit(1);}
});

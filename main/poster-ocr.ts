import {nativeImage} from 'electron'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {recognizeFieldReadings,recognizeTitle,recognizeJapaneseTitleReadings} from '../vendor/ocr/main/onnx-ocr'
import {similarity} from '../vendor/ocr/shared/ocr-validate'
import {extractScore} from '../vendor/ocr/shared/ocr'

interface Options {cols?:number;rows?:number;left?:number;right?:number;top?:number;bottom?:number;rule?:string}
export async function recognizePoster(file:string,options:Options={},progress:(data:unknown)=>void=()=>{}) {
  const t=Date.now(),image=nativeImage.createFromBuffer(readFileSync(file)),size=image.getSize()
  if(image.isEmpty())throw new Error('图片无法解码')
  const cols=options.cols??5,rows=options.rows??10,left=options.left??.04,right=options.right??.97,top=options.top??.11,bottom=options.bottom??.96
  if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<1||cols>10||rows<1||rows>30||cols*rows>100||left<0||right>1||top<0||bottom>1||left>=right||top>=bottom)throw new Error('网格参数无效，最多识别 100 格')
  const cw=(right-left)*size.width/cols,ch=(bottom-top)*size.height/rows
  const table=JSON.parse(readFileSync(join(__dirname,'../data/songs.json'),'utf8')).entries as Array<{title:string;aliases?:string[];tiers:Record<string,number>}>
  const cards=[]
  function crop(x:number,y:number,w:number,h:number){const xx=Math.max(0,Math.floor(x)),yy=Math.max(0,Math.floor(y));return image.crop({x:xx,y:yy,width:Math.max(1,Math.min(size.width-xx,Math.round(w))),height:Math.max(1,Math.min(size.height-yy,Math.round(h)))})}
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const index=row*cols+col+1,x=left*size.width+col*cw,y=top*size.height+row*ch,w=cw*.94,h=ch*.86
    const field=(fx:number,fy:number,fw:number,fh:number)=>crop(x+fx*w,y+fy*h,fw*w,fh*h)
    async function readings(fx:number,fy:number,fw:number,fh:number){const im=field(fx,fy,fw,fh),s=im.getSize();return recognizeFieldReadings(new Uint8Array(im.toBitmap()),s.width,s.height)}
    const titleIm=field(.025,.845,.95,.16),ts=titleIm.getSize()
    const titlePrimary=await recognizeTitle(new Uint8Array(titleIm.toBitmap()),ts.width,ts.height)
    const titles=[titlePrimary,...await readings(.025,.845,.95,.16)]
    // Always retain Japanese candidates: a plausible Latin/Chinese misread must not suppress kana OCR.
    titles.push(...await recognizeJapaneseTitleReadings(new Uint8Array(titleIm.toBitmap()),ts.width,ts.height))
    const padded=field(.005,.82,.99,.20),ps=padded.getSize()
    if(titles.some(r=>/[ぁ-ヿ]/u.test(r.text)))titles.push(...await recognizeJapaneseTitleReadings(new Uint8Array(padded.toBitmap()),ps.width,ps.height))
    const scores=await readings(.33,.675,.62,.17)
    const scoreReads=scores.map(r=>({...r,value:extractScore(r.text)?.value??null})).filter(r=>r.value!=null)
    let score=scoreReads.sort((a,b)=>b.score-a.score)[0]?.value??null
    if(score===null){const retry=await readings(.32,.64,.66,.23);scores.push(...retry);score=retry.map(r=>({...r,value:extractScore(r.text)?.value??null})).filter(r=>r.value!=null).sort((a,b)=>b.score-a.score)[0]?.value??null}
    const potentials=await readings(.045,.342,.265,.16)
    const potValues=potentials.map(r=>{const clean=r.text.replace(/[,·:]/g,'.').replace(/O/g,'0');const match=/(\d{1,2})\.(\d{3,5})/.exec(clean);return {value:match?Number(match[0]):null,score:r.score}}).filter(r=>r.value!=null&&r.value>=5&&r.value<=20).sort((a,b)=>b.score-a.score)
    let detectedRating=potValues[0]?.value??null
    if(detectedRating===null){const retry=await readings(.035,.31,.285,.21);potentials.push(...retry);const match=retry.map(r=>/(\d{1,2})[.,·:](\d{3,5})/.exec(r.text)).find(m=>m&&Number(`${m[1]}.${m[2]}`)>=5&&Number(`${m[1]}.${m[2]}`)<=20);if(match)detectedRating=Number(`${match[1]}.${match[2]}`)}
    const clears=await readings(.83,.68,.17,.2)
    const clearText=clears.map(r=>r.text.toUpperCase().replace(/[^A-Z]/g,'')).find(t=>['C','F','P','L','NC','FR','PM','TL','HC','EC'].includes(t))
    let clear=score!=null&&score>=10000000?'PM':({C:'NC',F:'FR',P:'PM',L:'TL'} as Record<string,string>)[clearText??'']??clearText??'UNKNOWN'
    const bonus=options.rule==='legacy'?0:.2
    const gain=score==null?null:score>=10000000?2:score>=9800000?1+(score-9800000)/200000:(score-9500000)/300000
    const candidates=table.map(song=>{
      const keys=[song.title,...(song.aliases||[])].filter(k=>/[\p{L}\p{N}]/u.test(k))
      const titleScore=Math.max(0,...titles.filter(r=>/[\p{L}\p{N}]/u.test(r.text)).map(r=>Math.max(0,...keys.map(k=>similarity(k,r.text)))))
      const variants=Object.entries(song.tiers).filter(([difficulty])=>!['PST','PRS'].includes(difficulty)).map(([difficulty,constant])=>{
        const bonuses=clear==='UNKNOWN'?[0,bonus]:clear==='TL'?[0]:[bonus]
        const error=detectedRating==null||gain==null?null:Math.min(...bonuses.map(b=>Math.abs(constant+gain+b-detectedRating!)))
        return {difficulty,constant,error}
      }).sort((a,b)=>(a.error??100)-(b.error??100))
      const error=variants[0]?.error
      const value=titleScore+(error!=null&&error<.015?.12:0)
      return {song,titleScore,variants,value}
    }).sort((a,b)=>b.value-a.value)
    const first=candidates[0],valid=first?.titleScore>=.63&&(first.titleScore>=.999||first.value-(candidates[1]?.value??0)>.035),warnings=[] as string[]
    let difficulty='',constant:number|null=null,title=titles.find(t=>t.text.length>0)?.text??''
    if(valid){title=first.song.title;const v=first.variants[0];if(v?.error!=null&&v.error<.015){difficulty=v.difficulty;constant=v.constant;if(first.variants[1]?.error!=null&&first.variants[1].error!<.015)warnings.push('多个难度 Potential 相近，请确认谱面难度');if(clear==='UNKNOWN'&&gain!=null&&detectedRating!=null&&Math.abs(constant+gain+bonus-detectedRating)<.015){clear='NC';warnings.push('通关状态由 Potential 推算，请确认 NC / HC / EC 等具体状态')}}else if(first.variants.length===1){difficulty=first.variants[0].difficulty;constant=first.variants[0].constant;warnings.push('定数来自本地曲库，尚未与图中 Potential 对齐')}else warnings.push('难度与定数无法确定，请手动选择')
      if(first.titleScore<.93)warnings.push('曲名为模糊匹配，请对照原图')
    }else warnings.push('曲名未可靠匹配到离线曲库，请手动修正')
    if(score===null)warnings.push('分数未识别到')
    if(detectedRating===null)warnings.push('Potential 未识别到')
    if(detectedRating!=null&&score!=null&&constant!=null&&gain!=null&&Math.abs(constant+gain+(clear==='TL'||clear==='UNKNOWN'?0:bonus)-detectedRating)>.02){warnings.push('图中 Potential 与分数、定数不一致，图中读数已留空');detectedRating=null}
    if(scoreReads.length>1&&scoreReads[0].value!==scoreReads[1].value)warnings.push('两份识别模型的分数读数不一致')
    const thumbnail=crop(x,y,w,h).resize({width:500}).toDataURL()
    cards.push({index,row:row+1,col:col+1,title,difficulty,constant,score,clear,far:null,lost:null,detectedRating,warnings,notes:['曲绘卡片型分表未提供 Far / Lost，不推测判定数'],titleOptions:candidates.slice(0,5).map(c=>({title:c.song.title})),raw:[...titles.map(r=>'TITLE '+r.text),...scores.map(r=>'SCORE '+r.text),...potentials.map(r=>'POTENTIAL '+r.text),...clears.map(r=>'CLEAR '+r.text)].join('\n'),confidence:titlePrimary.score,thumbnail})
    progress({ratio:index/(cols*rows),stage:`正在识别 ${index} / ${cols*rows} 张曲绘成绩卡`})
  }
  if(cards.filter(c=>c.score!=null).length<Math.max(1,cards.length*.15))throw new Error('网格中没有足够的可用分数。请检查所选版式，或调整网格的上、下、左、右边界。')
  return {ok:true,family:'arcaea-jacket-grid',rows,cols,cards,ms:Date.now()-t}
}

import {nativeImage} from 'electron'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {recognizeFieldReadings} from '../vendor/ocr/main/onnx-ocr'
import {extractScore} from '../vendor/ocr/shared/ocr'
import {validateCandidate} from '../vendor/ocr/shared/ocr-validate'
import {chooseScoreReading,scoreBorderCandidate} from '../shared/ocr-score.mjs'

export async function enhancePlayer(file:string,result:any,progress:(data:unknown)=>void=()=>{}) {
  const image=nativeImage.createFromBuffer(readFileSync(file)),size=image.getSize()
  const table=JSON.parse(readFileSync(join(__dirname,'../data/songs.json'),'utf8'))
  for(let i=0;i<result.cards.length;i++){
    const card=result.cards[i],r=card.rect
    const x=Math.max(0,Math.floor(r.x-r.w*.05)),y=Math.max(0,Math.floor(r.y+r.h*.26)),w=Math.min(size.width-x,Math.round(r.w*1.04)),h=Math.min(size.height-y,Math.round(r.h*.3))
    if(w<=0||h<=0)continue
    const crop=image.crop({x,y,width:w,height:h}),s=crop.getSize()
    const reads=await recognizeFieldReadings(new Uint8Array(crop.toBitmap()),s.width,s.height)
    const parsed=reads.map(read=>{
      const direct=extractScore(read.text)?.value??null
      return {...read,value:direct??scoreBorderCandidate(read.text),repaired:direct==null}
    }).filter(read=>read.value!=null).sort((a,b)=>b.score-a.score)
    const selection=chooseScoreReading(parsed,card.candidate.score,{
      constant:card.validation.constant?.value??card.candidate.constant??null,
      detectedRating:card.validation.potential?.value??card.candidate.potential??null
    })
    if(selection.value!=null&&selection.value!==card.candidate.score){
      card.candidate={...card.candidate,score:selection.value,scoreRaw:parsed.find(read=>read.value===selection.value)?.text??''}
      card.validation=validateCandidate(table,card.candidate,'arcaea')
    }
    if(selection.warning){card.validation.reasons.push(selection.warning);card.validation.review=true}
    for(const read of reads)card.items.push({text:'SCORE BAND '+read.text,x:0,y:r.h*.3,w:r.w,h:r.h*.3,score:read.score})
    progress({ratio:(i+1)/result.cards.length,stage:`校验分数 ${i+1} / ${result.cards.length}`})
  }
  return result
}

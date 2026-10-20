import {rating} from './core.mjs';

// A card border can be read as a leading 1 before the displayed zero.
// Accept this repair only for the exact nine-digit shape and verify it with
// the independently printed Potential before using it.
export function scoreBorderCandidate(text){
  const digits=String(text).trim().replace(/['’‘′,，\s]/g,'');
  if(!/^10\d{7}$/.test(digits))return null;
  const value=Number(digits.slice(1));
  return value<=10100000?value:null;
}

export function chooseScoreReading(readings,current,{constant,detectedRating}){
  const candidates=readings.filter(r=>Number.isInteger(r.value)&&r.value>=0&&r.value<=10100000);
  const agrees=value=>Number.isFinite(constant)&&Number.isFinite(detectedRating)&&
    ['legacy','v7'].some(rule=>{
      const computed=rating({constant,score:value,clear:'NC'},rule);
      // Cards may truncate or round the printed four-decimal value.
      return Math.abs(computed-detectedRating)<0.000101;
    });
  const consistent=[...new Set(candidates.filter(r=>agrees(r.value)).map(r=>r.value))];
  if(consistent.length===1)return {value:consistent[0],warning:''};
  if(consistent.length>1)return {value:current,warning:'分数候选与图中 Potential 均相符，请对照原图选择'};
  if(Number.isFinite(constant)&&Number.isFinite(detectedRating)&&candidates.length){
    return {value:current,warning:'分数与图中 Potential 不一致，请核对分数、定数和通关状态'};
  }
  // Without a rating reference, retain the existing agreement requirement.
  const distinct=new Set(candidates.filter(r=>!r.repaired).map(r=>r.value));
  if(distinct.size===1&&(current==null||candidates.filter(r=>!r.repaired).length>1))return {value:[...distinct][0],warning:''};
  return {value:current,warning:distinct.size>1?'分数模型读数不一致，请对照原图':''};
}

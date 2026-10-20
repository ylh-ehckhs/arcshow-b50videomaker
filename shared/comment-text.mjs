const graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'});

// Pure text handling is also used by the OCR worker's CommonJS bundle. Keep
// renderer artwork URLs out of that dependency graph.
export function truncateComment(value){
  const text=String(value??'');if(text.length<=500)return text;
  let end=0;
  for(const {segment,index} of graphemes.segment(text)){
    if(index+segment.length>500)break;
    end=index+segment.length;
  }
  return text.slice(0,end);
}

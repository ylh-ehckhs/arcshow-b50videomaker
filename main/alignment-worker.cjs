const {isMainThread,parentPort,workerData}=require('node:worker_threads');
const HOP=80,FFT_SIZE=128,BANDS=[70,150,280,480,780,1200,1950];
function fft(re,im,inverse=false){
  const n=re.length;for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}
  for(let size=2;size<=n;size*=2){const angle=(inverse?2:-2)*Math.PI/size,wr=Math.cos(angle),wi=Math.sin(angle);for(let start=0;start<n;start+=size){let ur=1,ui=0;for(let j=0;j<size/2;j++){const a=start+j,b=a+size/2,tr=ur*re[b]-ui*im[b],ti=ur*im[b]+ui*re[b];re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;const nr=ur*wr-ui*wi;ui=ur*wi+ui*wr;ur=nr;}}}
  if(inverse)for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}
}
function features(samples,sampleRate){
  const count=Math.max(0,Math.floor((samples.length-FFT_SIZE)/HOP)+1),channels=Array.from({length:BANDS.length-1},()=>new Float32Array(count)),rms=new Float32Array(count);
  const re=new Float64Array(FFT_SIZE),im=new Float64Array(FFT_SIZE),hann=Float64Array.from({length:FFT_SIZE},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(FFT_SIZE-1)));
  for(let f=0;f<count;f++){
    let energy=0;for(let i=0;i<FFT_SIZE;i++){const x=samples[f*HOP+i];energy+=x*x;re[i]=x*hann[i];im[i]=0;}rms[f]=Math.sqrt(energy/FFT_SIZE);fft(re,im);
    for(let b=0;b<channels.length;b++){let power=0;const from=Math.max(1,Math.ceil(BANDS[b]*FFT_SIZE/sampleRate)),to=Math.min(FFT_SIZE/2,Math.ceil(BANDS[b+1]*FFT_SIZE/sampleRate));for(let i=from;i<to;i++)power+=re[i]*re[i]+im[i]*im[i];channels[b][f]=Math.log(power+1e-9);}
  }
  // Remove slowly varying gain/timbre, then standardize each frequency band.
  // Silence stays zero and cannot match another silent interval.
  for(const channel of channels){const prefix=new Float64Array(count+1);for(let i=0;i<count;i++)prefix[i+1]=prefix[i]+channel[i];let sum=0;for(let i=0;i<count;i++){const a=Math.max(0,i-25),b=Math.min(count,i+26);channel[i]=rms[i]<1e-5?0:channel[i]-(prefix[b]-prefix[a])/(b-a);sum+=channel[i]*channel[i];}const scale=Math.max(.25,Math.sqrt(sum/Math.max(1,count)));for(let i=0;i<count;i++)channel[i]/=scale;}
  return {channels,rms,count};
}
function median(values){const a=[...values].sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:0;}
function peaks(scores,minGap,max=5){
  const found=[];for(let i=1;i<scores.length-1;i++)if(scores[i]>.5&&scores[i]>=scores[i-1]&&scores[i]>=scores[i+1]){const p={position:i,score:Math.min(1,scores[i])};if(found.some(x=>Math.abs(x.position-i)<minGap&&x.score>=p.score))continue;for(let j=found.length-1;j>=0;j--)if(Math.abs(found[j].position-i)<minGap)found.splice(j,1);found.push(p);found.sort((a,b)=>b.score-a.score);if(found.length>max)found.length=max;}
  // Include exact file boundaries, which are valid alignment positions.
  for(const i of [0,scores.length-1])if(scores[i]>.5&&!found.some(x=>Math.abs(x.position-i)<minGap))found.push({position:i,score:Math.min(1,scores[i])});return found.sort((a,b)=>b.score-a.score).slice(0,max);
}
function refine(master,video,rough,videoTime,sampleRate){
  const half=Math.floor(.65*sampleRate),center=Math.round(videoTime*sampleRate),radius=Math.ceil(.045*sampleRate),base=Math.round(rough*sampleRate);
  let best=-1,bestLag=base;
  for(let lag=base-radius;lag<=base+radius;lag++){
    let xy=0,xx=0,yy=0;const begin=Math.max(center-half,lag,0),end=Math.min(center+half,video.length,master.length+lag);
    if(end-begin<sampleRate*.4)continue;
    for(let i=begin;i<end;i+=2){const x=video[i],y=master[i-lag];xy+=x*y;xx+=x*x;yy+=y*y;}
    const score=xy/Math.sqrt(xx*yy+1e-30);if(score>best){best=score;bestLag=lag;}
  }
  return {offset:best>.24?bestLag/sampleRate:rough,waveScore:best,refined:best>.24};
}
function alignSamples(master,video,sampleRate=4000,progress=()=>{}){
  const duration=Math.min(master.length,video.length)/sampleRate;
  const unmatched=reason=>({status:'unmatched',offset:null,candidates:[],reason,method:'multi-window-spectral-correlation',sampleRate});
  if(duration<6)return unmatched('音轨太短，至少需要 6 秒且包含可辨识音乐的重叠片段');
  progress({stage:'提取共同音源特征'});const m=features(master,sampleRate);progress({stage:'提取录像音轨特征'});const v=features(video,sampleRate);
  const windowFrames=Math.min(Math.round(8*sampleRate/HOP),Math.floor(Math.min(m.count,v.count)*.3));
  if(windowFrames<60)return unmatched('可比较的音频范围太短');
  const starts=[...new Set(Array.from({length:9},(_,i)=>Math.round((v.count-windowFrames)*i/8)))];
  const windows=starts.map((start,index)=>{let norm=0,audible=0;for(let i=0;i<windowFrames;i++){if(v.rms[start+i]>1e-4)audible++;for(const c of v.channels)norm+=c[start+i]*c[start+i];}return{index,start,norm,audible:audible/windowFrames,sums:new Float64Array(m.count-windowFrames+1)};}).filter(x=>x.audible>.6&&x.norm>windowFrames*.15);
  if(windows.length<3)return unmatched('有效音乐窗口不足，音轨可能静音或变化太少');
  let n=1;while(n<m.count+windowFrames-1)n*=2;
  const normPrefix=new Float64Array(m.count+1);for(let i=0;i<m.count;i++){let e=0;for(const c of m.channels)e+=c[i]*c[i];normPrefix[i+1]=normPrefix[i]+e;}
  for(let b=0;b<m.channels.length;b++){
    progress({stage:'比较音轨特征',completed:b,total:m.channels.length});const mr=new Float64Array(n),mi=new Float64Array(n);mr.set(m.channels[b]);fft(mr,mi);
    for(const w of windows){const qr=new Float64Array(n),qi=new Float64Array(n);for(let i=0;i<windowFrames;i++)qr[i]=v.channels[b][w.start+windowFrames-1-i];fft(qr,qi);for(let i=0;i<n;i++){const real=qr[i]*mr[i]-qi[i]*mi[i];qi[i]=qr[i]*mi[i]+qi[i]*mr[i];qr[i]=real;}fft(qr,qi,true);for(let i=0;i<w.sums.length;i++)w.sums[i]+=qr[i+windowFrames-1];}
  }
  const clusters=[];let reliableWindows=0;
  for(const w of windows){for(let i=0;i<w.sums.length;i++)w.sums[i]/=Math.sqrt(w.norm*(normPrefix[i+windowFrames]-normPrefix[i])+1e-30);const p=peaks(w.sums,Math.round(.8*sampleRate/HOP));if(p[0]?.score>=.6)reliableWindows++;
    for(const point of p){if(point.score<.6)continue;const offset=(w.start-point.position)*HOP/sampleRate;let cluster=clusters.find(c=>Math.abs(c.offset-offset)<.085);if(!cluster){cluster={offset,matches:[]};clusters.push(cluster);}const match={window:w.index,sourceTime:point.position*HOP/sampleRate,targetTime:w.start*HOP/sampleRate,score:point.score,offset};const previous=cluster.matches.findIndex(x=>x.window===w.index);if(previous<0)cluster.matches.push(match);else if(match.score>cluster.matches[previous].score)cluster.matches[previous]=match;cluster.offset=median(cluster.matches.map(x=>x.offset));}
  }
  const minSpan=Math.min(12,video.length/sampleRate*.35),minSupport=Math.max(3,Math.ceil(windows.length*.6));
  let candidates=clusters.map(c=>{const times=c.matches.map(x=>x.targetTime);return{...c,span:Math.max(...times)-Math.min(...times),score:c.matches.reduce((s,x)=>s+x.score,0)/c.matches.length};}).filter(c=>c.matches.length>=minSupport&&c.span>=minSpan&&c.score>=.64).sort((a,b)=>b.matches.length-a.matches.length||b.score-a.score);
  // Refine only plausible consistent groups, using original samples. A changing
  // lag across distant windows is drift, not a valid fixed-offset match.
  for(const c of candidates.slice(0,5)){for(const x of c.matches){const refined=refine(master,video,x.offset,x.targetTime+windowFrames*HOP/sampleRate/2,sampleRate);x.offset=refined.offset;x.waveScore=refined.waveScore;x.refined=refined.refined;}c.offset=median(c.matches.map(x=>x.offset));const refined=c.matches.filter(x=>x.refined);c.spread=refined.length>=3?Math.max(...refined.map(x=>x.offset))-Math.min(...refined.map(x=>x.offset)):Math.max(...c.matches.map(x=>x.offset))-Math.min(...c.matches.map(x=>x.offset));}
  candidates=candidates.slice(0,5).map(c=>({offset:c.offset,score:c.score,matchedWindows:c.matches.length,span:c.span,spread:c.spread,matchedAt:c.matches.map(({sourceTime,targetTime,score,offset,waveScore})=>({sourceTime:targetTime-offset,targetTime,score,offset,waveScore}))}));
  const best=candidates[0];if(!best)return{...unmatched('多个时间窗口未能确认一致偏移，请人工校准；也可能存在变速、剪接或不同版本音源'),analyzedWindows:windows.length,reliableWindows};
  if(best.spread>.03)return{status:'unmatched',offset:null,candidates,reason:'不同位置的偏移不一致，可能存在变速、音频漂移或剪接，请人工校准',method:'multi-window-spectral-correlation',sampleRate,analyzedWindows:windows.length,reliableWindows};
  const alternative=candidates.find((c,i)=>i&&Math.abs(c.offset-best.offset)>.12&&c.matchedWindows>=best.matchedWindows-1&&c.score>=best.score-.08);
  if(alternative)return{status:'ambiguous',offset:null,candidates,reason:'找到多个同样合理的对应位置，可能是重复乐段；请试听候选后选择',method:'multi-window-spectral-correlation',sampleRate,analyzedWindows:windows.length,reliableWindows};
  return{status:'matched',offset:best.offset,candidates,reason:'多个时间窗口支持一致偏移，请试听并确认采用',method:'multi-window-spectral-correlation',sampleRate,analyzedWindows:windows.length,reliableWindows};
}
function waveform(samples,sampleRate,{points,start,end}){
  const from=Math.floor(start*sampleRate),to=Math.min(samples.length,Math.ceil(end*sampleRate)),peaks=[],ranges=[];
  for(let p=0;p<points;p++){const a=from+Math.floor((to-from)*p/points),b=from+Math.floor((to-from)*(p+1)/points);let low=0,high=0;for(let i=a;i<b;i++){low=Math.min(low,samples[i]);high=Math.max(high,samples[i]);}peaks.push(Math.max(-low,high));ranges.push([low,high]);}
  return{duration:samples.length/sampleRate,sampleRate,points,start,end,peaks,ranges};
}
if(!isMainThread){try{const d=workerData,result=d.task==='waveform'?waveform(d.samples,d.sampleRate,d):alignSamples(d.master,d.video,d.sampleRate,progress=>parentPort.postMessage({progress}));parentPort.postMessage({result});}catch(error){parentPort.postMessage({error:error.message||String(error)});}}
module.exports={alignSamples,waveform};

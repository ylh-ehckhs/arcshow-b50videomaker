// A short, decoded preview track. Its public clock uses the original file's
// seconds so timeline positions stay identical to the export/source ranges.
export function createPreviewBufferAudio(context,buffer,{sourceStart=0}={}){
  return new PreviewBufferAudio(context,buffer,sourceStart);
}

class PreviewBufferAudio extends EventTarget{
  constructor(context,buffer,sourceStart){
    super();this.context=context;this.buffer=buffer;this.sourceStart=Math.max(0,Number(sourceStart)||0);
    this.offset=0;this.when=0;this.node=null;this.token=0;this.paused=true;this.loop=false;this.seeking=false;
    this.readyState=4;this.error=null;this.src='';this.released=false;this.isPreviewBuffer=true;this.finished=false;
    this.gain=context.createGain();this.gain.gain.value=1;this.destination=null;
  }
  get duration(){return this.sourceStart+(this.buffer?.duration||0);}
  get ended(){return this.finished||!this.loop&&!this.paused&&this.currentTime>=this.duration-1e-7;}
  get currentTime(){
    const progress=this.paused?0:Math.max(0,this.context.currentTime-this.when);
    let offset=this.offset+progress;
    if(this.loop&&this.buffer?.duration)offset%=this.buffer.duration;
    return this.sourceStart+Math.max(0,Math.min(this.buffer?.duration||0,offset));
  }
  set currentTime(value){
    const offset=Math.max(0,Math.min(this.buffer?.duration||0,(Number(value)||0)-this.sourceStart));
    const playing=!this.paused;this.stopNode();this.offset=offset;this.finished=false;
    if(playing)this.playAt(this.context.currentTime);
    this.dispatchEvent(new Event('seeked'));
  }
  get volume(){return this.gain.gain.value;}
  set volume(value){this.gain.gain.value=Math.max(0,Number(value)||0);}
  connectAudio(destination){
    if(this.destination!==destination){this.gain.disconnect();this.gain.connect(destination);this.destination=destination;}
    return this.gain;
  }
  stopNode(){
    this.token++;if(this.node){this.node.onended=null;try{this.node.stop();}catch{}this.node.disconnect();this.node=null;}
    this.paused=true;
  }
  pause(){
    const offset=this.currentTime-this.sourceStart;const wasPlaying=!this.paused;
    this.stopNode();this.offset=offset;if(wasPlaying)this.dispatchEvent(new Event('pause'));
  }
  playAt(when){
    if(this.released||!this.buffer)throw new Error('预览音轨已释放');
    if(!this.paused)return;
    const node=this.context.createBufferSource();node.buffer=this.buffer;node.loop=!!this.loop;node.connect(this.gain);
    this.when=Math.max(this.context.currentTime,Number(when)||0);this.node=node;this.paused=false;this.finished=false;
    const token=++this.token;
    node.onended=()=>{
      if(token!==this.token||this.node!==node)return;
      this.offset=this.buffer?.duration||0;this.paused=true;this.finished=true;this.node=null;node.disconnect();this.dispatchEvent(new Event('ended'));
    };
    try{node.start(this.when,this.offset);}
    catch(error){this.stopNode();throw error;}
    this.dispatchEvent(new Event('play'));this.dispatchEvent(new Event('playing'));
  }
  play(){this.playAt(this.context.currentTime);return Promise.resolve();}
  load(){}
  removeAttribute(name){if(name==='src')this.src='';}
  dispose(){this.pause();this.released=true;this.buffer=null;this.gain.disconnect();this.destination=null;}
}

// Streaming windowed-sinc low-pass resampling. Fractional position survives block boundaries.
export class Pcm16Resampler {
 private readonly half=16; private data:number[]=Array(16).fill(0); private position=16;
 private inputCount=0; private outputCount=0; private finished=false;
 constructor(readonly sourceRate:number,readonly targetRate=16000){
  if(!Number.isFinite(sourceRate)||sourceRate<targetRate||sourceRate>192000)throw new Error('Unsupported sample rate');
 }
 push(input:Float32Array){if(this.finished)throw new Error('Resampler finished');this.inputCount+=input.length;for(const sample of input)this.data.push(Number.isFinite(sample)?sample:0);return this.drain(false);}
 flush(){if(this.finished)return new Uint8Array();this.finished=true;for(let i=0;i<this.half+2;i++)this.data.push(0);return this.drain(true);}
 private drain(final:boolean){
  const ratio=this.sourceRate/this.targetRate,limit=Math.floor(this.inputCount/ratio),output:number[]=[],cutoff=.45/ratio;
  while(this.outputCount<limit&&(final||this.position+this.half<this.data.length)){
   const center=Math.floor(this.position);let value=0,weightSum=0;
   for(let k=-this.half+1;k<=this.half;k++){
    const distance=center+k-this.position,x=2*cutoff*distance;
    const weight=(Math.abs(x)<1e-9?1:Math.sin(Math.PI*x)/(Math.PI*x))*(.5+.5*Math.cos(Math.PI*distance/this.half));
    value+=(this.data[center+k]??0)*weight;weightSum+=weight;
   }
   const sample=Math.max(-1,Math.min(1,value/weightSum));output.push(Math.round(sample*(sample<0?32768:32767)));
   this.position+=ratio;this.outputCount++;
  }
  const discard=Math.max(0,Math.floor(this.position)-this.half);this.data.splice(0,discard);this.position-=discard;
  const bytes=new Uint8Array(output.length*2),view=new DataView(bytes.buffer);output.forEach((sample,i)=>view.setInt16(i*2,sample,true));return bytes;
 }
}
export function decodePcm16(bytes:Uint8Array){
 if(bytes.byteLength%2)throw new Error('Invalid PCM byte count');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),result=new Float32Array(bytes.length/2);
 for(let i=0;i<result.length;i++)result[i]=view.getInt16(i*2,true)/32768;return result;
}

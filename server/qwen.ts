import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import type {QwenConfig} from './config';
import {SpeechError,type AsrSession,type SpeechProvider,type WireFactory,type WireSocket} from './speech';
import {MIN_RECORDING_BYTES,MAX_RECORDING_BYTES} from '../shared/speech-protocol';
import {abortError} from '../shared/async';
import {normalizeTranscript,TranscriptError} from '../shared/transcript';
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return{promise,resolve,reject};}
const nativeWire:WireFactory=(url,headers)=>{
 const ws=new WebSocket(url,{headers,handshakeTimeout:8000,maxPayload:2_000_000});
 return{send:data=>ws.send(data),close:()=>{if(ws.readyState===WebSocket.CONNECTING)ws.terminate();else ws.close();},on:(event,listener)=>{ws.on(event,listener);}};
};
type Event={type?:string;delta?:string;transcript?:unknown};
class QwenOperation{
 readonly ready=deferred<void>();readonly done=deferred<void>();
 private closed=false;private opened=false;private updated=false;private socket:WireSocket;
 private timer:ReturnType<typeof setTimeout>;private abort:()=>void;
 constructor(config:QwenConfig,mode:'asr'|'tts',signal:AbortSignal,factory:WireFactory,private onEvent:(event:Event)=>void){
  const url=new URL(mode==='asr'?config.asrEndpoint:config.ttsEndpoint);url.searchParams.set('model',mode==='asr'?config.asrModel:config.ttsModel);
  const headers:Record<string,string>={Authorization:'Bearer '+config.apiKey};if(config.workspaceId)headers['X-DashScope-WorkSpace']=config.workspaceId;
  this.socket=factory(url.toString(),headers);this.abort=()=>this.fail(abortError());signal.addEventListener('abort',this.abort,{once:true});
  const clear=()=>signal.removeEventListener('abort',this.abort);void this.done.promise.then(clear,clear);
  this.timer=setTimeout(()=>this.fail(new SpeechError('TIMEOUT','语音服务等待超时，请重试。')),mode==='asr'?45000:30000);
  const handshake=setTimeout(()=>this.fail(new SpeechError('TIMEOUT','语音连接超时，请重试。')),8000);
  void this.ready.promise.then(()=>clearTimeout(handshake),()=>clearTimeout(handshake));
  this.socket.on('open',()=>{if(this.closed)return;this.opened=true;try{this.send('session.update',{session:mode==='asr'
   ?{input_audio_format:'pcm',sample_rate:16000,input_audio_transcription:{language:'zh'},turn_detection:null}
   :{mode:'commit',voice:config.voice,language_type:'Chinese',response_format:'pcm',sample_rate:24000}});}catch{this.fail(new SpeechError('DISCONNECTED','语音初始化失败，请重试。'));}});
  this.socket.on('message',raw=>{if(this.closed)return;try{
   const event=JSON.parse(String(raw)) as Event;
   if(event.type==='error'||event.type==='conversation.item.input_audio_transcription.failed'){this.fail(new SpeechError('UPSTREAM_ERROR','语音服务返回错误，请检查本机配置后重试。'));return;}
   if(event.type==='session.updated'){this.updated=true;this.ready.resolve();}
   if(event.type==='session.finished'){this.succeed();return;}this.onEvent(event);
  }catch{this.fail(new SpeechError('BAD_RESPONSE','语音服务响应格式异常，请重试。'));}});
  this.socket.on('error',()=>this.fail(new SpeechError('DISCONNECTED','语音服务连接失败，请重试。')));
  this.socket.on('close',()=>{if(!this.closed)this.fail(new SpeechError('DISCONNECTED','语音连接中断，请重新录制或重试。'));});
  if(signal.aborted)this.abort();
 }
 send(type:string,fields:Record<string,unknown>={}){if(this.closed||!this.opened)throw new SpeechError('CANCELLED','语音会话已结束。');try{this.socket.send(JSON.stringify({event_id:randomUUID(),type,...fields}));}catch{const error=new SpeechError('DISCONNECTED','语音发送失败，请重试。');this.fail(error);throw error;}}
 ensureReady(){if(!this.updated||this.closed)throw new SpeechError('NOT_READY','语音服务尚未就绪，请重试。');}
 fail(error:Error){if(this.closed)return;this.closed=true;clearTimeout(this.timer);this.ready.reject(error);this.done.reject(error);try{this.socket.close();}catch{/* Already disconnected. */}}
 private succeed(){if(this.closed)return;this.closed=true;clearTimeout(this.timer);this.ready.resolve();this.done.resolve();try{this.socket.close();}catch{/* Already disconnected. */}}
}
export class QwenSpeechProvider implements SpeechProvider{
 constructor(private config:QwenConfig,private factory:WireFactory=nativeWire){}
 openAsr(signal:AbortSignal):AsrSession{
  if(signal.aborted)throw abortError();
  let bytes=0,committed=false;let transcript:unknown='';
  const operation=new QwenOperation(this.config,'asr',signal,this.factory,event=>{if(event.type==='conversation.item.input_audio_transcription.completed')transcript=event.transcript;});
  return{ready:operation.ready.promise,append:pcm=>{
   operation.ensureReady();if(committed||pcm.length%2||!pcm.length||pcm.length>32000)throw new SpeechError('BAD_AUDIO','录音数据格式异常。');
   bytes+=pcm.length;if(bytes>MAX_RECORDING_BYTES)throw new SpeechError('TOO_LONG','一次录音最多 30 秒，请分段说。');
   operation.send('input_audio_buffer.append',{audio:Buffer.from(pcm).toString('base64')});
  },commit:async()=>{
   operation.ensureReady();if(committed)throw new SpeechError('ALREADY_COMMITTED','这段录音已提交。');
   if(bytes<MIN_RECORDING_BYTES){const e=new SpeechError('TOO_SHORT','录音太短，请按住再说一句。');operation.fail(e);throw e;}
   committed=true;operation.send('input_audio_buffer.commit');operation.send('session.finish');await operation.done.promise;
   try{return normalizeTranscript(transcript);}catch(error){if(error instanceof TranscriptError)throw new SpeechError(error.code,error.message);throw error;}
  },cancel:()=>operation.fail(abortError())};
 }
 async synthesize(text:string,signal:AbortSignal,audio:(pcm:Uint8Array)=>void){
  if(signal.aborted)throw abortError();
  if(!text.trim()||text.length>180)throw new SpeechError('BAD_TEXT','语音文本格式异常。');
  let received=0,responseDone=false;
  const operation=new QwenOperation(this.config,'tts',signal,this.factory,event=>{
   if(event.type==='response.audio.delta'&&!responseDone){
    if(typeof event.delta!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(event.delta))throw new Error('Bad base64');
    const pcm=Buffer.from(event.delta,'base64');if(pcm.length%2)throw new Error('Odd PCM bytes');received+=pcm.length;
    if(received>2_880_000)throw new Error('Audio exceeds one minute');if(pcm.length&&!signal.aborted)audio(pcm);
   }
   if(event.type==='response.done'){responseDone=true;operation.send('session.finish');}
  });
  await operation.ready.promise;operation.send('input_text_buffer.append',{text});operation.send('input_text_buffer.commit');
  await operation.done.promise;if(!received||!responseDone)throw new SpeechError('EMPTY_AUDIO','没有收到可播放的语音，已保留文字。');
 }
}

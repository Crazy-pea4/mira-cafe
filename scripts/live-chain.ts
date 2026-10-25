// Explicit one-off check of the actual localhost service. No microphone or audio player.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { Pcm16Resampler, decodePcm16 } from '../shared/pcm';
import { speechServerSchema } from '../shared/speech-protocol';
import { turnResponseSchema } from '../shared/protocol';
const origin='http://127.0.0.1:3001';
const path=resolve('.local/multiturn-2026-10-25-chain.json');
async function main(){
 if(process.argv[2]!=='--authorized-chain'){console.log('No request sent: explicit authorized flag required.');return;}
 if(existsSync(path)){console.log('REPLAY_BLOCKED: no request sent.');return;}
 const before=await (await fetch(origin+'/api/health')).json();
 if(before.provider!=='deepseek'||before.speech!=='qwen'||!before.budget.enabled||before.budget.totalRequests+4>before.budget.maxRequests||before.budget.reservedCny+.30>8)throw Error('BUDGET_OR_CONFIGURATION');
 const record:any={startedAt:new Date().toISOString(),limit:4,automaticRetries:0,playedAudio:false,recordedMicrophone:false,budgetBefore:before.budget,requests:[],cloudBillVerified:false};
 mkdirSync(resolve('.local'),{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify(record),{flag:'wx',mode:0o600});
 const save=()=>writeFileSync(path,JSON.stringify(record,null,2),{mode:0o600});
 async function speech(type:'tts'|'asr',text:string,pcm?:Buffer):Promise<{audio:Buffer;text:string}>{
  const row:any={service:type,status:'pending'};record.requests.push(row);save();
  return new Promise((resolve,reject)=>{
   const socket=new WebSocket('ws://127.0.0.1:3001/api/speech',{origin,handshakeTimeout:8000,maxPayload:100000,followRedirects:false});
   const identity={requestId:crypto.randomUUID(),turnId:record.requests.length};const chunks:Buffer[]=[];let bytes=0,transcript='',done=false;
   const finish=(code?:string)=>{if(done)return;done=true;clearTimeout(timer);row.status=code?'failed_no_retry':'success';if(code)row.code=code;
    row.pcmBytes=bytes;row.durationSeconds=type==='tts'?bytes/48000:(pcm?.length??0)/32000;row.transcriptLength=transcript.length;
    if(type==='tts')row.estimatedCny=[...text].reduce((n,c)=>n+(/\p{Script=Han}/u.test(c)?2:1),0)/10000;
    else row.estimatedCny=Math.ceil((pcm?.length??0)/32000)*.00033;
    save();console.log(JSON.stringify(row));if(socket.readyState===WebSocket.CONNECTING)socket.terminate();else socket.close();code?reject(Error(code)):resolve({audio:Buffer.concat(chunks),text:transcript});};
   const timer=setTimeout(()=>finish('TIMEOUT'),25000);const send=(event:object)=>socket.send(JSON.stringify({...event,...identity}));
   socket.on('open',()=>send(type==='tts'?{type:'tts.start',text}:{type:'asr.start'}));
   socket.on('message',raw=>{
    if(done)return;let parsed;try{parsed=speechServerSchema.safeParse(JSON.parse(String(raw)));}catch{return finish('BAD_EVENT');}
    if(!parsed.success)return finish('BAD_EVENT');const e=parsed.data;
    if(e.requestId!==identity.requestId||e.turnId!==identity.turnId)return finish('WRONG_IDENTITY');
    if(e.type==='ready'&&type==='asr'){
     if(!pcm||pcm.length<8000||pcm.length>480000)return finish('BAD_AUDIO');
     for(let i=0;i<pcm.length;i+=3200)send({type:'asr.audio',audio:pcm.subarray(i,i+3200).toString('base64'),sampleRate:16000});send({type:'asr.commit'});
    }
    if(e.type==='audio'){const block=Buffer.from(e.audio,'base64');bytes+=block.length;if(bytes>30*48000)return finish('AUDIO_LIMIT');chunks.push(block);}
    if(e.type==='transcript')transcript=e.text;
    if(e.type==='error')return finish(/^[A-Z_]+$/.test(e.code)?e.code:'SPEECH_ERROR');
    if(e.type==='done')finish(type==='tts'&&bytes===0?'EMPTY_AUDIO':type==='asr'&&!transcript?'EMPTY_TRANSCRIPT':undefined);
   });
   socket.on('error',()=>finish('SOCKET_ERROR'));socket.on('close',()=>{if(!done)finish('EARLY_CLOSE');});
  });
 }
 try{
  const line='聊聊你的旅行吧。';const synthetic=await speech('tts',line);if(synthetic.audio.length>15*48000)throw Error('INPUT_AUDIO_LIMIT');
  const r=new Pcm16Resampler(24000,16000);const chunks:Uint8Array[]=[];
  for(let i=0;i<synthetic.audio.length;i+=4800)chunks.push(r.push(decodePcm16(synthetic.audio.subarray(i,i+4800))));chunks.push(r.flush());
  const transcript=await speech('asr','',Buffer.concat(chunks));
  record.transcriptMatches=transcript.text.replace(/[^\p{L}\p{N}]/gu,'')===line.replace(/[^\p{L}\p{N}]/gu,'');save();
  if(!record.transcriptMatches)throw Error('TRANSCRIPT_MISMATCH');
  const row:any={service:'deepseek',status:'pending'};record.requests.push(row);save();
  const result=await fetch(origin+'/api/turn',{method:'POST',headers:{origin,'Content-Type':'application/json'},signal:AbortSignal.timeout(21000),body:JSON.stringify({sessionId:crypto.randomUUID(),turnId:1,text:transcript.text,history:[],fault:'none'})});
  row.httpStatus=result.status;
  const parsed=turnResponseSchema.safeParse(await result.json());if(!result.ok||!parsed.success){row.status='failed_no_retry';save();throw Error('DIALOGUE_FAILED');}
  row.status='success';row.segmentCount=parsed.data.segments.length;row.dialogueLength=parsed.data.segments.reduce((n,s)=>n+s.text.length,0);row.degraded=!!parsed.data.notice;save();console.log(JSON.stringify(row));
  const text=parsed.data.segments[0].text;if(text.length>90)throw Error('TTS_TEXT_LIMIT');await speech('tts',text);
  record.status='success';
 }catch{record.status='stopped_no_retry';}
 finally{record.finishedAt=new Date().toISOString();record.budgetAfter=(await(await fetch(origin+'/api/health')).json()).budget;save();console.log(JSON.stringify({status:record.status,requests:record.requests.length,transcriptMatches:record.transcriptMatches,budget:record.budgetAfter,automaticPaidValidationStopped:true}));}
}
main().catch(()=>{console.log('STOPPED: inspect sanitized chain record; no automatic retry.');process.exitCode=1;});

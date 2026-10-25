import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import WebSocket from 'ws';
import { resolveConfig } from '../server/config';
import { BudgetGuard, FileBudgetStore } from './legacy-test-budget';
import { QwenSpeechProvider } from '../server/qwen';
import { SpeechError, type WireFactory } from '../server/speech';
import { Pcm16Resampler, decodePcm16 } from '../shared/pcm';
import { replySchema } from '../shared/protocol';

const marker = resolve('.local/authorized-smoke-2026-10-25.json');
const line = '你好，欢迎来到咖啡馆。';
type Result = { service: string; status: string; [key: string]: unknown };
const record: { limit: number; automaticRetries: number; startedAt?: string; finishedAt?: string; requests: Result[]; [key: string]: unknown } = { limit: 3, automaticRetries: 0, requests: [] };
const save = () => writeFileSync(marker, JSON.stringify(record, null, 2), { mode: 0o600 });
const print = (value: object) => console.log(JSON.stringify(value));
const numericUsage = (value: unknown): Record<string, number> => {
  const output: Record<string, number> = {};
  if (!value || typeof value !== 'object') return output;
  for (const key of ['prompt_tokens','completion_tokens','total_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens','input_tokens','output_tokens','characters','input_characters','audio_duration']) {
    const number = (value as Record<string, unknown>)[key];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0) output[key] = number;
  }
  return output;
};
function failure(error: unknown, timedOut: boolean): string {
  if (timedOut) return 'TIMEOUT';
  if (error instanceof SpeechError && /^[A-Z_]+$/.test(error.code)) return error.code;
  if (error instanceof Error && ['INPUT_LIMIT','HTTP_FAILURE','INVALID_REPLY','AUDIO_TOO_LONG','BAD_AUDIO','CONFIGURATION','BUDGET_BLOCKED','REPLAY_BLOCKED'].includes(error.message)) return error.message;
  return 'FAILED_NO_RETRY';
}
async function main() {
  const mode = process.argv[2];
  if (!['--preflight','--run-authorized-three-requests'].includes(mode)) { print({ status: 'No request sent. Explicit bounded-run argument required.' }); return; }
  if (existsSync(marker)) { print({ status: 'REPLAY_BLOCKED', message: 'An existing run record prevents any automatic replay. Inspect the sanitized record; do not rerun.' }); return; }
  // Read only this project's .env in process memory. Never export its values or interpret NODE_OPTIONS.
  const env = parseEnv(readFileSync(resolve('.env'), 'utf8'));
  const config = resolveConfig({ ...env, MIRA_ENABLE_LIVE_APIS: 'true', MIRA_PROVIDER: 'deepseek', MIRA_SPEECH_PROVIDER: 'qwen' });
  if (!config.deepseek || !config.qwen || config.deepseek.model !== 'deepseek-flash' || config.qwen.region !== 'cn-beijing' || config.qwen.asrModel !== 'qwen3-asr-flash-realtime' || config.qwen.ttsModel !== 'qwen3-tts-flash-realtime') {
    print({ status:'CONFIGURATION', message:'Required keys, Beijing official endpoints or approved model names are incomplete. No request sent.' }); return;
  }
  const budget = new BudgetGuard(new FileBudgetStore(resolve('.local/budget.json')), { confirmed: true, modelSupported: true, maxRequests: Number(env.MIRA_MAX_LIVE_REQUESTS ?? 60) });
  const before = budget.status();
  if (!before.enabled || before.totalRequests + 3 > before.maxRequests || before.reservedCny + 0.26 > 8) { print({ status: 'BUDGET_BLOCKED', budget: before }); return; }
  const messages = [
    { role:'system', content:'You are Mira in a cafe. Reply with ONE brief Chinese sentence under 20 Chinese characters. Output JSON only: {"segments":[{"text":"...","emotion":"curious","action":"idle"}]}.' },
    { role:'user', content:'你好。' },
  ];
  // The entire UTF-8 message JSON is under 500 bytes, leaving ample framing margin under 1000 input tokens.
  if (Buffer.byteLength(JSON.stringify(messages),'utf8') > 500 || [...line].length > 30) throw new Error('INPUT_LIMIT');
  const billedCharacters = [...line].reduce((n,c) => n + (/\p{Script=Han}/u.test(c) ? 2 : 1), 0);
  if (mode === '--preflight') { print({ status:'READY_NO_REQUEST_SENT', models:['deepseek-flash','qwen3-tts-flash-realtime','qwen3-asr-flash-realtime'], region:'cn-beijing', voice:'Chelsie', maxRequests:3, inputJsonUtf8Bytes:Buffer.byteLength(JSON.stringify(messages)), maxOutputTokens:128, ttsText:line, ttsBilledCharacters:billedCharacters, maxAsrSeconds:15, nominalCostCeilingCny:0.003024+billedCharacters/10000+15*.00033, budget:before }); return; }
  mkdirSync(resolve('.local'), { recursive:true, mode:0o700 });
  record.startedAt = new Date().toISOString(); record.budgetBefore = before;
  writeFileSync(marker, JSON.stringify(record), { flag:'wx', mode:0o600 });
  const run = async (service:'deepseek'|'tts'|'asr', task:(signal:AbortSignal, row:Result)=>Promise<void>) => {
    if (record.requests.length >= 3) throw new Error('INPUT_LIMIT');
    const row:Result={service,status:'reserved_no_network_yet'};record.requests.push(row);
    const controller=new AbortController();let timedOut=false;let release=()=>{};let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      release=budget.reserve(service,controller.signal);save();
      row.status='attempted_outcome_pending';save();
      timer=setTimeout(()=>{timedOut=true;controller.abort();},25000);
      await task(controller.signal,row);
      row.status='success';return true;
    } catch(error) { row.status='failed_no_retry';row.code=failure(error,timedOut);return false; }
    finally { clearTimeout(timer);controller.abort();release();save();print(row); }
  };
  const deepOk=await run('deepseek',async(signal,row)=>{
    const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.deepseek!.apiKey},body:JSON.stringify({model:'deepseek-flash',messages,thinking:{type:'disabled'},max_tokens:128,response_format:{type:'json_object'},stream:false})});
    row.httpStatus=response.status;if(!response.ok)throw new Error('HTTP_FAILURE');
    const data=await response.json() as {choices?:{message?:{content?:string};finish_reason?:string}[];usage?:unknown};
    row.usage=numericUsage(data.usage);row.finishReason=data.choices?.[0]?.finish_reason==='stop'?'stop':'other';
    const reply=replySchema.safeParse(JSON.parse(data.choices?.[0]?.message?.content??''));
    if(!reply.success)throw new Error('INVALID_REPLY');
    row.text=reply.data.segments.map(segment=>segment.text).join('').slice(0,180);
    const usage=row.usage as Record<string,number>;
    row.estimatedCny=typeof usage.prompt_tokens==='number'&&typeof usage.completion_tokens==='number' ? usage.prompt_tokens*2/1e6+usage.completion_tokens*8/1e6 : null;
    row.estimateBasis='Peak cache-miss rate, no account discounts; not a verified bill.';
  });
  if(!deepOk){record.stoppedReason='DeepSeek failed; no more requests.';return finish();}
  let pcm24=Buffer.alloc(0);
  const makeWire=(usage:Record<string,number>):WireFactory=>(url,headers)=>{
    const parsed=new URL(url);
    if(parsed.protocol!=='wss:'||!(parsed.hostname==='dashscope.aliyuncs.com'||/^[a-zA-Z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(parsed.hostname)))throw new Error('CONFIGURATION');
    const socket=new WebSocket(url,{headers,handshakeTimeout:8000,maxPayload:2_000_000,followRedirects:false});
    return {send:data=>socket.send(data),close:()=>{if(socket.readyState===WebSocket.CONNECTING)socket.terminate();else socket.close();},on:(event,listener)=>{
      if(event==='message')socket.on('message',raw=>{try{const value=JSON.parse(String(raw));Object.assign(usage,numericUsage(value.usage),numericUsage(value.response?.usage));}catch{}listener(raw);});
      else socket.on(event,listener);
    }};
  };
  const ttsOk=await run('tts',async(signal,row)=>{
    const usage:Record<string,number>={};const chunks:Buffer[]=[];let bytes=0;
    const speech=new QwenSpeechProvider({...config.qwen!,voice:'Chelsie'},makeWire(usage));
    await speech.synthesize(line,signal,pcm=>{bytes+=pcm.length;if(bytes>15*24000*2)throw new Error('AUDIO_TOO_LONG');chunks.push(Buffer.from(pcm));});
    pcm24=Buffer.concat(chunks);if(!pcm24.length||pcm24.length%2)throw new Error('BAD_AUDIO');
    const folder=mkdtempSync(join(tmpdir(),'mira-smoke-'));const file=join(folder,'chelsie-24000-mono-s16le.pcm');writeFileSync(file,pcm24,{mode:0o600,flag:'wx'});
    Object.assign(row,{text:line,voice:'Chelsie',sampleRate:24000,pcmBytes:pcm24.length,durationSeconds:pcm24.length/48000,usage,temporaryPcm:file,billedCharacters,estimatedCny:billedCharacters/10000,played:false});
  });
  if(!ttsOk){record.stoppedReason='TTS failed; ASR not attempted.';return finish();}
  const resampler=new Pcm16Resampler(24000,16000);const chunks:Uint8Array[]=[];
  for(let i=0;i<pcm24.length;i+=4800)chunks.push(resampler.push(decodePcm16(pcm24.subarray(i,i+4800))));
  chunks.push(resampler.flush());const pcm16=Buffer.concat(chunks);
  if(pcm16.length<8000||pcm16.length>15*16000*2||pcm16.length%2){record.stoppedReason='Resampled audio failed bounds; ASR not attempted.';return finish();}
  await run('asr',async(signal,row)=>{
    const usage:Record<string,number>={};const provider=new QwenSpeechProvider(config.qwen!,makeWire(usage));const session=provider.openAsr(signal);
    try {
      await session.ready;
      for(let i=0;i<pcm16.length;i+=3200){if(signal.aborted)throw new DOMException('Aborted','AbortError');session.append(pcm16.subarray(i,i+3200));}
      const transcript=await session.commit();
      Object.assign(row,{text:transcript,inputSampleRate:16000,pcmBytes:pcm16.length,durationSeconds:pcm16.length/32000,usage,estimatedCny:Math.ceil(pcm16.length/32000)*.00033,estimateBasis:'Rounded up to full seconds for estimate; minimum billing unit not verified.'});
    }finally{session.cancel();}
  });
  finish();
  function finish(){
    record.finishedAt=new Date().toISOString();record.budgetAfter=budget.status();
    record.actualCloudBillVerified=false;record.automaticPaidValidationStopped=true;save();
    print({summary:'Automatic paid validation stopped. No retries.',requestCount:record.requests.length,budget:budget.status()});
  }
}
main().catch(()=>{print({status:'STOPPED',message:'Local preparation or recording failed; no automatic retry. Inspect only sanitized run record to determine whether a request was attempted.'});process.exitCode=1;});

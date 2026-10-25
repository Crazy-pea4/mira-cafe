// Explicit bounded story check: real text API, silent fake playback, no speech APIs.
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {resolveConfig} from '../server/config';
import {DeepSeekProvider} from '../server/providers';
import {retryDialogue} from '../server/retry-dialogue';
import {budgetDialogue} from '../server/budget-providers';
import {BudgetGuard,FileBudgetStore} from '../server/budget';
import {buildApp} from '../server/app';
import {ConversationEngine} from '../src/core/engine';
import {HttpTransport} from '../src/core/transport';
const marker=resolve('.local/story-live-2026-10-25.json');
async function main(){
 if(process.argv[2]!=='--authorized-two-routes'){console.log('No request sent: explicit authorized flag required.');return;}
 if(existsSync(marker)){console.log('REPLAY_BLOCKED: no request sent.');return;}
 const config=resolveConfig(process.env);if(!config.deepseek||config.deepseek.model!=='deepseek-flash')throw Error('CONFIGURATION');
 const budget=new BudgetGuard(new FileBudgetStore(resolve('.local/budget.json')),{confirmed:process.env.MIRA_BILLING_CONFIRMED==='true',modelSupported:true,maxRequests:Number(process.env.MIRA_MAX_LIVE_REQUESTS??60)});
 const before=budget.status();const limit=Math.min(10,before.maxRequests-before.totalRequests,Math.floor((before.stopCny-before.reservedCny+1e-8)/.2));
 if(!before.enabled||limit<1){console.log(JSON.stringify({status:'BUDGET_BLOCKED',budget:before}));return;}
 const record:any={startedAt:new Date().toISOString(),limit,budgetBefore:before,requests:[],turns:[],microphone:false,audioPlayed:false,ttsRequests:0,asrRequests:0,cloudBillVerified:false};
 mkdirSync(resolve('.local'),{recursive:true,mode:0o700});writeFileSync(marker,JSON.stringify(record),{flag:'wx',mode:0o600});
 const save=()=>writeFileSync(marker,JSON.stringify(record,null,2),{mode:0o600});
 const realFetch=fetch;let current:any;
 const fetcher:typeof fetch=async(url,init)=>{
  if(String(url)!=='https://api.deepseek.com/chat/completions'||record.requests.length>=limit)throw Error('REQUEST_LIMIT');
  current={number:record.requests.length+1,status:'pending'};record.requests.push(current);save();
  const response=await realFetch(url,{...init,redirect:'error'});current.httpStatus=response.status;
  const data=await response.clone().json();const c=data.choices?.[0];const content=c?.message?.content;
  current.finishReason=['stop','length','content_filter'].includes(c?.finish_reason)?c.finish_reason:'other';current.contentLength=typeof content==='string'?content.length:0;
  for(const k of ['prompt_tokens','completion_tokens'])if(Number.isFinite(data.usage?.[k]))current[k]=data.usage[k];
  current.estimatedCny=(current.prompt_tokens??0)*2/1e6+(current.completion_tokens??0)*8/1e6;
  // All dialogue in this record is generated for the fixed synthetic test inputs below.
  try{const r=JSON.parse(content);current.fictionalText=r.segments?.map((s:any)=>typeof s.text==='string'?s.text.slice(0,180):'').join('');current.suggestedBeats=r.segments?.map((s:any)=>s.beat??null);current.proposedIntent=r.story?.intent;current.proposedSuggestions=r.suggestions;}catch{}
  current.status='received';save();return response;
 };
 const provider=retryDialogue(budgetDialogue(new DeepSeekProvider(config.deepseek.apiKey,config.deepseek.model,fetcher,facts=>{if(current){current.diagnostic=facts;save();console.log(JSON.stringify(current));}}),budget));
 const app=buildApp(provider);await app.ready();const pending=new Set<Promise<unknown>>();
 globalThis.fetch=async(input,init)=>{
  const url=String(input);if(!['/api/turn','/api/cancel','/api/presented'].includes(url))throw Error('LOCAL_ROUTE_ONLY');
  const work=app.inject({method:'POST',url,headers:{origin:'http://127.0.0.1:3001',host:'127.0.0.1:3001'},payload:JSON.parse(init!.body as string)});pending.add(work);
  try{const r=await work;return new Response(r.body,{status:r.statusCode,headers:{'Content-Type':'application/json'}});}finally{pending.delete(work);}
 };
 const routes=[['可以，是什么消息？','你已经决定要去了吗？','他们具体想拍些什么？','你以前去过那里吗？','你最怕拍人的哪一部分？'],['我可以听一会儿，是什么事？','你平时喜欢喝哪种咖啡？','我的办法是先视频聊十分钟，再决定要不要试住一天。','对方希望你拍什么呢？','我今晚不想再出主意，你自己决定吧。']];
 try{
  outer:for(let i=0;i<routes.length;i++){
   const engine=new ConversationEngine(new HttpTransport(),{async play(_text,signal,start){if(signal.aborted)throw new DOMException('Cancelled','AbortError');start();},stop(){}},crypto.randomUUID(),()=>0);
   try{for(let n=0;n<routes[i].length;n++){
    if(record.requests.length>=limit||!budget.status().enabled||budget.status().reservedCny+.2>8){record.stoppedReason='Original budget/attempt limit reached; no bypass.';break outer;}
    const start=record.requests.length;await engine.submit(routes[i][n]);const state=engine.getSnapshot();
    const row={route:i+1,turn:n+1,syntheticInput:routes[i][n],attempts:record.requests.length-start,status:state.status,error:state.error,notice:state.notice,story:state.story,suggestions:state.suggestions};record.turns.push(row);save();console.log(JSON.stringify(row));
    if(state.status==='error'){record.stoppedReason='Failed turn; no operator replay.';break outer;}
   }}finally{engine.dispose();await Promise.resolve();await Promise.all(pending);}
  }
 }finally{
  await app.close();globalThis.fetch=realFetch;record.finishedAt=new Date().toISOString();record.budgetAfter=budget.status();record.estimatedCny=record.requests.reduce((n:number,r:any)=>n+(r.estimatedCny??0),0);
  record.firstAttemptAccepted=record.requests.filter((r:any)=>r.diagnostic?.attempt===1&&r.diagnostic?.outcome!=='rejected').length;record.repairs=record.requests.filter((r:any)=>r.diagnostic?.attempt>1).length;record.automaticPaidTestingStopped=true;save();
  console.log(JSON.stringify({requests:record.requests.length,turns:record.turns.length,firstAttemptAccepted:record.firstAttemptAccepted,repairs:record.repairs,estimatedCny:record.estimatedCny,budget:record.budgetAfter,stoppedReason:record.stoppedReason??'Completed planned routes; stopped.'}));
 }
}
main().catch(()=>{console.log('STOPPED: inspect sanitized test record; no automatic operator replay.');process.exitCode=1;});

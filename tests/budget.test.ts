import { describe,it,expect,vi } from 'vitest';
import { mkdtempSync,rmSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetGuard,MemoryBudgetStore,FileBudgetStore } from '../server/budget';
import { budgetDialogue,budgetSpeech } from '../server/budget-providers';
import { logFacts } from '../server/safe-log';
import { buildApp } from '../server/app';
const options={confirmed:true,modelSupported:true,now:()=>Date.parse('2026-10-25T12:00:00Z')};
describe('shared CNY 10 budget reservations, without paid calls',()=>{
 it('requires billing confirmation, a priced model and a current price review',()=>{
  for(const config of [{...options,confirmed:false},{...options,modelSupported:false},{...options,now:()=>Date.parse('2026-11-01')}]){
   const guard=new BudgetGuard(new MemoryBudgetStore(),config);expect(()=>guard.reserve('deepseek',new AbortController().signal)).toThrow();expect(guard.status().totalRequests).toBe(0);
  }
 });
 it('counts all services together and never refunds cancellation or failure',async()=>{
  const guard=new BudgetGuard(new MemoryBudgetStore(),options),abort=new AbortController();
  const release=guard.reserve('deepseek',abort.signal);abort.abort();release();
  guard.reserve('asr',new AbortController().signal)();
  const provider=budgetSpeech({openAsr:()=>{throw new Error('fake failure');},synthesize:async()=>{}},guard);
  expect(()=>provider.openAsr(new AbortController().signal)).toThrow();
  expect(guard.status()).toMatchObject({capCny:10,stopCny:8,reservedCny:.24,totalRequests:3,actualBilledCny:null,requests:{deepseek:1,asr:2,tts:0}});
 });
 it('stops before a new reservation would exceed the 8 yuan safety line',()=>{
  const guard=new BudgetGuard(new MemoryBudgetStore(),options);
  for(let i=0;i<40;i++)guard.reserve('deepseek',new AbortController().signal)();
  expect(guard.status().reservedCny).toBe(8);expect(()=>guard.reserve('asr',new AbortController().signal)).toThrow();expect(guard.status().totalRequests).toBe(40);
 });
 it('enforces one active request and the combined request limit',()=>{
  const guard=new BudgetGuard(new MemoryBudgetStore(),{...options,maxRequests:2});
  const release=guard.reserve('tts',new AbortController().signal);expect(()=>guard.reserve('asr',new AbortController().signal)).toThrow('尚未结束');release();release();
  guard.reserve('asr',new AbortController().signal)();expect(()=>guard.reserve('deepseek',new AbortController().signal)).toThrow();expect(guard.status().totalRequests).toBe(2);
 });
 it('rejects already aborted work before charging the local reservation',()=>{
  const guard=new BudgetGuard(new MemoryBudgetStore(),options),abort=new AbortController();abort.abort();
  expect(()=>guard.reserve('tts',abort.signal)).toThrow();expect(guard.status().reservedCny).toBe(0);
 });
 it('persists reservations across process-like instances and blocks corrupt or locked ledgers',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mira-budget-')),path=join(dir,'budget.json');
  try{
   new BudgetGuard(new FileBudgetStore(path),options).reserve('tts',new AbortController().signal)();
   const next=new BudgetGuard(new FileBudgetStore(path),options);expect(next.status().reservedCny).toBe(.04);
   writeFileSync(path+'.lock','');expect(()=>next.reserve('asr',new AbortController().signal)).toThrow('正在使用');
   expect(JSON.parse(readFileSync(path,'utf8')).requests.asr).toBe(0);rmSync(path+'.lock');
   writeFileSync(path,'broken');expect(next.status().enabled).toBe(false);expect(()=>next.reserve('tts',new AbortController().signal)).toThrow();
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('blocks adapters before any transport request when metering is unconfirmed',async()=>{
  const guard=new BudgetGuard(new MemoryBudgetStore(),{...options,confirmed:false}),reply=vi.fn(),openAsr=vi.fn(),synthesize=vi.fn();
  const text=budgetDialogue({kind:'deepseek',reply},guard),speech=budgetSpeech({openAsr,synthesize},guard);
  await expect(text.reply({sessionId:crypto.randomUUID(),turnId:1,text:'test',history:[],fault:'none'},new AbortController().signal)).rejects.toMatchObject({code:'BUDGET_LIMIT'});
  expect(()=>speech.openAsr(new AbortController().signal)).toThrow();
  await expect(speech.synthesize('test',new AbortController().signal,vi.fn())).rejects.toMatchObject({code:'BUDGET_LIMIT'});
  expect(reply).not.toHaveBeenCalled();expect(openAsr).not.toHaveBeenCalled();expect(synthesize).not.toHaveBeenCalled();
 });
 it('allows only enumerated non-sensitive facts into startup logging',()=>{
  const record=logFacts({event:'started',provider:'mock',port:3001,authorization:'Bearer secret',apiKey:'secret',message:'private text',audio:'bytes'} as any);
  expect(record).toEqual({event:'started',provider:'mock',port:3001});expect(JSON.stringify(record)).not.toContain('secret');
 });
});

it('rejects foreign-origin requests before a real-provider adapter can run',async()=>{
 const reply=vi.fn(async()=>({segments:[{text:'test',emotion:'curious' as const,action:'idle' as const}]}));
 const app=buildApp({kind:'deepseek',reply});
 try {
  const result=await app.inject({method:'POST',url:'/api/turn',headers:{host:'127.0.0.1:3001',origin:'https://example.com'},payload:{sessionId:crypto.randomUUID(),turnId:1,text:'test',history:[],fault:'none'}});
  expect(result.statusCode).toBe(403);expect(reply).not.toHaveBeenCalled();
 }finally{await app.close();}
});

it('fails closed on invalid request limits instead of silently increasing them',()=>{
 for(const maxRequests of [0,-1,NaN,Infinity,2.5]){
  const guard=new BudgetGuard(new MemoryBudgetStore(),{...options,maxRequests});
  expect(()=>guard.reserve('asr',new AbortController().signal)).toThrow();
 }
});
it('rejects numeric ledger corruption rather than understating reservations',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mira-budget-check-')),path=join(dir,'budget.json');
 try{
  writeFileSync(path,JSON.stringify({version:1,requests:{deepseek:1,asr:0,tts:0},reservedMicros:0}));
  const guard=new BudgetGuard(new FileBudgetStore(path),options);
  expect(guard.status().enabled).toBe(false);expect(()=>guard.reserve('tts',new AbortController().signal)).toThrow();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

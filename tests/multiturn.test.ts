import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryDialogue } from '../server/retry-dialogue';
import { buildApp } from '../server/app';
import { DeepSeekProvider } from '../server/providers';
import { buildDialogueMessages } from '../server/dialogue-history';
import { ConversationEngine } from '../src/core/engine';
import { HttpTransport } from '../src/core/transport';
import type { AudioPlayer } from '../src/core/audio';
import { replySchema, type TurnRequest } from '../shared/protocol';
import type { ReplyDiagnostic } from '../server/reply-diagnostics';
import { abortError } from '../shared/async';
const good={segments:[{text:'雨还没停。坐一会儿吧。',emotion:'curious',action:'look-window'}]};
const envelope=(content:string)=>({choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:335,completion_tokens:11}});
const input:TurnRequest={sessionId:'22222222-2222-4222-8222-222222222222',turnId:1,text:'聊聊旅行',history:[],fault:'none'};
afterEach(()=>vi.unstubAllGlobals());
async function harness(responses:string[], audio?:AudioPlayer, retry=false){
 const bodies:any[]=[]; const facts:ReplyDiagnostic[]=[];const local:Promise<unknown>[]=[];
 const provider=new DeepSeekProvider('fixture-not-a-secret','deepseek-flash',async(_url,init)=>{
  const body=JSON.parse(init!.body as string);bodies.push(body);
  return new Response(JSON.stringify(envelope(responses[bodies.length-1]??JSON.stringify(good))));
 },fact=>facts.push(fact));
 const app=buildApp(retry?retryDialogue(provider):provider);await app.ready();
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
  expect(['/api/turn','/api/cancel']).toContain(url);
  const pending=app.inject({method:'POST',url,headers:{origin:'http://127.0.0.1:3001',host:'127.0.0.1:3001'},payload:JSON.parse(init.body as string)});local.push(pending);
  const result=await pending;return new Response(result.body,{status:result.statusCode,headers:{'Content-Type':'application/json'}});
 });
 const engine=new ConversationEngine(new HttpTransport(),audio??{async play(_text,signal,start){if(signal.aborted)throw abortError();start();},stop(){}},crypto.randomUUID(),()=>0);
 return{engine,bodies,facts,async close(){engine.dispose();await Promise.all(local);await app.close();}};
}
describe('multi-turn application path: engine → HTTP → Fastify → provider, fake external HTTP',()=>{
 it('repairs a second-turn schema error within the same application turn, preserving structured history',async()=>{
  const h=await harness([JSON.stringify(good),'{\"segments\":[]}',JSON.stringify(good)],undefined,true);
  try{
   await h.engine.submit('你好');await h.engine.submit('聊聊旅行');
   expect(h.engine.getSnapshot()).toMatchObject({status:'idle',completed:2,error:''});
   expect(h.bodies).toHaveLength(3);
   expect(h.bodies[2].messages.slice(0,-1)).toEqual(h.bodies[1].messages);
   expect(h.bodies[2].messages.at(-1).content).toContain('segments:too_small');
   expect(JSON.parse(h.bodies[2].messages.find((m:any)=>m.role==='assistant').content)).toEqual(good);
  }finally{await h.close();}
 });
 it('preserves one structured assistant per completed turn for three consecutive real application turns',async()=>{
  const h=await harness([]);
  try{
   for(const line of ['你好','聊聊旅行','看照片'])await h.engine.submit(line);
   expect(h.engine.getSnapshot()).toMatchObject({status:'idle',completed:3});expect(h.bodies).toHaveLength(3);
   expect(h.bodies[1].messages.map((m:any)=>m.role)).toEqual(['system','user','assistant','user']);
   expect(h.bodies[2].messages.map((m:any)=>m.role)).toEqual(['system','user','assistant','user','assistant','user']);
   for(const body of h.bodies){
    expect(body).toMatchObject({thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:650});
    expect(body.messages[0].content).toContain('只输出一个JSON对象');
    for(const message of body.messages.filter((m:any)=>m.role==='assistant'))expect(replySchema.parse(JSON.parse(message.content))).toEqual(good);
   }
   expect(h.facts.map(f=>f.outcome)).toEqual(['accepted','accepted','accepted']);
   expect(h.facts[1]).toMatchObject({historyEntries:2,assistantMessages:1,jsonAssistantHistory:true,messageCount:4});
  }finally{await h.close();}
 });
 it('reproduces the observed second-turn eleven whitespace characters, does not retry or fake text, and recovers explicitly',async()=>{
  const h=await harness([JSON.stringify(good),' '.repeat(11),JSON.stringify(good)]);
  try{
   await h.engine.submit('你好');await h.engine.submit('聊聊你的旅行吧。');
   expect(h.engine.getSnapshot()).toMatchObject({status:'error',completed:1,subtitle:'',error:'这次没有收到有效对白，未自动重试。'});
   expect(h.bodies).toHaveLength(2);
   expect(h.facts[1]).toMatchObject({outcome:'rejected',finishReason:'stop',contentLength:11,trimmedLength:0,issues:['empty-text']});
   await h.engine.retry();expect(h.bodies).toHaveLength(3);
   expect(h.bodies[2].messages.filter((m:any)=>m.role==='user').map((m:any)=>m.content)).toEqual(['你好','聊聊你的旅行吧。']);
   expect(h.engine.getSnapshot()).toMatchObject({status:'idle',completed:2,error:''});
  }finally{await h.close();}
 });
 it('carries only the completed first sentence after interruption, in valid JSON with its real directives',async()=>{
  let count=0;let engine:ConversationEngine;
  const h=await harness([],{async play(_text,signal,start){start();if(++count===2){engine.interrupt();throw abortError();}if(signal.aborted)throw abortError();},stop(){}});engine=h.engine;
  try{
   await engine.submit('你好');await engine.submit('打断后聊旅行');
   const previous=JSON.parse(h.bodies[1].messages.find((m:any)=>m.role==='assistant').content);
   expect(previous).toEqual({segments:[{text:'雨还没停。',emotion:'curious',action:'look-window'}]});
   expect(JSON.stringify(previous)).not.toContain('坐一会儿吧');
   expect(engine.getSnapshot()).toMatchObject({status:'idle',completed:1});
  }finally{await h.close();}
 });
 it('rejects invalid live directives without polluting the next turn history',async()=>{
  const h=await harness([JSON.stringify({segments:[{text:'安全对白。',emotion:'invalid',action:'run-code'}]}),JSON.stringify(good)]);
  try{
   await h.engine.submit('你好');await h.engine.submit('继续');
   expect(h.bodies[1].messages.map((m:any)=>m.role)).toEqual(['system','user']);
   expect(JSON.stringify(h.bodies[1])).not.toMatch(/run-code|notice|REPLY_TEXT_ONLY/);
  }finally{await h.close();}
 });
});
describe('legacy history boundaries',()=>{
 it('coalesces old clients plain assistant sentences into one JSON message',()=>{
  const messages=buildDialogueMessages('system json', {...input,history:[{role:'user',content:'你好'},{role:'assistant',content:'第一句。'},{role:'assistant',content:'第二句。'}]});
  expect(messages.map(m=>m.role)).toEqual(['system','user','assistant','user']);
  expect(replySchema.parse(JSON.parse(messages[2].content)).segments.map(s=>s.text)).toEqual(['第一句。','第二句。']);
 });
 it('drops damaged JSON and unknown instructions instead of relabeling fragments as prior dialogue',()=>{
  for(const content of ['{"segments":[{"text":"坏片段',JSON.stringify({segments:[{text:'hi',emotion:'curious',action:'run-code'}]})]){
   expect(buildDialogueMessages('json',{...input,history:[{role:'assistant',content}]}).map(m=>m.role)).toEqual(['system','user']);
  }
 });
 it('merges unanswered legacy user entries without inventing assistant replies',()=>{
  const messages=buildDialogueMessages('json',{...input,history:[{role:'user',content:'先前的问题'}]});
  expect(messages.map(m=>m.role)).toEqual(['system','user']);expect(messages[1].content).toBe('先前的问题\n聊聊旅行');
 });
});

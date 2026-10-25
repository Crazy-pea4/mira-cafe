import { describe,it,expect,vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDeepSeekReply } from '../server/reply-parser';
import { safeReplyDiagnostic, writeReplyDiagnostic, type ReplyDiagnostic } from '../server/reply-diagnostics';
import { DeepSeekProvider } from '../server/providers';
import { replySchema } from '../shared/protocol';
const text='雨还没停，坐一会儿吧。';
const segment={text,emotion:'curious',action:'idle'};
const good={segments:[segment]};
const wrap=(content:unknown,finish_reason:unknown='stop')=>({choices:[{finish_reason,message:{content}}],usage:{prompt_tokens:123,completion_tokens:45}});
describe('bounded reply recovery without executing model commands',()=>{
 it('preserves a valid structured reply without inventing a notice',()=>{
  const sink=vi.fn();expect(parseDeepSeekReply(wrap(JSON.stringify(good)),sink)).toEqual(good);expect(sink).toHaveBeenCalledWith(expect.objectContaining({outcome:'accepted',issues:[]}));
 });
 it.each([
  ['fenced','\u0060\u0060\u0060json\n'+JSON.stringify(good)+'\n\u0060\u0060\u0060'],
  ['wrapped',JSON.stringify({response:good})],
  ['wrapped',JSON.stringify({reply:good})],
  ['wrapped',JSON.stringify([segment])],
  ['wrapped',JSON.stringify(JSON.stringify(good))],
  ['extra-fields',JSON.stringify({segments:[{...segment,scene:null,event:null,unused:'ignored'}],metadata:{anything:'ignored'}})],
 ])('repairs only a complete, known wrapper (%s)',(issue,content)=>{
  const sink=vi.fn();expect(parseDeepSeekReply(wrap(content),sink)).toEqual(good);
  expect(sink.mock.calls[0][0].issues).toContain(issue);expect(sink.mock.calls[0][0].outcome).toBe('normalized');
 });
 it.each([
  {text,emotion:'happy',action:'run-code',scene:'delete-all',event:'open-url'},
  {text,emotion:'curious'},
  {text,action:'idle'},
  {text,emotion:'curious',action:'look-window',scene:'unsupported'},
  {text,emotion:'curious',action:'idle',event:'eval'},
 ])('keeps actual dialogue but removes every visual directive if any is invalid',candidate=>{
  const reply=parseDeepSeekReply(wrap(JSON.stringify({segments:[candidate]})));
  expect(reply).toEqual({segments:[{text,emotion:'guarded',action:'idle'}],notice:'REPLY_TEXT_ONLY'});
  expect(replySchema.safeParse(reply).success).toBe(true);
 });
 it('strips unknown fields and prototype-looking keys without execution or pollution',()=>{
  const reply=parseDeepSeekReply(wrap('{"segments":[{"text":"安全对白。","emotion":"curious","action":"idle","execute":"do-dangerous-thing","__proto__":{"polluted":true}}],"notice":"forged"}'));
  expect(reply).toEqual({segments:[{text:'安全对白。',emotion:'curious',action:'idle'}]});expect(({} as any).polluted).toBeUndefined();
 });
 it.each([text,JSON.stringify({text}),JSON.stringify({dialogue:text}),JSON.stringify({content:text})])('labels usable text-only responses as degraded, not normal success',content=>{
  expect(parseDeepSeekReply(wrap(content))).toEqual({segments:[{text,emotion:'guarded',action:'idle'}],notice:'REPLY_TEXT_ONLY'});
 });
 it('splits complete long text within the total limit without inventing or dropping words',()=>{
  const long='咖啡'.repeat(160);const reply=parseDeepSeekReply(wrap(JSON.stringify({segments:[{...segment,text:long}]})));
  expect(reply.notice).toBe('REPLY_TEXT_ONLY');expect(reply.segments.map(s=>s.text).join('')).toBe(long);
  expect(reply.segments.every(s=>s.text.length<=180&&s.action==='idle'&&!s.event)).toBe(true);
 });
 it('does not turn extra/missing-text segments into fake dialogue',()=>{
  const reply=parseDeepSeekReply(wrap(JSON.stringify({segments:[{action:'open-url'},segment]})));
  expect(reply.notice).toBe('REPLY_TEXT_ONLY');expect(reply.segments.map(s=>s.text)).toEqual([text]);
 });
 it.each([
  ['', 'EMPTY_REPLY'],['   ','EMPTY_REPLY'],[null,'EMPTY_REPLY'],[42,'EMPTY_REPLY'],
  ['{"segments":[]}', 'EMPTY_REPLY'],['{"segments":[{"text":"  ","action":"idle"}]}','EMPTY_REPLY'],
  ['{"segments":[{"text":{},"action":"idle"}]}','EMPTY_REPLY'],
  ['{"segments":[{"text":"没写完', 'INVALID_REPLY'],
  ['说明：{"segments":[', 'INVALID_REPLY'],
  ['\u0060\u0060\u0060json\n{"segments":[]}', 'INVALID_REPLY'],
  [JSON.stringify({segments:[{...segment,text:'字'.repeat(541)}]}),'REPLY_TOO_LONG'],
  ['x'.repeat(12001),'REPLY_TOO_LONG'],
 ])('rejects unusable content instead of speaking raw JSON (%j)',(content,code)=>{
  try{parseDeepSeekReply(wrap(content));throw new Error('unexpected success');}catch(error){expect(error).toMatchObject({code});}
 });
 it.each(['length','content_filter','tool_calls','insufficient_system_resource','aborted','unexpected'])('rejects abnormal finish reason %s even with apparently valid JSON',reason=>{
  const sink=vi.fn();expect(()=>parseDeepSeekReply(wrap(JSON.stringify(good),reason),sink)).toThrow();
  expect(sink.mock.calls[0][0]).toMatchObject({outcome:'rejected',finishReason:reason==='unexpected'?'other':reason});
 });
 it('keeps original content, raw errors, identifiers and credentials out of stored diagnostics',()=>{
  const sink=vi.fn();expect(()=>parseDeepSeekReply(wrap('{"text":"private user content secret-key'),sink)).toThrow();
  const facts=sink.mock.calls[0][0];const sanitized=safeReplyDiagnostic({...facts,authorization:'Bearer secret-key',content:'private user content',requestId:'private-id'});
  const encoded=JSON.stringify(sanitized);expect(encoded).not.toMatch(/secret-key|private user|private-id|authorization|requestId/);
  const dir=mkdtempSync(join(tmpdir(),'mira-diagnostic-test-'));
  try{const file=join(dir,'last.json');writeReplyDiagnostic(sanitized as ReplyDiagnostic,file);expect(readFileSync(file,'utf8')).toBe(encoded);}
  finally{rmSync(dir,{recursive:true,force:true});}
  expect(safeReplyDiagnostic({...facts,finishReason:'secret-key'})).toBeUndefined();
 });
 it('bounds recent success/failure diagnostics, strips injected text, and preserves the last anomaly',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mira-recent-test-'));
  try{
   const file=join(dir,'last.json');const sink=vi.fn();expect(()=>parseDeepSeekReply(wrap(' '.repeat(11)),sink)).toThrow();
   const failed=sink.mock.calls[0][0];writeReplyDiagnostic(failed,file);
   const success=vi.fn();parseDeepSeekReply(wrap(JSON.stringify(good)),success);
   for(let i=0;i<25;i++)writeReplyDiagnostic({...success.mock.calls[0][0],content:'private-text',authorization:'secret-value'} as ReplyDiagnostic,file);
   const recent=readFileSync(join(dir,'recent-reply-diagnostics.json'),'utf8');
   expect(JSON.parse(recent)).toHaveLength(20);expect(recent).not.toMatch(/private-text|secret-value|authorization/);
   expect(JSON.parse(readFileSync(file,'utf8'))).toMatchObject({outcome:'rejected',contentLength:11,trimmedLength:0});
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('does not let a diagnostic storage failure invalidate usable text',()=>{
  expect(parseDeepSeekReply(wrap(text),()=>{throw new Error('disk');}).notice).toBe('REPLY_TEXT_ONLY');
 });
});
describe('DeepSeek parser integration, fake HTTP only',()=>{
 const request={sessionId:'22222222-2222-4222-8222-222222222222',turnId:1,text:'你好',history:[],fault:'none' as const};
 it('uses one bounded non-thinking request, consistent prompt enums, and no extra paid retry on truncation',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(wrap(JSON.stringify(good),'length')))),sink=vi.fn();
  const provider=new DeepSeekProvider('fixture-key','deepseek-flash',fetcher,sink);
  await expect(provider.reply(request,new AbortController().signal)).rejects.toMatchObject({code:'TRUNCATED_REPLY',message:expect.stringContaining('未自动重试')});
  expect(fetcher).toHaveBeenCalledOnce();const body=JSON.parse((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].body as string);
  expect(body).toMatchObject({thinking:{type:'disabled'},max_tokens:650,response_format:{type:'json_object'},stream:false});
  expect(body.messages[0].content).toContain('合计不超过120字');expect(body.messages[0].content).toContain('guarded/curious/relieved');
  expect(sink).toHaveBeenCalledOnce();
 });
 it('rejects invalid live directives for the outer retry policy, without a second provider HTTP call',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(wrap(JSON.stringify({segments:[{text,emotion:'happy',action:'unknown'}]})))));
  const provider=new DeepSeekProvider('fixture-key','deepseek-flash',fetcher);
  await expect(provider.reply(request,new AbortController().signal)).rejects.toMatchObject({code:'INVALID_REPLY',validationIssues:expect.arrayContaining(['segments.0.emotion:invalid_value','segments.0.action:invalid_value'])});expect(fetcher).toHaveBeenCalledOnce();
 });
 it('classifies an invalid HTTP body without leaking it or retrying',async()=>{
  const fetcher=vi.fn(async()=>new Response('private server error fixture')),sink=vi.fn();
  const provider=new DeepSeekProvider('fixture-key','deepseek-flash',fetcher,sink);
  await expect(provider.reply(request,new AbortController().signal)).rejects.toMatchObject({code:'INVALID_REPLY'});
  expect(fetcher).toHaveBeenCalledOnce();expect(JSON.stringify(sink.mock.calls)).not.toContain('private server');
 });
});

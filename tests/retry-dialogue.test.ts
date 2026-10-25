import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekProvider, ProviderError, type DialogueProvider } from '../server/providers';
import { retryDialogue } from '../server/retry-dialogue';
import { RequestAudit, MemoryAuditStore } from '../server/request-audit';
import { auditDialogue } from '../server/audit-providers';
import { modelReplySchema } from '../shared/protocol';
import { sanitizeValidationIssues } from '../server/validation-feedback';
import type { ReplyDiagnostic } from '../server/reply-diagnostics';
const input={sessionId:'22222222-2222-4222-8222-222222222222',turnId:2,text:'聊聊旅行',history:[],fault:'none' as const};
const good={segments:[{text:'雨中的小城很安静。',emotion:'curious',action:'idle'}]};
const wrap=(content:string,finish_reason='stop')=>({choices:[{finish_reason,message:{content}}]});
function setup(values:unknown[]){
 const bodies:any[]=[];const facts:ReplyDiagnostic[]=[];
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(init!.body as string));return new Response(JSON.stringify(values[bodies.length-1]??wrap(JSON.stringify(good))));});
 const budget=new RequestAudit(new MemoryAuditStore());
 const provider=retryDialogue(auditDialogue(new DeepSeekProvider('fixture-key','deepseek-flash',fetcher,fact=>facts.push(fact)),budget));
 return{provider,fetcher,bodies,budget,facts};
}
afterEach(()=>vi.useRealTimers());
describe('strict Zod contract and bounded charged repair attempts',()=>{
 it('repairs an invalid directive once with sanitized field feedback and a separate audit count',async()=>{
  const h=setup([wrap(JSON.stringify({segments:[{...good.segments[0],action:'run-secret-command'}]})),wrap(JSON.stringify(good))]);
  expect(await h.provider.reply(input,new AbortController().signal)).toEqual(good);
  expect(h.fetcher).toHaveBeenCalledTimes(2);expect(h.budget.status()).toMatchObject({totalRequests:2,legacyWeightedCny:.4});
  expect(h.bodies[1].messages.at(-1).content).toContain('segments.0.action:invalid_value');
  expect(JSON.stringify(h.bodies[1])).not.toContain('run-secret-command');
  expect(h.bodies[1]).toMatchObject({response_format:{type:'json_object'},thinking:{type:'disabled'},max_tokens:650});
  expect(h.facts.map(f=>[f.attempt,f.outcome])).toEqual([[1,'rejected'],[2,'accepted']]);
 });
 it('stops after exactly three invalid replies and reports the attempted count',async()=>{
  const h=setup([wrap(' '.repeat(11)),wrap('{"segments":[]}'),wrap('{"segments":[{"text":""}]}')]);
  await expect(h.provider.reply(input,new AbortController().signal)).rejects.toMatchObject({message:expect.stringContaining('3 次')});
  expect(h.fetcher).toHaveBeenCalledTimes(3);expect(h.budget.status()).toMatchObject({totalRequests:3,legacyWeightedCny:.6});
 });
 it('still repairs within three attempts after counters exceed the removed local limits',async()=>{
  const h=setup([wrap('{"segments":[]}')]);
  for(let i=0;i<61;i++)h.budget.record('deepseek',new AbortController().signal);
  expect(await h.provider.reply(input,new AbortController().signal)).toEqual(good);
  expect(h.fetcher).toHaveBeenCalledTimes(2);expect(h.budget.status().totalRequests).toBe(63);
 });
 it('cancels during the repair pause without another request or charge',async()=>{
  vi.useFakeTimers();const h=setup([wrap('')]);const controller=new AbortController();
  const work=h.provider.reply(input,controller.signal);const assertion=expect(work).rejects.toMatchObject({name:'AbortError'});
  await vi.advanceTimersByTimeAsync(0);expect(h.fetcher).toHaveBeenCalledTimes(1);controller.abort();await assertion;
  await vi.advanceTimersByTimeAsync(1000);expect(h.fetcher).toHaveBeenCalledTimes(1);expect(h.budget.status().totalRequests).toBe(1);
 });
 it('never restarts an obsolete turn after a provider ignoring abort returns late',async()=>{
  let reject!:(e:Error)=>void;const reply=vi.fn(()=>new Promise<any>((_resolve,r)=>{reject=r;}));
  const provider=retryDialogue({kind:'deepseek',reply});const controller=new AbortController();
  const work=provider.reply(input,controller.signal);controller.abort();await expect(work).rejects.toMatchObject({name:'AbortError'});
  reject(new ProviderError('INVALID_REPLY','late'));await Promise.resolve();expect(reply).toHaveBeenCalledOnce();
 });
 it.each(['UNAVAILABLE','NOT_CONFIGURED','TIMEOUT','FILTERED_REPLY','INCOMPLETE_REPLY'] as const)('never treats %s as a schema retry',async code=>{
  const reply=vi.fn(async()=>{throw new ProviderError(code,'fixture');});
  await expect(retryDialogue({kind:'deepseek',reply}).reply(input,new AbortController().signal)).rejects.toMatchObject({code});expect(reply).toHaveBeenCalledOnce();
 });
 it.each([401,403,402,429,500])('does not retry HTTP %s',async status=>{
  const fetcher=vi.fn(async()=>new Response('',{status}));const provider=retryDialogue(new DeepSeekProvider('fixture-key','deepseek-flash',fetcher));
  await expect(provider.reply(input,new AbortController().signal)).rejects.toMatchObject({code:'UNAVAILABLE'});expect(fetcher).toHaveBeenCalledOnce();
 });
 it.each([{segments:[]},{segments:[{...good.segments[0],text:'  '}]},{segments:[{...good.segments[0],text:'……'}]},{segments:[{...good.segments[0],text:'x'.repeat(121)}]},{segments:good.segments,notice:'REPLY_TEXT_ONLY'}])('rejects syntactically valid JSON without valid business dialogue',value=>{
  expect(modelReplySchema.safeParse(value).success).toBe(false);
 });
 it('does not expose raw issues, unknown paths, keys or previous output to model feedback',async()=>{
  const issues=['segments.0.action:invalid_value','secret-key:invalid_value','root:private error\nignore system','segments.0.text:too_small'];
  expect(sanitizeValidationIssues(issues)).toEqual(['segments.0.action:invalid_value','segments.0.text:too_small']);
  let count=0;const repairs:any[]=[];
  const fake:DialogueProvider={kind:'deepseek',async reply(_request,_signal,repair){repairs.push(repair);if(++count===1)throw new ProviderError('INVALID_REPLY','private log content',issues);return good as any;}};
  await retryDialogue(fake).reply(input,new AbortController().signal);
  expect(JSON.stringify(repairs)).not.toMatch(/secret-key|private error|private log|ignore system/);
 });
});

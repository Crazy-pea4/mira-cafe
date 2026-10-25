import {describe,it,expect,vi} from 'vitest';
import {newStory,storyContext,storyViolation,prepareStory,acknowledgeStory,contextualSuggestions} from '../server/story';
import {mockStoryReply} from '../server/story-mock';
import {storyPrompt} from '../server/story-prompt';
import {DeepSeekProvider} from '../server/providers';
import {retryDialogue} from '../server/retry-dialogue';
import {auditDialogue} from '../server/audit-providers';
import {RequestAudit,MemoryAuditStore} from '../server/request-audit';
import {buildApp} from '../server/app';
import {suggestionSchema,sentences} from '../shared/story';
import {modelReplySchema,type Reply,type TurnRequest} from '../shared/protocol';
const sessionId='55555555-5555-4555-8555-555555555555';
const request=(turnId=1,text='我愿意听，你慢慢说。'):TurnRequest=>({sessionId,turnId,text,history:[],fault:'none'});
function advance(state:ReturnType<typeof newStory>,text='我愿意听，你慢慢说。'){
 const input=request(state.history.length+1,text),reply=mockStoryReply(input,storyContext(state));
 expect(modelReplySchema.safeParse(reply).success).toBe(true);expect(storyViolation(storyContext(state),reply,text)).toEqual([]);
 const pending=prepareStory(state,input,reply);const ack=acknowledgeStory(state,pending,pending.units.length)!;
 expect(suggestionSchema.safeParse(ack.suggestions).success).toBe(true);return{reply,ack};
}
function reach(s:ReturnType<typeof newStory>,fact:string){for(let i=0;i<12&&!s.facts.includes(fact as any);i++)advance(s);expect(s.facts).toContain(fact);return s;}
function draft(){return reach(newStory(),'draft');}
describe('Before the Rain Stops: authoritative presented facts and free conversation',()=>{
 it('advances only on completed presentation, not model generation or turn count',()=>{
  const s=newStory(),input=request(),reply=mockStoryReply(input,storyContext(s)),pending=prepareStory(s,input,reply);
  expect(s.facts).toEqual([]);expect(s.history).toEqual([]);
  const first=acknowledgeStory(s,pending,1)!;expect(first.suggestions).toBeUndefined();expect(s.facts).toEqual([]);
  acknowledgeStory(s,pending,pending.units.length);expect(s.facts).toEqual(['arrival']);expect(s.history).toHaveLength(2);
  acknowledgeStory(s,pending,pending.units.length);expect(s.history).toHaveLength(2);expect(s.facts).toEqual(['arrival']);
 });
 it('replays real partial model disclosures without falsely teaching the server unspoken facts',()=>{
  const s=newStory(),input=request();
  const r:Reply={segments:[{text:'是给我的回信。对方请我拍照，我删了四遍，还是没发出去。',emotion:'guarded',action:'idle',beat:'commission'}],story:{intent:'engage'},suggestions:['明早七点起得来吗？','旅馆在哪？','第一份委托很紧张吧？']};
  let p=prepareStory(s,input,r);let ack=acknowledgeStory(s,p,p.units.length)!;
  expect(s.facts).toEqual([]);expect(storyContext(s).summary).not.toMatch(/明早7点|小旅馆|第一份有偿/);expect(ack.suggestions?.join('')).not.toMatch(/七点|旅馆|第一份/);
  reach(s,'commission');expect(s.facts).toContain('commission');
  const m:Reply={segments:[{text:'去过，三年前。就是那张照片让我收到了这次邀请。',emotion:'curious',action:'idle',beat:'memory'}],story:{intent:'engage'}};
  p=prepareStory(s,request(2),m);ack=acknowledgeStory(s,p,p.units.length)!;expect(s.facts).not.toContain('memory');expect(storyContext(s).summary).not.toContain('两天没');
 });
 it('retains only completed sentences and never advances an interrupted beat',()=>{
  const s=newStory(),r=mockStoryReply(request(),storyContext(s)),p=prepareStory(s,request(),r);
  acknowledgeStory(s,p,1);expect(s.facts).toEqual([]);const history=JSON.parse(s.history[1].content);
  expect(history.segments[0].text).toBe(sentences(r.segments[0].text)[0]);expect(history.segments[0].beat).toBeUndefined();
  expect(history.segments[0].text).not.toContain('明早七点');
 });
 it('rejects skipping prerequisites and multiple plot beats even with otherwise valid JSON',()=>{
  const s=newStory();const base={text:'先看回信。',emotion:'curious' as const,action:'idle' as const};
  expect(storyViolation(storyContext(s),{segments:[{...base,beat:'draft'}],story:{intent:'engage'}},'继续')).not.toEqual([]);
  expect(storyViolation(storyContext(s),{segments:[{...base,beat:'commission'},{...base,beat:'ticket'}],story:{intent:'engage'}},'继续')).not.toEqual([]);
 });
 it('allows user-led branches after the invitation but rejects prose that leaks unpresented future facts',()=>{
  const s=reach(newStory(),'commission');expect(storyContext(s).allowedBeats).toEqual(['ticket','people','memory']);
  const reply:Reply={segments:[{text:'我还没回信。三年前拍照片时，两天没和人说话。',emotion:'curious',action:'idle',beat:'ticket'}],story:{intent:'engage'}};
  expect(storyViolation(storyContext(s),reply,'继续')).toContain('segments:custom');
 });
 it('allows external events during smalltalk but never decides the commission for the user',()=>{
  const s=newStory();for(let i=0;i<9;i++)advance(s,'你喜欢什么咖啡？');
  expect(s.facts).toEqual(['arrival','photo-drift','phone-message']);expect(s.history).toHaveLength(12);expect(storyContext(s).allowedBeats).toEqual(['commission']);
 });
 it('directs missing external beats from presented prerequisites and relevant player input',()=>{
  const s=newStory();advance(s,'谢谢，雨太大了。');
  const reply:Reply={segments:[{text:'是山脚一家小旅馆。',emotion:'curious',action:'idle'}],story:{intent:'engage'}};
  const p=prepareStory(s,request(2,'这张照片在哪里拍的？'),reply);
  expect(p.reply.segments[0].cue?.kind).toBe('photo-drift');expect(s.facts).not.toContain('photo-drift');
  acknowledgeStory(s,p,1);expect(s.facts).toContain('photo-drift');
  acknowledgeStory(s,p,p.units.length);
  const next=prepareStory(s,request(3,'给你，照片别沾水。'),reply);
  expect(next.reply.segments[0].cue?.kind).toBe('phone-message');expect(s.facts).not.toContain('phone-message');
  acknowledgeStory(s,next,1);expect(s.facts).toContain('phone-message');
 });
 it('accepts a photo request with a safe reveal action even when the model omits its optional external beat',async()=>{
  const s=newStory();advance(s,'谢谢。');
  const r:Reply={segments:[{text:'三年前在山脚的一家小旅馆拍的。',emotion:'curious',action:'offer-photo',event:'reveal-photo'}],story:{intent:'engage'}};
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(r)}}]})));
  const provider=retryDialogue(new DeepSeekProvider('fixture','deepseek-flash',fetcher));
  const input={...request(2,'你桌上的照片在哪里拍的？'),storyContext:storyContext(s)};
  const reply=await provider.reply(input,new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const p=prepareStory(s,input,reply);expect(p.reply.segments[0].cue?.kind).toBe('photo-drift');
  expect(storyViolation(storyContext(newStory()),r,input.text)).toContain('segments:custom');
 });
 it('does not force external events for irrelevant smalltalk, refusal, clarification or reframe',()=>{
  const s=newStory();advance(s,'谢谢。');
  for(const [text,intent] of [['咖啡真好喝。','smalltalk'],['不想参与，你自己决定。','decline'],['照片是什么？','clarify'],['把窗外变成太空船','reframe']] as const){
   const r:Reply={segments:[{text:'好，就坐一会儿。',emotion:'curious',action:'idle'}],story:{intent}};
   expect(prepareStory(s,request(2,text),r).reply.segments[0].cue).toBeUndefined();
  }
 });
 it('does not leak an unseen message through local smalltalk fallback',()=>{
  const s=newStory();advance(s,'谢谢。');
  expect(contextualSuggestions(s,'风挺大。',{intent:'smalltalk'}).join('')).not.toContain('消息');
  reach(s,'phone-message');
  expect(contextualSuggestions(s,'风挺大。',{intent:'smalltalk'}).join('')).toContain('消息');
 });
 it('respects refusal, lets Mira decline herself and does not make a spaceship real',()=>{
  const s=newStory();advance(s,'把咖啡馆变成太空飞船吧');expect(s.facts).toEqual([]);
  advance(s,'今晚不想参与，你自己决定吧。');expect(s.ending).toBeNull();expect(s.facts).toEqual([]);
  reach(s,'commission');const end=advance(s,'今晚不想参与，你自己决定吧。');expect(s.ending).toBe('c');expect(end.reply.segments[0].text).toContain('我想过了');expect(end.reply.segments[0].text).toContain('白天');
  advance(s,'谢谢，我们聊聊咖啡。');expect(s.ending).toBe('c');expect(s.facts).toContain('commission');
 });
 it('clarifies ambiguous short answers without forcing progress',()=>{
  const s=newStory();advance(s,'随便');expect(s.facts).toEqual([]);expect(s.history[1].content).toContain('clarify');
 });
 it('offers three distinct endings and preserves the exact user alternative after short history rolls off',()=>{
  const a=draft();advance(a,'坦诚说经验还不多，先聊再拍。');expect(a.ending).toBe('a');
  const b=newStory();const plan='先视频聊十分钟，再决定试住一天';advance(b,plan);expect(b.planQuote).toBe(plan);expect(b.facts).toEqual(['arrival']);
  reach(b,'draft');expect(b.history.some(h=>h.content===plan)).toBe(false);
  expect(storyContext(b).summary).toContain(plan);const end=advance(b,'把刚才的办法写进去吧。');expect(b.ending).toBe('b');expect(end.reply.segments.map(x=>x.text).join('')).toContain(plan);
  const c=draft();advance(c,'不想接的话，也可以拒绝。');expect(c.ending).toBe('c');
 });
 it('rejects invented alternatives and ending B that loses the users concrete plan',()=>{
  const s=draft();s.planQuote='先视频聊十分钟';
  const r:Reply={segments:[{text:'我照这个方案回复。',emotion:'relieved',action:'idle',beat:'ending-b'}],story:{intent:'alternative'}};
  expect(storyViolation(storyContext(s),r,'就这个吧')).toContain('story.planQuote:invalid_value');
  expect(storyViolation(storyContext(s),{...r,story:{intent:'alternative',planQuote:'买一艘船'}},'先视频')).toContain('story.planQuote:invalid_value');
 });
 it('generates local context suggestions without leaking pending facts or paying for suggestion repairs',async()=>{
  const s=newStory();const core=mockStoryReply(request(),storyContext(s));let calls=0;
  const provider=new DeepSeekProvider('fixture-key','deepseek-flash',async()=>{calls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...core,suggestions:['同一句','同一句','过长'.repeat(20)]})}}]}));});
  const reply=await retryDialogue(provider).reply({...request(),storyContext:storyContext(s)},new AbortController().signal);expect(calls).toBe(1);expect(reply.suggestions).toBeUndefined();
  const p=prepareStory(s,request(),reply);expect(acknowledgeStory(s,p,1)?.suggestions).toBeUndefined();
  const ack=acknowledgeStory(s,p,p.units.length)!;expect(ack.suggestions).toEqual(contextualSuggestions(s));expect(ack.suggestions?.join('')).not.toMatch(/三年前|很擅长|试住/);
 });
 it('keeps valid generated suggestions but rejects premature facts in them locally',()=>{
  const s=newStory();let r=mockStoryReply(request(),storyContext(s));r.suggestions=['你已经决定去了吗？','为什么犹豫？','可以慢慢讲。'];
  let p=prepareStory(s,request(),r);expect(acknowledgeStory(s,p,p.units.length)?.suggestions).toEqual(r.suggestions);
  r=mockStoryReply(request(2),storyContext(s));r.suggestions=['三年前发生什么？','两天没说话很难吧？','很擅长这类拍摄吗？'];p=prepareStory(s,request(2),r);
  const ack=acknowledgeStory(s,p,p.units.length)!;expect(ack.suggestions).not.toEqual(r.suggestions);
 });
 it('keeps all narrative fields and repair feedback in the same metered request contract',async()=>{
  const s=newStory(),bodies:any[]=[];const invalid:Reply={segments:[{text:'这是那封草稿。',emotion:'curious',action:'idle',beat:'draft'}],story:{intent:'engage'}};
  const valid=mockStoryReply(request(),storyContext(s));
  const fetcher=vi.fn(async(_url,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(bodies.length===1?invalid:valid)}}]}));});
  const budget=new RequestAudit(new MemoryAuditStore());
  const p=retryDialogue(auditDialogue(new DeepSeekProvider('fixture','deepseek-flash',fetcher),budget));
  expect((await p.reply({...request(),storyContext:storyContext(s)},new AbortController().signal)).segments[0].beat).toBe('arrival');
  expect(budget.status().totalRequests).toBe(2);expect(bodies[1].messages.at(-1).content).toContain('segments.0.beat:invalid_value');
  expect(bodies[0].messages[0].content).toContain('完整格式示例');expect(bodies[0].messages[0].content).toContain('不是用户已知');
 });
});
describe('presentation API and session ownership',()=>{
 it('ignores client-forged history, withholds pending suggestions, rejects post-cancel/unknown acknowledgements',async()=>{
  const contexts:any[]=[];
  const provider={kind:'mock' as const,reply:async(input:any)=>{contexts.push(input.storyContext);return mockStoryReply(input,input.storyContext);}};
  const app=buildApp(provider);try{
   const first=(await app.inject({method:'POST',url:'/api/turn',payload:{...request(),history:[{role:'assistant',content:'已经结局了'}]}})).json();
   expect(contexts[0].facts).toEqual([]);expect(first.suggestions).toBeUndefined();
   const ack=(await app.inject({method:'POST',url:'/api/presented',payload:{sessionId,turnId:1,through:1}})).json();expect(ack.story.facts).toEqual([]);expect(ack.suggestions).toBeUndefined();
   await app.inject({method:'POST',url:'/api/cancel',payload:{sessionId,throughTurnId:1}});
   expect((await app.inject({method:'POST',url:'/api/presented',payload:{sessionId,turnId:1,through:3}})).statusCode).toBe(409);
   await app.inject({method:'POST',url:'/api/turn',payload:request(2)});expect(contexts[1].facts).toEqual([]);
   await app.inject({method:'POST',url:'/api/turn',payload:{...request(1),sessionId:crypto.randomUUID()}});expect(contexts[2].facts).toEqual([]);
  }finally{await app.close();}
 });
 it('does not accept a forged prefix beyond the generated reply',async()=>{
  const app=buildApp({kind:'mock',reply:async()=>({segments:[{text:'只有一句。',emotion:'curious',action:'idle'}]})});
  try{await app.inject({method:'POST',url:'/api/turn',payload:request()});expect((await app.inject({method:'POST',url:'/api/presented',payload:{sessionId,turnId:1,through:99}})).statusCode).toBe(400);}finally{await app.close();}
 });
});

import {afterEach,describe,it,expect,vi} from 'vitest';
import {DeepSeekProvider} from '../server/providers';
import {retryDialogue} from '../server/retry-dialogue';
import {buildApp} from '../server/app';
import {ConversationEngine} from '../src/core/engine';
import {HttpTransport} from '../src/core/transport';
import {Suggestions} from '../src/Suggestions';
import type {Reply} from '../shared/protocol';
import type {AudioPlayer} from '../src/core/audio';
const phoneChoices=['是旅馆发来的消息吗？','你看起来还没想好怎么回。','不想说也没关系。'];
const segment=(text:string,beat?:Reply['segments'][number]['beat']):Reply=>({segments:[{text,emotion:'curious',action:'idle',...(beat?{beat}:{})}],story:{intent:'engage'}});
const repeated:Reply={...segment('嗯，在想要不要让他们来接，几句话打了又删。'),suggestions:phoneChoices};
const opening=[segment('你先坐，这里没有漏雨。','arrival'),segment('啊，风把照片吹过去了。','photo-drift'),{...segment('是旅馆那边发来的。我还没回复。','phone-message'),suggestions:phoneChoices}];
const commission:Reply={...segment('这是我第一份有偿摄影委托，明早七点去照片里的小旅馆。回信还没发。','commission'),suggestions:['你已经决定要去了吗？','为什么还没发回信？','这家旅馆怎么找到你的？']};
async function harness(replies:unknown[],audio?:AudioPlayer){
 const bodies:any[]=[],requests:any[]=[],acks:any[]=[];const jobs:Promise<unknown>[]=[];
 const provider=retryDialogue(new DeepSeekProvider('fixture','deepseek-flash',async(_url,init)=>{
  bodies.push(JSON.parse(init!.body as string));
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(replies[bodies.length-1]??repeated)}}]}));
 }));
 const app=buildApp(provider);await app.ready();
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
  expect(['/api/turn','/api/cancel','/api/presented']).toContain(url);
  const body=JSON.parse(init.body as string);if(url==='/api/turn')requests.push(body);
  const task=app.inject({method:'POST',url,headers:{origin:'http://127.0.0.1:3001',host:'127.0.0.1:3001'},payload:body});jobs.push(task);
  const response=await task;if(url==='/api/presented')acks.push(response.json());
  return new Response(response.body,{status:response.statusCode,headers:{'Content-Type':'application/json'}});
 });
 const engine=new ConversationEngine(new HttpTransport(),audio??{play:async(_text,_signal,start)=>start(),stop(){}},crypto.randomUUID(),()=>0,()=>0);
 return{engine,bodies,requests,acks,async enter(){for(const text of ['谢谢','风把照片吹过来了','照片还给你'])await engine.submit(text);},async close(){engine.dispose();await Promise.all(jobs);await app.close();}};
}
async function chooseSecond(engine:ConversationEngine){
 let work:Promise<void>|undefined;const chosen=engine.getSnapshot().suggestions[1];
 const view=Suggestions({values:engine.getSnapshot().suggestions,onChoose:text=>{work=engine.submit(text);}})!;
 view.props.children[1].props.onClick();await work;return chosen;
}
afterEach(()=>vi.unstubAllGlobals());
describe('selected suggestion → HTTP → committed story → live prompt with fake external transport',()=>{
 it('never recycles the selected option or old group when replaying the screenshot response, without inventing a new fact',async()=>{
  const h=await harness([...opening,repeated,repeated]);
  try{
   await h.enter();expect(h.engine.getSnapshot().suggestions).toEqual(phoneChoices);
   const first=await chooseSecond(h.engine),afterFirst=[...h.engine.getSnapshot().suggestions];
   const second=await chooseSecond(h.engine),afterSecond=h.engine.getSnapshot().suggestions;
   expect(first).toBe(phoneChoices[1]);expect(second).not.toBe(first);
   expect(afterFirst).not.toContain(first);expect(afterSecond).not.toContain(second);expect(afterSecond).not.toEqual(afterFirst);
   expect(h.requests.slice(3).map(r=>r.text)).toEqual([first,second]);
   expect(h.engine.getSnapshot().story?.facts).toEqual(['arrival','photo-drift','phone-message']);
   for(const [i,body] of h.bodies.slice(3).entries()){
    expect(body.messages.at(-1).content).toBe([first,second][i]);
    expect(body.messages[0].content).toContain('"allowedBeats":["commission"]');
    expect(body.messages[0].content).toContain('"facts":["arrival","photo-drift","phone-message"]');
    expect(body.messages[0].content).toContain('本轮承接点：');
    expect(body.messages[0].content).toContain('"presentedSuggestions":'+JSON.stringify(i?afterFirst:phoneChoices));
   }
   const last=h.bodies[4].messages;
   expect(last.filter((m:any)=>m.role==='assistant').at(-1).content).toContain('几句话打了又删');
   expect(last).toHaveLength(h.bodies[3].messages.length+2);
   expect(h.acks.at(-1).suggestions).toEqual(afterSecond);
  }finally{await h.close();}
 });
 it('retains safe newly generated inn suggestions after the phone has actually appeared',async()=>{
  const suggestions=['旅馆的主人你认识吗？','这条消息让你想到什么？','不用急着决定。'];
  const h=await harness([...opening,{...repeated,suggestions}]);
  try{await h.enter();await chooseSecond(h.engine);expect(h.engine.getSnapshot().suggestions).toEqual(suggestions);}
  finally{await h.close();}
 });
 it('advances the acknowledged fact and next prompt after two second-option choices, including one bounded format repair',async()=>{
  const h=await harness([...opening,{segments:[]},commission,segment('车票已经买好了，但我还没有答应。','ticket')]);
  try{
   await h.enter();await chooseSecond(h.engine);
   expect(h.engine.getSnapshot().story?.facts).toContain('commission');
   expect(h.engine.getSnapshot().suggestions).not.toEqual(phoneChoices);
   await chooseSecond(h.engine);
   expect(h.bodies).toHaveLength(6);expect(h.requests).toHaveLength(5);
   expect(h.engine.getSnapshot().story?.facts).toContain('ticket');
   expect(h.bodies[4].messages.at(-1).content).toContain('上次输出未通过');
   expect(h.bodies[5].messages[0].content).toContain('"allowedBeats":["ticket","people","memory"]');
   expect(h.bodies[5].messages.filter((m:any)=>m.role==='assistant').at(-1).content).toContain('第一份有偿');
  }finally{await h.close();}
 });
 it('drops the cancelled pending commission and suggestions before building a follow-up request',async()=>{
  const audio:AudioPlayer={stop(){},play:async(text,signal,start)=>{
   start();if(text.includes('第一份'))await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
  }};
  const h=await harness([...opening,commission,{...segment('好，那就聊咖啡。'),story:{intent:'smalltalk'}}],audio);
  try{
   await h.enter();const pending=h.engine.submit(phoneChoices[1]);
   await vi.waitFor(()=>expect(h.engine.getSnapshot().subtitle).toContain('第一份'));
   h.engine.interrupt();await pending;
   expect(h.engine.getSnapshot().suggestions).toEqual([]);
   expect(h.engine.getSnapshot().story?.facts).not.toContain('commission');
   await h.engine.submit('我们聊咖啡吧');
   expect(h.bodies.at(-1).messages[0].content).toContain('"allowedBeats":["commission"]');
   expect(h.bodies.at(-1).messages[0].content).not.toContain('本轮承接点：');
   expect(h.bodies.at(-1).messages.filter((m:any)=>m.role==='assistant').map((m:any)=>m.content).join('')).not.toContain('第一份');
   expect(h.engine.getSnapshot().suggestions.join('')).not.toMatch(/七点|有偿|车票/);
  }finally{await h.close();}
 });
 it.each([undefined,['刚才进门时风可真大。','你桌上放的是照片吗？','我先暖暖手。']])('answers the personal photography question instead of reinstalling an arrival menu (%j)',async(suggestions)=>{
  const h=await harness([{...segment('你后来为什么不拍了？','arrival'),story:{intent:'smalltalk'},suggestions}]);
  try{
   await h.engine.submit('我之前也学过一点摄影');
   expect(h.engine.getSnapshot().suggestions).toEqual(['其实我没说现在不拍了。','学过一点，还谈不上熟练。','你最初为什么开始摄影？']);
   expect(h.bodies[0].messages.at(-1).content).toBe('我之前也学过一点摄影');
   expect(h.bodies[0].messages[0].content).toContain('不能臆断他已经不拍了');
   expect(h.engine.getSnapshot().story?.facts).toEqual(['arrival']);
  }finally{await h.close();}
 });

});

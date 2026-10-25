import { storyBeatSchema, suggestionSchema, type StoryBeat, type StoryContext, type StoryProposal, type StoryView, type PresentationResponse, sentences } from '../shared/story';
import { presentationUnits, type PresentationUnit, type History, type Reply, type TurnRequest } from '../shared/protocol';
import { directStory } from './stage-director';
import type { StageCue } from '../shared/stage';
const factsText={
 arrival:'Mira已接住玩家初次回应，给躲雨的玩家让座。',
 'photo-drift':'穿堂风把照片吹到了玩家手边。',
 'phone-message':'手机收到剧情消息：明早需要去车站接你吗？Mira输入又停住。',
 practice:'Mira实际问了一个简短采访问题，开始练习拍人之前的交谈。',
 commission:'Mira第一次有偿摄影委托：明早7点去照片中的小旅馆，回信尚未发。',
 ticket:'车票已经买好，但不代表已决定接受。',
 people:'对方不仅要风景，也要拍住在那里的人。',
 memory:'三年前拍这张照片时，Mira两天没和人说话。',
 fear:'Mira怕别人不愿被拍，也怕别人配合而自己拍不好；风景不会看着她等下一句。',
 draft:'草稿原文：没问题，我很擅长这类拍摄。明天见。',
} as const;
export type StoryState=StoryView & {history:History; disclosures:Partial<Record<StoryBeat,string>>; cues:Partial<Record<StageCue['kind'],StageCue>>};
export function newStory():StoryState{return{act:'invitation',facts:[],ending:null,planQuote:'',declined:false,history:[],disclosures:{},cues:{}};}
export function storyView(state:StoryState):StoryView{return{act:state.act,facts:[...state.facts],ending:state.ending,planQuote:state.planQuote,declined:state.declined};}
export function allowedBeats(state:StoryView):StoryBeat[]{
 if(state.ending)return[];
 const known=new Set(state.facts);const next:StoryBeat[]=[];
 if(!known.has('arrival'))return['arrival'];
 if(!known.has('photo-drift'))return['photo-drift'];
 if(!known.has('phone-message'))return['phone-message'];
 if(!known.has('commission'))next.push('commission');
 else{
  for(const fact of ['ticket','people','memory'] as const)if(!known.has(fact))next.push(fact);
  if(known.has('people')&&!known.has('fear'))next.push('fear');
  if(['ticket','people','memory','fear'].every(f=>known.has(f as keyof typeof factsText))&&!known.has('draft'))next.push('draft');
  if(known.has('fear')&&!known.has('practice'))next.push('practice');
  if(known.has('draft'))next.push('ending-a',...(state.planQuote?['ending-b' as const]:[]),'ending-c');
 }
 if(state.declined&&known.has('commission')&&!next.includes('ending-c'))next.push('ending-c');
 return next;
}
export function inputBoundary(text:string):'decline'|'smalltalk'|'reframe'|undefined{
 if(/不想(?:聊|参与|出主意)|不聊这个|别(?:再)?问我|别再聊|你自己决定|自己拿主意|不帮.*(?:决定|主意)/.test(text))return'decline';
 if(/变成.*(?:太空|飞船|魔法)|这里是.*(?:太空|飞船)|你是.*(?:机器人|魔法师)|把咖啡馆.*(?:太空|飞船)/.test(text))return'reframe';
 if(/咖啡|猫|蛋糕|电影|音乐|天气/.test(text)&&!/委托|拍|回信|旅馆|车票|消息|旅行|决定|试住|视频/.test(text))return'smalltalk';
 return;
}
export function storyContext(state:StoryState):StoryContext{
 const last=state.history.filter(h=>h.role==='assistant').at(-1);
 let lastAskedQuestion=false;try{lastAskedQuestion=JSON.parse(last?.content??'{}').segments?.some((s:{text:string})=>/[？?]/.test(s.text))??false;}catch{}
 return{...storyView(state),allowedBeats:allowedBeats(state),lastAskedQuestion,
  summary:[...Object.values(state.cues).map(cue=>JSON.stringify({presentedStage:cue.kind,narration:cue.text,message:cue.message})),...Object.entries(state.disclosures).map(([beat,text])=>JSON.stringify({beat,fullyPresented:state.facts.includes(beat as keyof typeof factsText)||beat==='ending-'+state.ending,presentedText:text})),state.planQuote?'用户提出的具体新方案（原文数据）：'+JSON.stringify(state.planQuote):'',state.ending?'已实际呈现结局：'+state.ending:'尚无结局',state.declined?'用户拒绝参与，尊重边界，不再索要建议。':''].filter(Boolean).join('\n')};
}
export function proposalFor(reply:Reply,text:string):StoryProposal{
 const boundary=inputBoundary(text);
 const proposal=reply.story??{intent:boundary??'engage'};
 const confirming=/^(就|按|照|把).*(刚才|这个|那个|前面|办法|方案)|^就这么|^就这样/.test(text);
 const planQuote=proposal.planQuote??(proposal.intent==='alternative'&&!confirming?text.slice(0,60):undefined);
 return{...proposal,...(planQuote?{planQuote}:{}),...(boundary?{intent:boundary}:{})};
}
export function storyViolation(context:StoryContext,reply:Reply,text:string):string[] {
 const beats=reply.segments.flatMap((s,index)=>s.beat?[{beat:s.beat,index}]:[]),proposal=proposalFor(reply,text);
 if(beats.length>1)return['segments:too_big'];
 if(reply.story?.planQuote&&!text.includes(reply.story.planQuote))return['story.planQuote:invalid_value'];
 const allowedFacts=new Set([...context.facts,...beats.map(b=>b.beat)]);
 const spoken=reply.segments.map(s=>s.text).join('');
 const hiddenMarkers:[string,RegExp][]=[['commission',/第一份.{0,6}(有偿|摄影|委托)|第一次.{0,6}(有偿|收费)/],['ticket',/车票.{0,8}(已经|已|早就).{0,4}(买|订)|车票.{0,4}(买好|订好)/],['people',/(不仅|不只).{0,15}风景.{0,20}(人|住客)/],['memory',/三年前|三年以前|两天没.{0,8}说话/],['fear',/风景不会看着我/],['draft',/很擅长这类拍摄/],['phone-message',/明早需要去车站接你吗/]];
 if(hiddenMarkers.some(([fact,pattern])=>!allowedFacts.has(fact as StoryBeat)&&pattern.test(spoken)))return['segments:custom'];
 if(!context.facts.includes('photo-drift')&&reply.segments.some(s=>s.event==='reveal-photo')&&!beats.some(b=>b.beat==='photo-drift'))return['segments:custom'];
 if(!beats.length)return[];
 const {beat,index}=beats[0],path='segments.'+index+'.beat:invalid_value';
 if(context.ending)return[path];
 if((['smalltalk','clarify','reframe'].includes(proposal.intent)&&!['arrival','photo-drift','phone-message'].includes(beat)))return[path];
 if(proposal.intent==='decline'&&!(beat==='ending-c'&&context.facts.includes('commission')))return[path];
 if(beat==='ending-c'&&proposal.intent==='decline'&&context.facts.includes('commission'))return[];
 const permitted=allowedBeats({...context,planQuote:proposal.planQuote??context.planQuote});
 if(!permitted.includes(beat))return[path];
 if(beat==='ending-b'){
  const quote=proposal.planQuote??context.planQuote;
  if(!quote||!reply.segments.map(s=>s.text).join('').includes(quote))return['story.planQuote:invalid_value'];
 }
 if((beat==='ending-a'||beat==='ending-b')&&!['advice','alternative'].includes(proposal.intent))return[path];
 if(beat==='practice'&&!factComplete(beat,spoken))return[path];
 if(beat.startsWith('ending-')&&!factComplete(beat,spoken))return[path];
 return[];
}
function factComplete(beat:StoryBeat,text:string):boolean{
 switch(beat){
  case 'arrival':return text.trim().length>0;
  case 'photo-drift':case 'phone-message':return false; // Only acknowledged authored directions establish external events.
  case 'practice':return /[？?]/.test(text)&&text.length>=8;
  case 'commission':return /第一份|第一次/.test(text)&&/有偿|收钱|报酬|收费|付钱/.test(text)&&/七点|7点/.test(text)&&/旅馆/.test(text);
  case 'ticket':return /票/.test(text)&&/买|订/.test(text)&&!/还没(?:买|订)/.test(text);
  case 'people':return /风景|景色/.test(text)&&/人|住客/.test(text)&&/拍|留下/.test(text);
  case 'memory':return /三年前|三年以前/.test(text)&&/两天|二天/.test(text)&&/没|没有|不曾/.test(text)&&/说话|开口/.test(text);
  case 'fear':return /风景.*看着我/.test(text)&&/怕|担心/.test(text)&&/不愿/.test(text)&&/拍不好/.test(text);
  case 'draft':return /没问题.*我很擅长这类拍摄.*明天见/.test(text);
  case 'ending-a':return /经验/.test(text)&&/不多|少|不足/.test(text)&&/先聊|先.*聊/.test(text)&&/拍/.test(text);
  case 'ending-b':return /回信|回|告诉|决定/.test(text);
  case 'ending-c':return /婉拒|拒绝|不接|不去/.test(text)&&/白天/.test(text)&&/练习/.test(text)&&/拍照/.test(text);
 }
}
function applyBeat(state:StoryState,beat:StoryBeat){
 if(beat.startsWith('ending-')){state.ending=beat.slice(-1) as 'a'|'b'|'c';state.act='ending';return;}
 const fact=beat as keyof typeof factsText;if(!state.facts.includes(fact))state.facts.push(fact);
 state.act=state.facts.includes('fear')?'reply':state.facts.some(f=>['ticket','people','memory'].includes(f))?'hesitation':'invitation';
}
export function contextualSuggestions(state:StoryView,text='',proposal?:StoryProposal):string[]{
 if(state.ending==='a')return['这封回信听起来更像你了。','明天先跟他们聊聊吧。','等你回来，再讲给我听。'];
 if(state.ending==='b')return['这条回信保留了你的办法。','还有什么需要先问清楚？','决定以后，也可以再调整。'];
 if(state.ending==='c')return['白天我可以陪你练习拍照。','今晚先好好休息。','要再来杯咖啡吗？'];
 if(state.facts.includes('practice')&&!state.facts.includes('draft'))return['我会先看看窗外的光。','我怕被镜头盯着，不知道看哪里。','这样慢慢问，我就自在多了。'];
 if(proposal?.intent==='alternative'&&state.planQuote)return['这个办法哪部分让你安心？','还有什么需要问清楚？','也可以再想一个不同的办法。'];
 if(proposal?.intent==='decline'||state.declined)return['那就只喝咖啡吧。','我们聊聊雨吧。','如果你想好了，可以告诉我。'];
 if(proposal?.intent==='smalltalk'||inputBoundary(text)==='smalltalk')return /咖啡/.test(text)?['这杯确实适合下雨的晚上。','我更喜欢加一点奶。',state.facts.includes('phone-message')?'你刚才为什么没回消息？':'窗边坐着确实舒服。']:['听起来挺有意思，再说一点。','换个轻松的话题也很好。','你刚才提到的消息是什么？'];
 if(state.facts.includes('draft'))return['坦诚说经验不多，先聊再拍。','先视频沟通，再决定试住一天。','如果不想接，也可以拒绝。'];
 if(state.facts.includes('fear'))return['拿我练习一下，你会怎么问？','能看看你写的草稿吗？','先视频沟通，再决定去不去。'];
 if(state.facts.includes('memory'))return['独处和拍人，对你有什么不同？','你担心别人不愿意吗？','不急，先看看这张照片。'];
 if(state.facts.includes('people'))return['以前去过那里吗？','拍人让你担心什么？','我有个不同的办法。'];
 if(state.facts.includes('ticket'))return['他们希望拍什么？','你最犹豫的是哪一部分？','也可以先把需要问的写下来。'];
 if(state.facts.includes('commission'))return['你已经决定要去了吗？','为什么还没发回信？','这家旅馆怎么找到你的？'];
 if('disclosures' in state&&/拍|委托/.test((state as StoryState).disclosures.commission??''))return['是怎样的拍摄邀请？','什么让你迟迟没回信？','先慢慢讲，我在听。'];
 if(state.facts.includes('phone-message'))return['是旅馆发来的消息吗？','你看起来还没想好怎么回。','不想说也没关系。'];
 if(state.facts.includes('photo-drift'))return['给你，照片别沾到水。','这张照片是你拍的吗？','我把杯子挪开，你自己拿吧。'];
 if(state.facts.includes('arrival'))return['刚才进门时风可真大。','你桌上放的是照片吗？','我先暖暖手。'];
 return['谢谢，外面雨太大了。','你也在这里躲雨？','我就坐一会儿，不打扰你。'];
}
function safeSuggestions(values:unknown,state:StoryState):string[]|undefined{
 const parsed=suggestionSchema.safeParse(values);if(!parsed.success)return;
 const joined=parsed.data.join(' ');
 const protectedFacts:[keyof typeof factsText,RegExp][]=[['commission',/七点|7点/],['commission',/旅馆/],['commission',/第一份|第一次/],['ticket',/票已经买|已经买.*票/],['memory',/三年前|三年以前/],['memory',/两天没.*说话/],['draft',/很擅长这类拍摄/],['phone-message',/明早需要去车站接你吗/]];
 if(protectedFacts.some(([fact,pattern])=>!state.facts.includes(fact)&&pattern.test(joined)&&!pattern.test(state.disclosures[fact]??'')))return;
 if(!state.facts.includes('phone-message')&&/车站|接你|回信|委托|消息|明早/.test(joined))return;
 if(!state.ending&&/已发送|回信.*发出|已经(?:接受|拒绝)/.test(joined))return;
 if(/ending-[abc]|第一幕|第二幕|第三幕|触发结局/.test(joined))return;
 return parsed.data;
}
export type PendingStory={turnId:number;input:string;reply:Reply;proposal:StoryProposal;units:PresentationUnit[];through:number;heard:Reply['segments'];historyEntry?:History[number];suggestions?:string[]};
export function prepareStory(state:StoryState,request:TurnRequest,reply:Reply):PendingStory{
 reply=directStory(state,reply,request.text);
 const proposal=proposalFor(reply,request.text);
 return{turnId:request.turnId,input:request.text,reply,proposal,through:0,heard:[],units:presentationUnits(reply)};
}
export function acknowledgeStory(state:StoryState,pending:PendingStory,through:number):PresentationResponse|undefined{
 if(through<pending.through||through>pending.units.length)return;
 for(let i=pending.through;i<through;i++){
  const unit=pending.units[i],source=pending.reply.segments[unit.segment];
  if(unit.kind==='cue'){
   state.cues[unit.cue.kind]=unit.cue;
   if(source.beat==='photo-drift'||source.beat==='phone-message'){state.disclosures[source.beat]=unit.text+(unit.cue.message??'');applyBeat(state,source.beat);}
   if(source.beat?.startsWith('ending-')&&factComplete(source.beat,state.disclosures[source.beat]??''))applyBeat(state,source.beat);
   continue;
  }
  let heard=pending.heard[unit.segment];
  if(!heard){heard={...source,text:unit.text};delete heard.beat;delete heard.cue;pending.heard[unit.segment]=heard;}else heard.text+=unit.text;
  if(!pending.historyEntry){state.declined=pending.proposal.intent==='decline'?true:pending.proposal.intent==='smalltalk'||pending.proposal.intent==='reframe'?state.declined:false;
   if(pending.proposal.planQuote&&pending.input.includes(pending.proposal.planQuote))state.planQuote=pending.proposal.planQuote;
  }
  if(source.beat){
    state.disclosures[source.beat]=((state.disclosures[source.beat]??'')+unit.text).slice(-600);
    if(unit.last&&!source.beat.startsWith('ending-')&&factComplete(source.beat,state.disclosures[source.beat]!)){applyBeat(state,source.beat);heard.beat=source.beat;}
  }
  const content=JSON.stringify({segments:pending.heard,story:pending.proposal});
  if(!pending.historyEntry){pending.historyEntry={role:'assistant',content};state.history.push({role:'user',content:pending.input},pending.historyEntry);}else pending.historyEntry.content=content;
 }
 pending.through=through;state.history=state.history.slice(-12);
 if(through===pending.units.length&&!pending.suggestions)pending.suggestions=safeSuggestions(pending.reply.suggestions,state)??contextualSuggestions(state,pending.input,pending.proposal);
 return{turnId:pending.turnId,through,story:storyView(state),...(pending.suggestions?{suggestions:pending.suggestions}:{})};
}

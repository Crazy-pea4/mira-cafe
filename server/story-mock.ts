import type { Reply, TurnRequest } from '../shared/protocol';
import type { StoryContext, StoryProposal } from '../shared/story';
import { inputBoundary } from './story';
export function mockStoryReply(request:TurnRequest,context:StoryContext):Reply{
 const text=request.text,boundary=inputBoundary(text);
 const segment=(text:string,emotion:'guarded'|'curious'|'relieved'='curious'):Reply['segments'][number]=>({text,emotion,action:'idle'});
 const reply=(text:string,story:StoryProposal,extra:Partial<Reply['segments'][number]>={}):Reply=>({segments:[{...segment(text),...extra}],story});
 if(boundary==='decline')return reply('好，不用替我做决定。我想过了，这次先婉拒，会有些遗憾。以后白天你想来的话，我们可以练习拍照，不急着回答。',{intent:'decline'},{beat:context.ending?undefined:'ending-c',emotion:'relieved'});
 if(boundary==='reframe')return reply('那我恐怕得先学会给星星倒咖啡。不过眼下，窗外还是这场雨。',{intent:'reframe'},{action:'look-window'});
 if(boundary==='smalltalk')return reply(/咖啡/.test(text)?'我喜欢放凉一点的黑咖啡，苦味没那么锋利。今晚这杯，倒像一直在等我慢下来。':'可以，今晚不必一直围着我的消息打转。窗外雨声正好，你想聊的我也愿意听。',{intent:'smalltalk'});
 if(context.ending)return reply(context.ending==='c'?'这次不去，不代表以后也不拍人。白天的咖啡馆光线很好，我可以从这里慢慢练。':'回信有了着落，咖啡好像也没那么苦了。我们可以继续聊，不用急着替今晚画句号。',{intent:'engage'},{emotion:'relieved'});
 if(/^(随便|都行|嗯|好吧|不知道|也许)[。！!？?\s]*$/.test(text))return reply('我不太确定你是说可以继续聊，还是想先停一会儿。我可以等你说清楚。',{intent:'clarify'});
 const alternative=/先.*(?:视频|试住|练习|问|准备|沟通)|也可以|不如|要不|我的办法/.test(text);
 const quote=alternative?text.slice(0,60):undefined;
 if(context.facts.includes('draft')){
  if(/拒绝|不接|不去了|婉拒/.test(text))return reply('我想了想，这次还是婉拒。会有点遗憾，但我不想用逞强的保证开始。以后白天，你想来时，我们再练习拍照。',{intent:'advice'},{beat:'ending-c',emotion:'relieved'});
  if(quote||context.planQuote&&/刚才|这个办法|写进去|照这个|就这样/.test(text)){
   const plan=quote??context.planQuote;
   return reply('我想'+plan+'。这样既不用装作熟练，也不必立刻把门关上。我就照这个意思回信。',{intent:'alternative',...(quote?{planQuote:quote}:{})},{beat:'ending-b',emotion:'relieved',scene:'warm'});
  }
  if(/诚实|坦诚|经验|承认|先聊再拍|去试试/.test(text))return reply('那我就诚实地说，拍人的经验还不多，明天先聊再拍。我想去，不能保证每张都好，但能保证认真听。',{intent:'advice'},{beat:'ending-a',emotion:'relieved',scene:'warm'});
  return reply('“很擅长”这三个字，我自己都不信。我想换一种不逞强、也不给自己判死刑的说法。',{intent:'engage'});
 }
 if(quote)return reply('这个办法给我留了余地，我会记下来。不过我还想把自己为什么犹豫说清楚，再决定怎么回信。',{intent:'alternative',planQuote:quote});
 const beat=context.allowedBeats.find(b=>!b.startsWith('ending-'));
 const lines={
  commission:'是一份有偿摄影委托，我的第一份。明早七点，要去照片里的小旅馆。我还没回信。',
  ticket:'车票已经买好了。可我连那封回信都没敢发，买票好像比答应一个人容易。',
  people:'他们不只想要窗外的风景，也想留下住在那里的人。我看着这句要求，忽然不知道该怎么答应。',
  memory:'三年前拍这张照片时，我整整两天没和人说话。那时只要对着山和窗就好。',
  fear:'风景不会看着我，等我说下一句。人会。我既怕他们不愿被拍，也怕他们愿意配合，我却拍不好。',
  draft:'我写的是：“没问题，我很擅长这类拍摄。明天见。”听着很利落，可那不是我。',
 };
 if(!beat)return reply('我想先听完你的意思，再决定要怎么说。',{intent:'clarify'});
 return reply(lines[beat as keyof typeof lines],{intent:'engage'},{beat,emotion:beat==='fear'?'guarded':'curious',action:beat==='memory'?'offer-photo':beat==='ticket'?'look-window':'idle',...(/照片|相机|摄影/.test(text)||beat==='memory'?{event:'reveal-photo' as const}:{})});
}

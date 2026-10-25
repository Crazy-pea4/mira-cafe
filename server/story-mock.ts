import type { Reply, TurnRequest } from '../shared/protocol';
import type { StoryContext, StoryProposal } from '../shared/story';
import { inputBoundary } from './story';
export function mockStoryReply(request:TurnRequest,context:StoryContext):Reply{
 const text=request.text,boundary=inputBoundary(text),known=new Set(context.facts);
 const reply=(text:string,story:StoryProposal,extra:Partial<Reply['segments'][number]>={}):Reply=>({segments:[{text,emotion:'curious',action:'idle',...extra}],story});
 if(context.ending)return reply(context.ending==='c'?'屏幕暗下来了，倒有点舍不得。白天这里的光很好，练习拍照的约定还算数。':'发出去以后，今晚终于空下来一点。咖啡凉了，不过雨也小了。',{intent:boundary??'engage'},{emotion:'relieved'});
 if(boundary==='decline')return known.has('commission')
  ?reply('好，不用替我做决定。我想过了，这次先婉拒，会有些遗憾。以后白天你想来的话，我们可以练习拍照。',{intent:'decline'},{beat:'ending-c',emotion:'relieved'})
  :reply('好，那就坐一会儿。不用陪我聊天，雨停了再走。',{intent:'decline'},{emotion:'relieved'});
 if(boundary==='reframe')return reply('那我恐怕得先学会给星星倒咖啡。不过眼下，窗外还是这场雨。',{intent:'reframe'},{action:'laughing',emotion:'relieved'});
 if(/笑话|逗你笑|开个玩笑/.test(text))return reply('我本来想绷住的。你说得这么认真，反而更好笑了。',{intent:'smalltalk'},{emotion:'relieved',action:'laughing'});
 if(/^(随便|都行|嗯|好吧|不知道|也许)[。！!？?\s]*$/.test(text))return reply('我不太确定你的意思。是想聊下去，还是想安静坐一会儿？',{intent:'clarify'});
 const alternative=/先.*(?:视频|试住|练习|问|准备|沟通)|也可以|不如|要不|我的办法/.test(text);
 const quote=alternative?text.slice(0,60):undefined;
 const proposal:StoryProposal=quote?{intent:'alternative',planQuote:quote}:{intent:boundary??'engage'};
 if(!known.has('arrival'))return reply(/咖啡/.test(text)?'这里的黑咖啡不错。你先坐，我把杯子挪开一点。':'我来得早，刚好占了这个干燥的位置。你先暖暖手，衣角都湿了。',proposal,{beat:'arrival'});
 if(!known.has('photo-drift'))return reply(/咖啡/.test(text)?'我通常不加糖——啊，风把照片吹过去了。小心，旁边有水。':'啊，跑到你那边去了。照片边角有点旧，别沾到水就好。',proposal,{beat:'photo-drift',action:'surprised'});
 if(!known.has('phone-message'))return reply(/还|递|给你/.test(text)?'谢谢，我收好。……是那家旅馆发来的，我本来想直接回一个“好”。':/不理|自己拿|不看/.test(text)?'我自己拿就好。……旅馆那边来消息了，我本来想直接回一个“好”。':'是我拍的。……旅馆那边来消息了，我本来想直接回一个“好”。',proposal,{beat:'phone-message',action:'hesitant'});
 if(boundary==='smalltalk')return reply(/咖啡/.test(text)?'我喜欢放凉一点的黑咖啡，苦味没那么锋利。今晚这杯，倒像一直在等我慢下来。':'可以，今晚不必围着我的消息打转。你想聊的，我也愿意听。',{intent:'smalltalk'});
 if(known.has('fear')&&!known.has('practice')&&/练习|采访|你问|问我/.test(text))return reply('好，我先不举相机。你进门选座位的时候，第一眼看见的是什么？',proposal,{beat:'practice'});
 if(known.has('draft')){
  if(/拒绝|不接|不去了|婉拒/.test(text))return reply('我想了想，这次还是婉拒。会有点遗憾，但不想用逞强的保证开始。以后白天，你想来时，我们再练习拍照。',{intent:'advice'},{beat:'ending-c',emotion:'relieved'});
  if(quote||context.planQuote&&/刚才|这个办法|写进去|照这个|就这样/.test(text))return reply('我想'+(quote??context.planQuote)+'。这样不用装作熟练，也不必立刻把门关上。我就这样回信。',{intent:'alternative',...(quote?{planQuote:quote}:{})},{beat:'ending-b',emotion:'relieved'});
  if(/诚实|坦诚|经验|承认|先聊再拍|去试试/.test(text))return reply('那我就诚实地回信，拍人的经验还不多，明天先聊再拍。我想去，不能保证每张都好，但能保证认真听。',{intent:'advice'},{beat:'ending-a',emotion:'relieved'});
  return reply('“很擅长”这三个字，我自己都不信。我想换一种不逞强、也不给自己判死刑的说法。',{intent:'engage'});
 }
 if(quote)return reply('这个具体办法我记下了。它给我留了余地，不过我想先把犹豫的原因说清楚，再改那条回信。',proposal);
 const beat=context.allowedBeats.find(b=>!b.startsWith('ending-')&&b!=='practice');
 const lines={
  commission:'这是我第一份有偿摄影委托。明早七点，去照片里的小旅馆。回信还在输入框里。',
  ticket:'车票已经买好了。可我连那封回信都没敢发，买票好像比答应一个人容易。',
  people:'他们不只想要窗外的风景，也想拍住在那里的人。我看到这句要求，才停下来。',
  memory:'三年前拍这张照片时，我整整两天没和人说话。那时只要对着山和窗就好。',
  fear:'风景不会看着我，等我说下一句。人会。我既怕他们不愿被拍，也怕他们愿意配合，我却拍不好。',
  draft:(known.has('practice')?'刚才听你讲，我倒没有一直想着镜头。':'')+'草稿是：“没问题，我很擅长这类拍摄。明天见。”我把“很擅长”圈出来了，它不像我。',
 };
 if(!beat||!(beat in lines))return reply('我想先听完你的意思，再决定怎么说。',{intent:'clarify'});
 return reply(lines[beat as keyof typeof lines],{intent:'engage'},{beat,emotion:beat==='fear'?'guarded':'curious',action:beat==='memory'?'offer-photo':beat==='ticket'?'look-window':['fear','draft'].includes(beat)?'hesitant':'idle',...(beat==='memory'?{event:'reveal-photo' as const}:{})});
}

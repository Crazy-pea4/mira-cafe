import type { Reply } from '../shared/protocol';
import type { StageCue } from '../shared/stage';
import type { StoryState } from './story';
// Directions are authored locally. The model can select an eligible beat, never arbitrary UI actions.
export function directStory(state:StoryState,reply:Reply,input=''):Reply {
 const segments=reply.segments.map(segment=>{
  const {cue:_untrusted,...dialogue}=segment;
  let cue:StageCue|undefined;
  switch(segment.beat){
   case 'photo-drift':cue={kind:'photo-drift',placement:'before',text:'门被风推开一线。杯边的照片翻了个身，沿桌面滑到你手边。'};break;
   case 'phone-message':cue={kind:'phone-message',placement:'before',text:(/递|给你|还给|还你/.test(input)?'她接回照片，放在杯边。':'')+'桌上的手机亮起。Mira 打了两个字，又停住。',photoReturn:/递|给你|还给|还你/.test(input),message:'明早需要去车站接你吗？'};break;
   case 'practice':cue={kind:'practice',placement:'before',text:'她把手机扣在桌上，抬起眼睛。这次，她试着先看向镜头另一边的人。'};break;
   case 'draft':cue={kind:'draft',placement:'before',text:'Mira 把手机转过来。输入框里的一句话，已经删改了好几次。',message:'没问题，我很擅长这类拍摄。明天见。'};break;
   case 'ending-a':case 'ending-b':case 'ending-c':
    cue={kind:'reply-sent',placement:'after',text:'她重新写好那条消息，按下发送。屏幕暗下去，窗外的雨声也轻了些。',message:segment.beat==='ending-a'?'您好，我拍人的经验还不多。明天先聊一聊，再开始拍摄，可以吗？':segment.beat==='ending-c'?'谢谢邀请。很抱歉，这次我决定先不接受拍摄委托。':('我想'+(reply.story?.planQuote??state.planQuote)+'。我们按这个办法商量，可以吗？')};delete dialogue.scene;break;
  }
  if(cue&&state.cues[cue.kind])cue=undefined;
  return {...dialogue,...(cue?{cue}:{})};
 });
 if(segments.some(s=>s.cue?.kind==='reply-sent'))segments.push({text:'雨好像小了。再坐一会儿吧。',emotion:'relieved',action:'look-window'});
 return {...reply,segments};
}

import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from './core/engine';
import { MIRA_ASSETS, MOODS } from './character-assets';
import { FacialAnimation, type FaceFrame } from './core/facial-animation';
export function Character({ state }: { state: Snapshot }) {
 const [failed,setFailed]=useState(false),[frames,setFrames]=useState<FaceFrame>({blink:false,mouth:false});
 const [missing,setMissing]=useState<string[]>([]);
 const animation=useRef<FacialAnimation | null>(null);
 useEffect(()=>{
  animation.current=new FacialAnimation(setFrames,window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  return()=>{animation.current?.dispose();animation.current=null;};
 },[]);
 useEffect(()=>{animation.current?.speaking(state.status==='speaking');},[state.status,state.turnId]);
 const expression=MIRA_ASSETS.emotions[state.emotion];
 const talking=state.status==='speaking'&&frames.mouth;
 const layer=(src:string,className:string,visible=true)=>!missing.includes(src)&&<img key={src+className} className={`portrait-patch ${className} ${visible?'visible':''}`} src={src} width={1024} height={1536} alt="" draggable={false} onError={()=>setMissing(old=>[...old,src])}/>;
 return <div className={`character character-portrait action-${state.action} status-${state.status}`} role="img"
  aria-label={`Mira，身穿琥珀色雨衣、戴银色星星发夹，${MOODS[state.emotion]}`}
  data-emotion={state.emotion} data-blink={frames.blink} data-mouth={talking} data-drive={state.presentation}>
  {failed?<div className="portrait-fallback">画面暂时没加载出来<br/><small>你仍可以和 Mira 聊天</small></div>:
   <div className="portrait-canvas">
    <img className="portrait-image" src={MIRA_ASSETS.neutral} width={1024} height={1536} alt="" draggable={false} fetchPriority="high" onError={()=>setFailed(true)}/>
    {expression&&layer(expression,`expression-patch expression-${state.emotion}`)}
    {layer(MIRA_ASSETS.blink,'blink-patch',frames.blink)}
    {layer(MIRA_ASSETS.talk,'mouth-patch',talking)}
   </div>}
 </div>;
}

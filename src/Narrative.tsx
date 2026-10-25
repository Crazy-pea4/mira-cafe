import type { StageProps } from '../shared/stage';
export function Narrative({text,props,revealed=false}:{text:string;props:StageProps;revealed?:boolean}){
 return <section className="story-moment" aria-label="这一刻">
  <div className="photo-table" aria-label="窗边桌上的照片">
   <div className={`memory-card story-photo photo-${props.photoPose} ${revealed?'photo-revealed':''}`} role="img" aria-label={props.photoPose==='aside'&&!revealed?'杯边的一张照片背面':props.photoPose==='returned'?'Mira 收回杯边的照片':'滑到手边的照片：山间小旅馆'}><div className="photo-landscape"><i/><b/><em className="photo-inn"/></div><p>山间的小旅馆 <span>09 / 12</span></p></div>
  </div>
  {text&&<p className="narration" aria-live="polite">{text}</p>}
  {props.phone!=='none'&&<aside className={'story-phone phone-'+props.phone} aria-label="Mira 的手机">
   <div className="phone-top"><span>{props.phone==='resting'?'Mira 的手机':'旅馆'}</span><small>{props.phone==='resting'?'已放下':props.phone==='incoming'?'刚刚':props.phone==='draft'?'尚未发送':'已发送 ✓'}</small></div>
   {props.phone==='resting'?<div className="phone-back" aria-label="扣在桌上的手机背面"/>:<p>{props.message}</p>}
  </aside>}
 </section>;
}

import type { StageProps, PropFocus } from '../shared/stage';
export function Narrative({text,props,focus='none'}:{text:string;props:StageProps;focus?:PropFocus}){
 if(!text&&focus==='none')return null;
 const phone=focus==='phone'&&props.phone!=='none'&&props.phone!=='resting';
 return <section className="story-moment" aria-label="这一刻">
  {focus==='photo'&&<figure className={'story-photograph photo-'+props.photoPose} aria-label="Mira 的旅途照片">
   <div className="photo-landscape" role="img" aria-label="Mira 拍下的山间小旅馆"><i/><b/><em className="photo-inn"/></div>
   <figcaption><span>Mira 的旅途照片</span><strong>山间的小旅馆</strong></figcaption>
  </figure>}
  {text&&<p className="narration" aria-live="polite">{text}</p>}
  {phone&&<aside className={'story-phone phone-'+props.phone} aria-label="Mira 的手机">
   <div className="phone-owner">Mira 的手机</div>
   <div className="phone-top"><span>{props.phone==='incoming'?'旅馆来信':'写给旅馆'}</span><small>{props.phone==='incoming'?'未回复':props.phone==='draft'?'草稿':'已发送 ✓'}</small></div>
   <p>{props.message}</p>
  </aside>}
 </section>;
}

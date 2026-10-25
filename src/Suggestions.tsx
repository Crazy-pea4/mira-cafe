export function Suggestions({values,onChoose}:{values:readonly string[];onChoose:(text:string)=>void}){
 if(!values.length)return null;
 return <div className="suggestions" aria-label="可选的下一句回应">{values.map((value,index)=><button type="button" key={value} aria-label={'建议回应：'+value} onClick={()=>onChoose(value)}><span>0{index+1}</span>{value}<b>↗</b></button>)}</div>;
}

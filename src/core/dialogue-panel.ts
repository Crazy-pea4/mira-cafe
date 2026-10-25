// Visibility owns no dialogue/audio state; only hidden input must be cancelled.
export class DialoguePanel {
 private collapsed=false;
 private listeners=new Set<()=>void>();
 constructor(private cancelInput:()=>void){}
 getSnapshot=()=>this.collapsed;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 toggle=()=>{
  const next=!this.collapsed;
  if(next)this.cancelInput();
  this.collapsed=next;
  for(const listener of this.listeners)listener();
 };
}

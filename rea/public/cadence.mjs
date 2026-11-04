// Match presentation consumption to the source clock. A 60-Hz display and a
// 59.9227-Hz NTSC source otherwise drain a fixed jitter buffer over a long run.
// This schedules captured frames only; it never invents or repeats a capture.
export class FramePacer {
  reset(){this.last=undefined;this.budget=0;}
  constructor(){this.reset();}
  tick(now,sourceHz=60,limitHz=60){
    const hz=Math.min(limitHz,Number.isFinite(sourceHz)&&sourceHz>0?sourceHz:60),period=1000/hz;
    const elapsed=this.last===undefined?0:Math.max(0,now-this.last);this.last=now;
    this.budget=Math.min(this.budget+elapsed,period*2);
    if(this.budget<period-0.01)return false;
    this.budget-=period;return true;
  }
}

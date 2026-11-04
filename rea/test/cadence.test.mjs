import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FramePacer} from '../public/cadence.mjs';

test('NTSC presentation follows the source clock without draining its jitter buffer',()=>{
  const source=53693175/(3420*262),pacer=new FramePacer();
  for(const display of [60,59.94,120,144]){
    pacer.reset();let consumed=0,minQueue=4,maxQueue=4;
    for(let tick=0;tick<=display*600;tick++){
      const now=tick*1000/display;
      if(pacer.tick(now,source,60))consumed++;
      const queue=4+Math.floor(now*source/1000)-consumed;
      minQueue=Math.min(minQueue,queue);maxQueue=Math.max(maxQueue,queue);
    }
    assert.ok(minQueue>=3&&maxQueue<=5,`${display} Hz display: queue ${minQueue}..${maxQueue}`);
    assert.ok(Math.abs(consumed-source*600)<=1);
  }
});
test('lower refresh limits and PAL consume only the requested number of frames',()=>{
  for(const [source,limit,expected] of [[59.9227,30,300],[59.9227,15,150],[49.701,60,497]]){
    const pacer=new FramePacer();let count=0;
    for(let i=0;i<=1440;i++)if(pacer.tick(i*1000/144,source,limit))count++;
    assert.ok(Math.abs(count-expected)<=1,`${source}/${limit}: ${count}`);
  }
});
test('stall and freeze reset do not accumulate an unbounded catch-up burst',()=>{
  const pacer=new FramePacer();pacer.tick(0);assert.equal(pacer.tick(10000),true);
  assert.equal(pacer.tick(10000),true);assert.equal(pacer.tick(10000),false);
  pacer.reset();assert.equal(pacer.tick(20000),false);assert.equal(pacer.tick(20017),true);
});

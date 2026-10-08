import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlayback,PACKET_DURATION} from './playback.js';
function setup() {
 const element=()=>Object.assign(new EventTarget(),{value:'1',textContent:'',setAttribute(k,v){this[k]=v;}});
 const speed=element(),pause=element(),output=element();
 const document=Object.assign(new EventTarget(),{hidden:false,body:{classList:{toggle(){}}},querySelector(selector){return selector.includes('speed-control')?speed:selector.includes('pause-button')?pause:output;}});
 let now=0,id=0;const frames=new Map();
 globalThis.document=document;globalThis.matchMedia=()=>({matches:false});
 Object.defineProperty(globalThis,'performance',{value:{now:()=>now},configurable:true});
 globalThis.requestAnimationFrame=fn=>{frames.set(++id,fn);return id;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
 const clock=createPlayback();
 return {clock,speed,pause,document,advance(ms){now+=ms;const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn(now));},setSpeed(value){speed.value=String(value);speed.dispatchEvent(new Event('input'));}};
}
test('one packet duration; shared clock applies speed changes during a wait',async()=>{
 assert.equal(PACKET_DURATION,1800);const t=setup();let done=false;const wait=t.clock.wait(200).then(()=>done=true);
 t.setSpeed(.5);t.advance(100);await Promise.resolve();assert.equal(done,false);
 t.setSpeed(1.5);t.advance(100);await wait;assert.equal(done,true);
});
test('manual pause persists through hidden tab; hidden tab pauses and resumes automatically',async()=>{
 const t=setup();let progress=0;const wait=t.clock.wait(200,{progress:f=>progress=f});
 t.advance(100);assert.equal(progress,.5);t.pause.dispatchEvent(new Event('click'));t.advance(100);assert.equal(progress,.5);
 t.document.hidden=true;t.document.dispatchEvent(new Event('visibilitychange'));t.document.hidden=false;t.document.dispatchEvent(new Event('visibilitychange'));assert.equal(t.clock.paused,true);
 t.pause.dispatchEvent(new Event('click'));t.document.hidden=true;t.document.dispatchEvent(new Event('visibilitychange'));t.advance(100);assert.equal(progress,.5);
 t.document.hidden=false;t.document.dispatchEvent(new Event('visibilitychange'));assert.equal(t.clock.paused,false);t.advance(100);await wait;
});
test('scene cancellation rejects immediately while paused and removes its frame',async()=>{
 const t=setup(),controller=new AbortController();t.pause.dispatchEvent(new Event('click'));const wait=t.clock.wait(1800,{signal:controller.signal});controller.abort();await assert.rejects(wait,{name:'AbortError'});t.advance(100);
});
test('Motion and native animations share pause and playback rates, and release after completion',async()=>{
 const t=setup();let finish;const finished=new Promise(r=>finish=r);
 const animation=()=>({finished,playing:true,pause(){this.playing=false;},play(){this.playing=true;}});
 const motion=animation(),native=animation();t.clock.track(motion);t.clock.track(native,'playbackRate');t.setSpeed(.5);assert.equal(motion.speed,.5);assert.equal(native.playbackRate,.5);
 t.pause.dispatchEvent(new Event('click'));assert.equal(motion.playing,false);assert.equal(native.playing,false);t.setSpeed(1.5);assert.equal(native.playing,false);
 t.pause.dispatchEvent(new Event('click'));assert.equal(motion.playing,true);finish();await finished;await Promise.resolve();t.setSpeed(1);assert.equal(motion.speed,1.5);
});

import test from "node:test";
import assert from "node:assert/strict";
import { recordProgress, displayRecordProgress } from "./record-progress.js";
const record = {partition:1,offset:4};
test("wait for every independent group, using committed NEXT on the record partition",()=>{
 const options={groups:["orders","finance","message"],nextByGroup:{orders:[99,5],finance:[99,4],message:[99,5]}};
 assert.deepEqual(recordProgress(record,options),{status:"pending",pending:["finance"]});
 options.nextByGroup.finance[1]=5;assert.equal(recordProgress(record,options).status,"committed");
});
test("unknown offsets and no tracked groups cannot imply completion",()=>{
 assert.equal(recordProgress(record,{groups:["finance"],nextByGroup:{finance:[5,null]}}).status,"pending");
 assert.equal(recordProgress(record,{groups:[],nextByGroup:{}}).status,"pending");
});
test("failure and commit-before-processing never look successfully completed",()=>{
 const options={groups:["finance"],nextByGroup:{finance:[0,5]}};
 assert.equal(recordProgress(record,{...options,processed:false}).status,"pending");
 assert.equal(recordProgress(record,{...options,failed:true}).status,"failed");
 assert.equal(recordProgress(record,options).status,"committed");
});

test("grey-out uses shared playback without repeating on repaint or blocking the flow",()=>{
 const scope={}, animations=[];
 const playback={duration:n=>n,track:(animation,rate)=>animations.push({animation,rate})};
 const dot=()=>({dataset:{},classList:{add(){},remove(){}},title:"",animate:(frames,options)=>({frames,options})});
 const options={groups:["finance"],nextByGroup:{finance:[0,4]},scope,playback};
 displayRecordProgress(dot(),record,options);assert.equal(animations.length,0);
 options.nextByGroup.finance[1]=5;
 const completed=dot();displayRecordProgress(completed,record,options);
 assert.equal(completed.dataset.progress,"committed");assert.equal(animations.length,1);
 assert.equal(animations[0].rate,"playbackRate");assert.equal(animations[0].animation.options.duration,350);
 displayRecordProgress(dot(),record,options);assert.equal(animations.length,1);
});

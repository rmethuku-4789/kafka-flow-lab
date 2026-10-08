import test from 'node:test';
import assert from 'node:assert/strict';
import {createModel,appendRecord,appendDeadLetter,commitRecord,applyEffect,registerSchema,jsonSchemaV1,jsonSchemaV2,incompatibleJsonSchema,validatesJson} from './continuation-model.js';
test('Producer business identity is independent of partition and offset',()=>{
  const a=createModel(),b=createModel();
  assert.equal(appendRecord(a,0).eventId,appendRecord(b,1).eventId);
  const explicit=appendRecord(a,1,{eventId:'dispute-49328:created'});
  assert.equal(explicit.eventId,'dispute-49328:created');
});
test('DLQ preserves the poison source identity and payload without committing or applying it',()=>{
  const m=createModel(),r=appendRecord(m,0,{eventId:'dispute-49328:created',payload:{dispute_id:49328,reason:'unsupported'}});
  m.retryAttempts[0]=3;
  const dlq=appendDeadLetter(m,r);
  assert.equal(dlq.sourceOffset,0);assert.equal(dlq.partition,0);assert.equal(dlq.offset,0);
  assert.equal(dlq.eventId,r.eventId);assert.deepEqual(dlq.payload,r.payload);
  assert.equal(dlq.error,'UnsupportedBusinessValue');assert.equal(dlq.attempts,3);
  assert.deepEqual(m.next,[0,0]);assert.deepEqual(m.effects,{});
  r.payload.reason='changed';assert.equal(dlq.payload.reason,'unsupported');
});
test('Independent partition commits preserve order; atomic handler dedup keeps one effect',()=>{
  const m=createModel(),r=appendRecord(m,0),following=appendRecord(m,0);
  assert.throws(()=>commitRecord(m,following),/partition order/);
  assert.equal(applyEffect(m,r,true),true);assert.equal(applyEffect(m,r,true),false);
  assert.equal(m.effects[r.eventId],1);assert.deepEqual(m.handled,[r.eventId]);
  commitRecord(m,r);assert.deepEqual(m.next,[1,0]);
});

test('Selected STRICT/BACKWARD closed JSON optional addition passes; required rename fails without registration',()=>{
 const m=createModel();assert.equal(registerSchema(m,jsonSchemaV1).id,1);
 assert.equal(registerSchema(m,jsonSchemaV2).id,2);assert.equal(registerSchema(m,incompatibleJsonSchema).status,409);
 assert.equal(m.schemas.length,2);assert.equal(registerSchema(m,jsonSchemaV1).id,1);
 const v1={dispute_id:12345,order_id:98765,reason:'object_not_received'},v2={...v1,note:'investigate'};
 assert.equal(validatesJson(jsonSchemaV2,v1),true);assert.equal(validatesJson(jsonSchemaV2,v2),true);
 assert.equal(validatesJson(jsonSchemaV1,v2),false);assert.equal(validatesJson(jsonSchemaV1,{order_dispute_id:12345,order_id:98765,reason:'object_not_received'}),false);
 assert.equal(validatesJson(jsonSchemaV2,{...v2,note:17}),false);
});

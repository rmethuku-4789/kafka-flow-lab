import assert from 'node:assert/strict';
import test from 'node:test';
import {partitionForKey} from './groups-partitioning.js';
test('partition calculation matches Apache Kafka UtilsTest Murmur2 vectors',()=>{
 const vectors=[['21',-973932308],['foobar',-790332482],['a-little-bit-long-string',-985981536],['a-little-bit-longer-string',-1486304829],['lkjh234lh9fiuh90y23oiuhsafujhadof229phr9h19h89h8',-58897971],['abc',479470107]];
 for(const[key,hash]of vectors)for(const count of [2,3,7,31,2147483648])assert.equal(partitionForKey(key,count),(hash&0x7fffffff)%count);
});

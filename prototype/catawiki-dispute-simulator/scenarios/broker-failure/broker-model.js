// Synthetic Kafka 4.2 model: one partition, one in-flight producer batch, clean ISR election,
// ELR disabled, and an available KRaft controller quorum. No Kafka transactions.
const copy = value => structuredClone(value);
const liveISR = state => state.isr.filter(id => state.alive[id]);
const sameSequence = (a,b) => a.producerId===b.producerId && a.epoch===b.epoch && a.sequence===b.sequence && a.partition===b.partition;
const event = (state,phase,details={}) => state.journal.push({phase,...details});

export function createState({replicationFactor=3,minISR=2,acks='all',idempotent=true}={}) {
  if(idempotent && acks!=='all') throw new Error('ConfigException: idempotence requires acks=all');
  return {config:{replicationFactor,minISR,acks,idempotent},logs:[[],[],[]],alive:[0,1,2].map(id=>id<replicationFactor),isr:Array.from({length:replicationFactor},(_,id)=>id),leader:0,metadata:{producer:0,consumer:0,coordinator:0},coordinator:0,highWatermark:0,replicaHW:[0,0,0],position:0,committedNext:0,acknowledgedNext:0,effects:[],journal:[]};
}

export function appendLeader(input,record) {
  const state=copy(input),leader=state.leader;
  if(leader===null || !state.alive[leader]) throw new Error('LeaderNotAvailable');
  if(state.config.acks==='all' && liveISR(state).length<state.config.minISR) throw new Error('NotEnoughReplicas');
  if(state.config.idempotent) {
    if(record.producerId===undefined || !Number.isInteger(record.epoch) || !Number.isInteger(record.sequence)) throw new Error('Missing producer identity, epoch or sequence');
    const entries=state.logs[leader].filter(r=>r.producerId===record.producerId&&r.partition===(record.partition??0));
    const latestEpoch=Math.max(-1,...entries.map(r=>r.epoch));
    if(record.epoch<latestEpoch) throw new Error('InvalidProducerEpoch');
    const current=entries.filter(r=>r.epoch===record.epoch);
    const previous=current.slice(-5).find(r=>sameSequence(r,{...record,partition:record.partition??0}));
    if(previous){event(state,'duplicate',{offset:previous.offset,producerId:record.producerId,epoch:record.epoch,sequence:record.sequence});return {state,record:copy(previous),duplicate:true};}
    const next=current.length ? current.at(-1).sequence+1 : 0;
    if(record.sequence!==next) throw new Error('OutOfOrderSequenceNumber');
  }
  const stored={...copy(record),partition:record.partition??0,offset:state.logs[leader].length};
  state.logs[leader].push(stored);event(state,'append',{broker:leader,offset:stored.offset,eventId:stored.eventId,producerId:stored.producerId,epoch:stored.epoch,sequence:stored.sequence});
  return {state,record:copy(stored),duplicate:false};
}

export function replicateRecord(input,follower,offset) {
  const state=copy(input);
  if(!state.alive[follower] || !state.isr.includes(follower) || follower===state.leader) throw new Error('UnavailableReplica');
  const record=state.logs[state.leader]?.[offset];
  if(!record || state.logs[follower].length!==offset) throw new Error('ReplicaOffsetGap');
  state.logs[follower].push(copy(record));event(state,'replicated',{broker:follower,offset});return state;
}

export function confirmReplication(input) {
  const state=copy(input),isr=liveISR(state);
  if(isr.length<state.config.minISR) throw new Error('NotEnoughReplicasAfterAppend');
  const hw=Math.min(...isr.map(id=>state.logs[id].length));
  state.highWatermark=Math.max(state.highWatermark,hw);
  state.replicaHW[state.leader]=state.highWatermark;
  event(state,'replication-confirmed',{highWatermark:state.highWatermark});return state;
}

export function learnHighWatermark(input,follower) {
  const state=copy(input);if(!state.alive[follower] || !state.isr.includes(follower))throw new Error('UnavailableReplica');
  state.replicaHW[follower]=Math.min(state.highWatermark,state.logs[follower].length);event(state,'follower-hw',{broker:follower,highWatermark:state.replicaHW[follower]});return state;
}

export function acknowledgeRecord(input,record) {
  const state=copy(input),mode=state.config.acks;
  if(mode==='0'){event(state,'send-complete',{offset:-1,response:false});return {state,response:null};}
  if(state.leader===null || !state.alive[state.leader] || !state.logs[state.leader][record.offset]) throw new Error('LeaderNotAvailable');
  if(mode==='all') {
    if(liveISR(state).length<state.config.minISR) throw new Error('NotEnoughReplicas');
    if(record.offset>=state.highWatermark || !liveISR(state).every(id=>state.logs[id][record.offset]?.eventId===record.eventId)) throw new Error('ReplicationIncomplete');
  }
  event(state,'producer-ack',{acks:mode,offset:record.offset});return {state,response:{acks:mode,offset:record.offset}};
}

export function failBroker(input,failed) {
  const state=copy(input);state.alive[failed]=false;state.isr=state.isr.filter(id=>id!==failed);
  if(state.leader===failed)state.leader=null;
  event(state,'broker-failed',{broker:failed});return state;
}

export function electLeader(input,candidate) {
  const state=copy(input),eligible=liveISR(state).filter(id=>state.logs[id].length>=state.highWatermark);
  const chosen=candidate??eligible[0];
  if(!eligible.includes(chosen)) throw new Error('NoEligibleInSyncReplica');
  state.leader=chosen;state.replicaHW[chosen]=state.highWatermark;event(state,'leader-elected',{broker:chosen,highWatermark:state.highWatermark});return state;
}

export function refreshMetadata(input,client,metadataBroker) {
  const state=copy(input);
  if(!['producer','consumer'].includes(client))throw new Error('UnknownClient');
  if(!state.alive[metadataBroker] || state.leader===null || !state.alive[state.leader])throw new Error('MetadataUnavailable');
  state.metadata[client]=state.leader;event(state,'metadata-refreshed',{client,broker:state.leader,via:metadataBroker});return state;
}

// The offset-topic partition and its records are assumed replicated separately. Its
// coordinator migrates independently of the disputes partition leader in this example.
export function rediscoverCoordinator(input,broker) {
  const state=copy(input);if(!state.alive[broker])throw new Error('CoordinatorNotAvailable');
  state.coordinator=broker;state.metadata.coordinator=broker;event(state,'coordinator-discovered',{broker});return state;
}

export function availableRecords(state) {
  if(state.leader===null || !state.alive[state.leader])return [];
  return copy(state.logs[state.leader].filter(r=>r.offset>=state.position&&r.offset<state.highWatermark));
}

export function receiveRecord(input,record) {
  const state=copy(input);
  if(state.metadata.consumer!==state.leader || !availableRecords(state).some(r=>r.offset===record.offset) || record.offset!==state.position)throw new Error('RecordNotAvailable');
  state.position=record.offset+1;event(state,'received',{offset:record.offset,eventId:record.eventId});return state;
}

export function completeProcessing(input,record) {
  const state=copy(input);if(record.offset>=state.position || record.offset>=state.highWatermark)throw new Error('RecordNotReceived');
  state.effects.push({offset:record.offset,eventId:record.eventId});event(state,'processed',{offset:record.offset,eventId:record.eventId});return state;
}

export function storeCommit(input,next) {
  const state=copy(input);
  if(!state.alive[state.coordinator] || state.metadata.coordinator!==state.coordinator)throw new Error('CoordinatorNotAvailable');
  if(next<state.committedNext || next>state.position || !state.effects.some(e=>e.offset===next-1))throw new Error('UnprocessedCommit');
  state.committedNext=next;event(state,'commit-stored',{next,broker:state.coordinator});return state;
}

export function acknowledgeCommit(input) {
  const state=copy(input);state.acknowledgedNext=state.committedNext;event(state,'commit-ack',{next:state.acknowledgedNext});return state;
}

import { displayRecordProgress } from "../../shared/scripts/record-progress.js";
import { createPlayback, PACKET_DURATION } from "../../shared/scripts/playback.js";
import * as model from './broker-model.js';
let snapshot = () => null;
export const simulationSnapshot = () => structuredClone(snapshot());
if (typeof document !== 'undefined') startSimulator();
function startSimulator() {
  const select = selector => document.querySelector(selector);
  const stage = select('#failure-stage');
  const broker = index => select('[data-broker="'+index+'"]');
  const paths = new Map();
  const headings = ['One broker', 'Replicate All · healthy delivery', 'Acknowledgement comparison', 'Leader failure · rediscovery', 'Insufficient ISR'];
  let state, scene=0, subphase=0, phase='starting', playing=false;
  const playbackControls=createPlayback();
  let paused=playbackControls.paused;
  let controller=new AbortController();
  let comparisons=['NOT RUN','NOT RUN','NOT RUN'];
  let healthyCheckpoint=null;
  snapshot=()=>({state,scene,subphase,phase,playing,paused,comparisons});
  function active(signal) {
    if (signal.aborted) throw new DOMException("Scene changed", "AbortError");
  }

  function interval(duration, signal, progress = () => {}) {
    return playbackControls.wait(duration, {signal, progress});
  }

  function anchor(element, side) {
    const bounds = stage.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return { x: (side === "left" ? rect.left : side === "right" ? rect.right : rect.left + rect.width / 2) - bounds.left,
      y: rect.top + rect.height / 2 - bounds.top };
  }

  function addPath(name, description, control = false) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
    element.setAttribute("d", description);
    element.dataset.route = name;
    element.setAttribute("class", `connection-path${control ? " is-control" : ""}`);
    select("#paths").append(element);
    paths.set(name, element);
  }

  function drawRoutes() {
    select("#paths").replaceChildren();
    paths.clear();
    const rect = stage.getBoundingClientRect();
    select(".connections").setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    select(".connections").setAttribute("preserveAspectRatio", "none");
    const leader = state.leader ?? 0;
    const producer = anchor(select("#producer"), "right");
    const destination = anchor(broker(state.metadata.producer ?? 0), "left");
    const clusterLeft = anchor(select("#cluster"), "left").x;
    if (!(state.config.replicationFactor > 1)) destination.x = clusterLeft;
    const middle = (producer.x + clusterLeft) / 2;
    addPath("produce", `M ${producer.x} ${producer.y} H ${middle} V ${destination.y} H ${destination.x}`);
    const source = anchor(broker(state.metadata.consumer ?? 0), "right");
    if (!(state.config.replicationFactor > 1)) source.x = anchor(select("#cluster"), "right").x;
    const finance = anchor(select("#finance"), "left");
    const spine = (anchor(select("#cluster"), "right").x + finance.x) / 2;
    addPath("finance", `M ${source.x} ${source.y} H ${spine} V ${finance.y} H ${finance.x}`);
    for (const service of ["orders", "message-center"]) {
      const target = anchor(select(`#${service}`), "left");
      addPath(service, `M ${spine} ${finance.y} V ${target.y} H ${target.x}`);
    }
    const coord = anchor(select("#coordinator"), "right");
    addPath("commit", "M "+coord.x+" "+coord.y+" H "+spine+" V "+finance.y+" H "+finance.x, true);
    if ((state.config.replicationFactor > 1)) {
      const lane = clusterLeft + 30;
      const replicationSource = anchor(broker(leader), "left");
      for (const replica of state.isr.filter((index) => index !== leader)) {
        const follower = anchor(broker(replica), "left");
        addPath(`replica-${replica}`, `M ${replicationSource.x} ${replicationSource.y} H ${lane} V ${follower.y} H ${follower.x}`);
      }
      if (scene === 3) {
        const metadataLeft = anchor(broker(2), "left");
        const metadataRight = anchor(broker(2), "right");
        addPath("producer-metadata", `M ${producer.x} ${producer.y} H ${middle} V ${metadataLeft.y} H ${metadataLeft.x}`, true);
        addPath("consumer-metadata", `M ${metadataRight.x} ${metadataRight.y} H ${spine} V ${finance.y} H ${finance.x}`, true);
      }
    }
  }

  async function fly(name, label, signal, reverse = false, end = 1, duration = PACKET_DURATION) {
    const token = document.createElement("div");
    token.className = `packet${name.includes("metadata") || name === "commit" || label.startsWith("ACK") ? " is-control" : ""}`;
    token.dataset.route = name;
    const dot = document.createElement("i");
    const text = document.createElement("small");
    text.textContent = label;
    token.append(dot, text);
    stage.append(token);
    try {
      await interval(duration, signal, (fraction) => {
        const route = paths.get(name);
        if (!route) throw new Error(`Missing route ${name}`);
        const point = route.getPointAtLength(route.getTotalLength() * (reverse ? 1 - fraction * end : fraction * end));
        token.style.transform = `translate(${point.x - 6.5}px,${point.y - 6.5}px)`;
        const cluster = select("#cluster");
        const labelLane = name.startsWith("replica-") ? anchor(cluster, "left").x + 30 : name === "produce" || name === "producer-metadata"
          ? (anchor(select("#producer"), "right").x + anchor(cluster, "left").x) / 2
          : (anchor(cluster, "right").x + anchor(select("#finance"), "left").x) / 2;
        text.style.left = `${labelLane - point.x + 6.5}px`;
        text.style.transform = "translateX(-50%)";
        route.classList.toggle("is-control", token.classList.contains("is-control"));
        route.classList.add("is-active");
      });
    } finally {
      token.remove();
      if (!signal.aborted) {
        paths.get(name)?.classList.remove("is-active");
        paths.get(name)?.classList.toggle("is-control", name.includes("metadata") || name === "commit");
      }
    }
  }


  function renderLogs() {
    for(const id of [0,1,2]) {
      const card=broker(id);card.hidden=id>=state.config.replicationFactor;
      card.classList.toggle('is-leader',state.leader===id&&state.alive[id]);card.classList.toggle('is-down',!state.alive[id]);
      card.querySelector('.broker-role').textContent=!state.alive[id]?'DOWN':state.leader===id?'LEADER':'ISR FOLLOWER';
      card.querySelector('.replica-state').textContent=!state.alive[id]?'OFFLINE':state.isr.includes(id)?'IN SYNC':'OUT OF ISR';
      card.querySelector('.log-end').textContent='Records '+state.logs[id].length;
      card.querySelector('.record-count').textContent=String(state.logs[id].length);
      const window=card.querySelector('.record-window');window.replaceChildren();
      for(const record of state.logs[id].slice(-3)) {
        const entry=document.createElement('span');entry.className='stored-record';entry.dataset.recordId=record.eventId;entry.dataset.offset=String(record.offset);
        entry.title='P0:'+record.offset+' · '+record.eventId;
        const dot=document.createElement('span');dot.className='record-dot';dot.textContent=String(record.offset);
        displayRecordProgress(dot,{...record,partition:0},{scope:window,playback:playbackControls,groups:['finance'],nextByGroup:{finance:[state.acknowledgedNext]}});
        const label=document.createElement('small');label.textContent='CREATED';entry.append(dot,label);window.append(entry);
      }
    }
    select('#cluster-caption span').textContent='RF '+state.config.replicationFactor+' · MIN ISR '+state.config.minISR+' · ISR '+state.isr.length;
    select('#finance-next').textContent='P0 · NEXT '+state.acknowledgedNext+' · LAG '+Math.max(0,state.logs[state.leader??0].length-state.acknowledgedNext);
    select('#cluster-offset').textContent='P0 · NEXT '+state.committedNext;
    select('.coordinator-heading strong').textContent='GROUP COORDINATOR · BROKER '+(state.coordinator+1);
    select('.coordinator-heading span').textContent=state.alive[state.coordinator]?'OFFSETS READY':'OFFLINE · OFFSETS RETAINED';
    select('#producer-metadata').textContent='KNOWN LEADER B'+(state.metadata.producer+1);
    select('#consumer-metadata').textContent='LEADER B'+(state.metadata.consumer+1)+' · COORD B'+(state.metadata.coordinator+1);
    select('#producer-config').textContent=(state.config.replicationFactor===1?'RF 1 · MIN ISR 1 · ':'')+'acks='+state.config.acks;
    document.querySelectorAll('[data-ack-mode]').forEach((row,id)=>{row.classList.toggle('is-selected',id===subphase);row.querySelector('strong').textContent=comparisons[id];});
  }
  function playback() {
    select('#pause').textContent=paused?'▶ Resume':'Ⅱ Pause';select('#pause').setAttribute('aria-pressed',String(paused));
    select('#live span').textContent=document.hidden?'PAUSED · tab hidden':paused?'PAUSED':playing?'PLAYING':'WAITING';select('#live').classList.toggle('is-paused',paused);
  }
  function step(name,caption,kind='THE KAFKA WAY') {
    phase=name;stage.dataset.phase=name;
    if(caption){select('#prompt-label').textContent=kind;select('#scene-prompt').textContent=caption;}
    renderLogs();
  }
  function status(producer,finance) {
    if(producer)select('#producer-state').textContent=producer;
    if(finance){select('#finance-state').textContent=finance;select('#member-state').textContent=finance;}
  }
  const record=sequence=>({eventId:'dispute-'+(49328+sequence)+':created',producerId:42,epoch:0,sequence,partition:0});
  async function append(event,signal,retry=false) {
    select('#producer').dataset.activity=retry?'retry':'idle';status(retry?'RETRYING':'PUBLISHING');select('#event-identity').textContent=event.eventId;
    select('#producer-identity').textContent='';
    select('#event-card').classList.add('is-active');step(retry?'retry-send':'producer-send',retry?'The producer retries the unwritten record to the new leader.':scene===1?'The producer sends one new record to the partition leader.':null);
    await fly('produce',retry?'RETRY P0':'SEND P0',signal);active(signal);
    const result=model.appendLeader(state,event);state=result.state;
    select('#producer-result').textContent=result.duplicate?'duplicate, already written':'';
    step(result.duplicate?'duplicate':'leader-append',result.duplicate?'Same PID, epoch and partition sequence: duplicate, already written. No extra log entry.':null);status('AWAITING ACK',result.record.offset<state.highWatermark?'READY TO POLL':'WAITING FOR REPLICAS');await interval(900,signal);return result.record;
  }
  async function replicate(stored,signal) {
    for(const follower of state.isr.filter(id=>id!==state.leader)) {
      step('follower-'+follower+'-fetch','Follower broker '+(follower+1)+' fetches the record from the leader.');await fly('replica-'+follower,'FETCH P0',signal,true);
      step('follower-'+follower+'-record');await fly('replica-'+follower,'P0:'+stored.offset,signal);
      active(signal);state=model.replicateRecord(state,follower,stored.offset);renderLogs();
      step('follower-'+follower+'-confirm');await fly('replica-'+follower,'FETCH · COPIED',signal,true);
    }
    active(signal);state=model.confirmReplication(state);status(null,'READY TO POLL');step('high-watermark','All in-sync replicas have the record. Finance can read it; producer confirmation is separate.');
    for(const follower of state.isr.filter(id=>id!==state.leader)) {
      await fly('replica-'+follower,'REPLICATION READY',signal);active(signal);state=model.learnHighWatermark(state,follower);renderLogs();
    }
  }
  async function ack(stored,signal,lost=false,duration=PACKET_DURATION) {
    state=model.acknowledgeRecord(state,stored).state;step(lost?'lost-ack-flight':'producer-ack',scene===1?'All in-sync replicas have the record. The leader sends ACK · acks=all to the producer.':null);
    await fly('produce','ACK · acks='+state.config.acks,signal,true,lost?.55:1,duration);
    active(signal);status(lost?'ACK LOST':'ACKNOWLEDGED');select('#producer').dataset.activity=lost?'error':'idle';select('#event-card').classList.remove('is-active');
    if(lost)step('ack-lost','The record is replicated, but its acknowledgement response was lost.','WHAT CAN GO WRONG');
  }
  async function consume(stored,signal) {
    status(null,'POLLING');step('consumer-poll','Finance fetches the replicated record. It does not depend on the producer receiving its ACK.');await fly('finance','POLL P0',signal,true);
    step('consumer-record');await fly('finance','P0:'+stored.offset,signal);active(signal);state=model.receiveRecord(state,stored);
    select('#finance-record').textContent='P0:'+stored.offset+' · '+stored.eventId;status(null,'PROCESSING');select('#finance').dataset.activity='processing';step('processing');
    await interval(2000,signal,f=>select('#processing-fill').style.width=(f*100)+'%');active(signal);state=model.completeProcessing(state,stored);
    status(null,'COMMITTING');step('commit','The group coordinator is a role hosted on a broker. It stores the client’s committed NEXT.');
    await fly('commit','COMMIT NEXT '+(stored.offset+1),signal,true);active(signal);state=model.storeCommit(state,stored.offset+1);
    step('commit-ack');await fly('commit','COMMIT ACK '+(stored.offset+1),signal);active(signal);state=model.acknowledgeCommit(state);
    status(null,'PROCESSED');select('#finance').dataset.activity='idle';select('#processing-fill').style.width='0%';step('completed');
  }
  // ACK and Finance fetch run independently, using the same packet timing.
  async function deliver(stored,signal) {await Promise.all([ack(stored,signal),consume(stored,signal)]);}
  async function cycle(sequence,signal) {const stored=await append(record(sequence),signal);await replicate(stored,signal);await deliver(stored,signal);return stored;}
  async function election(signal) {
    step('election','An in-sync replica takes over as leader. Clients will refresh metadata and retry.');
    await interval(2200,signal);active(signal);state=model.electLeader(state);renderLogs();drawRoutes();await interval(900,signal);
  }

  async function run(signal) {
    if(scene===0) {
      await cycle(0,signal);step('failure-send');status('PUBLISHING');select('#event-identity').textContent=record(1).eventId;select('#producer-identity').textContent='';
      await fly('produce','SEND P0',signal,false,.55);active(signal);state=model.failBroker(state,0);status('CONNECTION FAILED','UNAVAILABLE');select('#producer').dataset.activity='error';
      step('unavailable','The only broker is down. Delivery and Finance reads stop. What would you do?','');return;
    }
    if(scene===1){for(let sequence=0;;sequence++){await cycle(sequence,signal);healthyCheckpoint=structuredClone(state);step('replication-complete','Healthy replication continues. Next demonstrates leader failure.');await interval(1600,signal);}}
    if(scene===2) {
      const event=record(0);let stored;
      if(subphase===0){
        status('SENT · NO ACK');select('#event-identity').textContent=event.eventId;state=model.acknowledgeRecord(state,event).state;
        step('send-complete','acks=0: the producer considers the buffer sent; there is no broker response.');
        await fly('produce','SEND · NO ACK',signal);active(signal);const result=model.appendLeader(state,event);state=result.state;stored=result.record;step('leader-append');await interval(900,signal);
      } else {stored=await append(event,signal);if(subphase===2)await replicate(stored,signal);await ack(stored,signal);}
      active(signal);state=model.failBroker(state,0);status(null,'METADATA STALE');renderLogs();await election(signal);
      comparisons[subphase]=state.logs[state.leader].some(r=>r.eventId===event.eventId)?'SURVIVED':'LOST';
      step('ack-outcome',subphase===2?'acks=all waited for the current ISR. The replicated record survives this clean election.':'Failure before replication leaves the new leader without the record.',subphase===2?'THE KAFKA WAY':'WHAT CAN GO WRONG');return;
    }
    if(scene===3) {
      if(!state.logs[0].length)await cycle(0,signal);const pendingSequence=state.logs[0].length;
      const pending=record(pendingSequence);select('#event-identity').textContent=pending.eventId;select('#event-card').classList.add('is-active');status('PUBLISHING');
      step('failure-send','The leader fails before this next record reaches it. The record has not been written.','WHAT CAN GO WRONG');
      await fly('produce','SEND P0',signal,false,.55);active(signal);
      state=model.failBroker(state,0);status('CONNECTION FAILED','RECONNECTING');select('#producer').dataset.activity='error';renderLogs();await election(signal);
      step('producer-stale-request','The producer still knows the old leader. Its request fails before metadata refresh.');
      await fly('produce','SEND · OLD LEADER',signal,false,.55);status('CONNECTION FAILED');await interval(900,signal);
      step('producer-metadata','Producer and consumer refresh partition-leader metadata independently.');status('REFRESHING METADATA');
      await fly('producer-metadata','META',signal);await fly('producer-metadata','LEADER B2',signal,true);active(signal);state=model.refreshMetadata(state,'producer',2);renderLogs();drawRoutes();
      step('consumer-stale-request','Finance independently tries its old leader and encounters a failed fetch.');status('LEADER FOUND','FETCH FAILED');await fly('finance','FETCH · OLD LEADER',signal,true,.55);await interval(900,signal);
      step('consumer-metadata','Finance refreshes its own partition-leader metadata, independently of the producer.');status('LEADER FOUND','REFRESHING METADATA');await fly('consumer-metadata','META',signal,true);await fly('consumer-metadata','LEADER B2',signal);active(signal);state=model.refreshMetadata(state,'consumer',2);renderLogs();drawRoutes();
      step('coordinator-discovery','Coordinator rediscovery is independent of partition-leader discovery; replicated offset records are retained.');status(null,'FINDING COORDINATOR');
      await fly('consumer-metadata','FIND COORD',signal,true);await fly('consumer-metadata','COORDINATOR B3',signal);active(signal);state=model.rediscoverCoordinator(state,2);renderLogs();drawRoutes();
      const retry=await append(pending,signal,true);await replicate(retry,signal);select('#producer').dataset.activity='idle';await deliver(retry,signal);
      step('retry-complete','The unwritten record was retried to the new leader, replicated and processed. Delivery continues.');await interval(2200,signal);
      for(let sequence=pendingSequence+1;;sequence++){select('#producer-result').textContent='';await cycle(sequence,signal);await interval(900,signal);}
    }
    state=model.failBroker(model.failBroker(state,1),2);step('isr-shortfall','Two brokers are down. ISR 1 is below min.insync.replicas=2; the leader rejects new acks=all writes.');
    select('#event-identity').textContent=record(0).eventId;select('#producer-identity').textContent='';status('PUBLISHING');await fly('produce','SEND P0',signal);active(signal);
    try{model.appendLeader(state,record(0));throw new Error('Expected minimum ISR rejection');}catch(error){if(error.message!=='NotEnoughReplicas')throw error;}
    step('write-rejected');await fly('produce','ERROR · ISR',signal,true);status('NotEnoughReplicas');select('#producer').dataset.activity='error';
    status(null,'WAITING');step('insufficient-isr-complete','The leader rejected this record with NotEnoughReplicas. Nothing was appended, so Finance has no new record to process.');
  }
  function enter(destination,part=0,retained=null) {
    controller.abort();controller=new AbortController();stage.querySelectorAll('.packet').forEach(token=>token.remove());
    scene=destination;subphase=part;if(scene===2&&part===0)comparisons=['NOT RUN','NOT RUN','NOT RUN'];phase='starting';playing=true;paused=playbackControls.paused;
    state=retained?structuredClone(retained):model.createState(scene===0?{replicationFactor:1,minISR:1}:scene===2?{acks:['0','1','all'][part],idempotent:part===2}:{});
    if(scene===1)healthyCheckpoint=null;
    select('#cluster').classList.toggle('is-replicated',scene!==0);select('#cluster-caption').hidden=scene===0;
    select('#ack-comparison').hidden=scene!==2;select('#replica-topic-name').hidden=scene===0;
    select('#scene-heading').textContent=headings[scene];
    select('#scene-counter').textContent=([1,2,2,3,4][scene])+' / 4';
    select('#previous').disabled=scene===0;select('#next').disabled=scene===4;select('#next').textContent=scene===4?'Complete':'Next →';
    for(const id of ['producer','finance'])select('#'+id).dataset.activity='idle';
    select('#producer-result').textContent='';select('#producer-identity').textContent='';select('#event-identity').textContent='—';select('#finance-record').textContent='—';select('#processing-fill').style.width='0%';select('#event-card').classList.remove('is-active');
    status('READY','WAITING');step('starting',['What would you do if the only broker disappeared?','How do followers make the record readable?','What does each acknowledgement guarantee?','The leader fails before the next record arrives. How do clients find its replacement?','What happens when only one ISR replica remains?'][scene],'');
    drawRoutes();playback();const signal=controller.signal;
    run(signal).catch(error=>{if(error.name!=='AbortError'){phase='error';console.error(error);}}).finally(()=>{if(!signal.aborted){playing=false;playback();}});
  }
  select('#next').addEventListener('click',()=>{if(scene===2&&subphase<2)enter(2,subphase+1);else if(scene===1)enter(3,0,healthyCheckpoint);else if(scene<4)enter(scene+1);});
  select('#previous').addEventListener('click',()=>{if(scene===2&&subphase>0)enter(2,subphase-1);else if(scene===3)enter(1);else if(scene>0)enter(scene-1);});
  select('#reset').addEventListener('click',()=>enter(scene,subphase));
  document.querySelectorAll('[data-replay]').forEach(button=>button.addEventListener('click',()=>enter(Number(button.dataset.replay))));
  playbackControls.subscribe(({paused: value})=>{paused=value;playback();});
  select('#scenario-select').addEventListener('change',event=>window.location.href=event.target.value);
  new ResizeObserver(drawRoutes).observe(stage);enter(0);
}

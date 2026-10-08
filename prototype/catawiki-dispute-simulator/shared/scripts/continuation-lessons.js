import { displayRecordProgress } from "./record-progress.js";
import { createPlayback, PACKET_DURATION } from "./playback.js";
import { animate } from "motion";
import { createModel, appendRecord, commitRecord, applyEffect, appendDeadLetter, registerSchema, jsonSchemaV1, incompatibleJsonSchema, jsonSchemaV2, validatesJson } from "./continuation-model.js";

const $ = (selector, root = document) => root.querySelector(selector);
const lesson = document.body.dataset.lesson;
const stage = $("#groups-stage");
const animations = new Set();
const routes = new Map();
const checkpoints = [];
const schemaCheckpoints = [];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const definitions = {
  retries: [
    ["No retries · failed work blocks Finance", "A failed database write: pause failed work and keep NEXT unchanged. What could help?"],
    ["Retries · temporary failure recovers", "Retry the same record with exponential backoff; commit only after its write succeeds."],
    ["Non-retriable record · what next?", "Unsupported business value: retrying cannot fix this record. What could we do?"],
  ],
  offsets: [
    ["Commit first · could work be skipped?", "Goal: one ledger entry. Finance sends DisputeResolved; Kafka assigns P0:0. NEXT 0, ledger empty."],
    ["Write first · could work repeat?", "Same dispute, same P0:0 event. Finance writes the ledger before committing its offset."],
    ["Write once · handle redelivery safely", "Same event ID. The database can recognize a repeated delivery and protect the ledger effect."],
  ],
  schemas: [
    ["Matching local contracts", "One DisputeCreated event should reach Finance. Local V1 contracts match; P0 is empty and NEXT is 0."],
    ["Rename without Registry", "P0:0 succeeded. Producer now renames required dispute_id; Finance still expects V1."],
    ["Registry-enabled alternate run", "Alternate run from an empty P0: V1 producer and Finance V1, with Confluent Schema Registry."],
    ["Reject the incompatible rename", "In the Registry-enabled run, P0:0 succeeded and Finance committed NEXT 1. The producer proposes a required rename."],
    ["Safe evolution under BACKWARD", "In the Registry-enabled run, P0:0 succeeded. Keep dispute_id and propose optional note."],
  ],
};
let model = createModel();
let scene = 0;
let controller = new AbortController();
let paused = document.hidden;
const playbackControls = createPlayback();
let running = false;
let lastAdvance = -Infinity;
let databaseRecord = null;
let packetLayoutFrame = null;
let phase = 'initial';
let dlqFailureSelected = false;
let dlqEnabled = false;
let schemaBeat = -1;
export function simulationSnapshot() { return structuredClone({model,scene,phase,paused,running,dlqFailureSelected,dlqEnabled,schemaBeat}); }
function step(name, label, text) {
  phase = name; stage.dataset.phase = name;
  $('#prompt-label').textContent = label; $('#scene-prompt').textContent = text;
  if (lesson === 'offsets') syncOffsetControls();
}

function syncOffsetControls() {
  const next = $('#next-button');
  const nextLabels = ['Compare commit-after →', 'Show the safeguard →', 'Story complete'];
  const runLabels = ['Show what happens →', 'Run commit-after case →', 'Run idempotent case →'];
  next.disabled = running || paused || (phase === 'complete' && scene === definitions.offsets.length - 1);
  next.textContent = phase === 'complete' ? nextLabels[scene] : runLabels[scene];
  next.title = running ? 'Wait for this story beat to finish.' : paused ? 'Resume the animation before continuing.' : '';
  next.setAttribute('aria-label', next.textContent);
}

function active(signal) {
  if (signal.aborted) throw new DOMException("Scene changed", "AbortError");
}

function cancel() {
  controller.abort();
  controller = new AbortController();
  animations.forEach((animation) => animation.stop());
  animations.clear();
  stage.querySelectorAll(".packet:not(#packet-template)").forEach((packet) => packet.remove());
  document.querySelectorAll(".is-processing,.event-card.is-active,.is-repeated").forEach((card) => card.classList.remove("is-processing", "is-active", "is-repeated"));
  document.querySelectorAll(".member-progress i,.progress-fill,.database-progress i").forEach((fill) => { fill.getAnimations().forEach(animation => animation.cancel()); fill.style.width = "0%"; fill.style.transform = "none"; });
  document.querySelectorAll(".finance-member").forEach((card) => { card.style.opacity = "1"; card.dataset.activity = "idle"; $(".member-state", card).textContent = "WAITING"; });
  document.querySelectorAll(".is-updated").forEach((card) => card.classList.remove("is-updated"));
  paused = playbackControls.paused;
}

function wait(milliseconds, signal) { return playbackControls.wait(milliseconds, {signal}); }

async function motion(element, keyframes, duration, signal, options = {}) {
  active(signal);
  const animation = animate(element, keyframes, { duration: reducedMotion ? 0.12 : duration / 1000, ease: "linear", ...options });
  animations.add(animation);
  const release = playbackControls.track(animation);
  let abort;
  try {
    await Promise.race([animation.finished, new Promise((resolve, reject) => {
      abort = () => { animation.stop(); reject(new DOMException("Scene changed", "AbortError")); };
      signal.addEventListener("abort", abort, { once: true });
    })]);
    active(signal);
  } finally {
    signal.removeEventListener("abort", abort);
    animations.delete(animation);
    release();
  }
}

function member(partition) { return $(`[data-member="${partition === 0 ? "A" : "B"}"]`); }
function identity(record) { return `P${record.partition}:${record.offset}`; }

function point(element, side) {
  const bounds = stage.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return { x: (side === "left" ? rect.left : side === "right" ? rect.right : rect.left + rect.width / 2) - bounds.left,
    y: (side === "top" ? rect.top : side === "bottom" ? rect.bottom : rect.top + rect.height / 2) - bounds.top };
}

function arrangePacketLabels() {
  const visible = [];
  const producer = point($("#groups-producer"), "right");
  const brokerLeft = point($("#groups-broker"), "left");
  const brokerRight = point($("#groups-broker"), "right");
  const consumerLeft = point($("#orders-card"), "left");
  const bounds = stage.getBoundingClientRect();
  const packets = [...stage.querySelectorAll(".packet:not(#packet-template)")];
  for (const packet of packets) {
    const label = $("small", packet);
    label.style.visibility = "visible";
    label.style.top='';label.style.bottom='';
    if (!packet.classList.contains("packet--vertical")) {
      const target = packet.dataset.route === "orders" ? $("#orders-card") : packet.dataset.route === "message" ? $("#message-card") : member(0);
      const packetBounds = packet.getBoundingClientRect();
      const center = packetBounds.left + packetBounds.width / 2 - bounds.left;
      const lane = center >= producer.x - 8 && center <= brokerLeft.x + 8 ? [producer.x, brokerLeft.x]
        : center >= brokerRight.x - 8 && center <= consumerLeft.x + 25 ? [brokerRight.x, point(target, "left").x] : null;
      if (lane) {
        label.style.maxWidth = `${lane[1] - lane[0] - 6}px`;
        const half = label.getBoundingClientRect().width / 2;
        const desired = Math.min(lane[1] - half - 3, Math.max(lane[0] + half + 3, center));
        label.style.transform = `translateX(calc(-50% + ${desired - center}px))`;
      } else {
        label.style.maxWidth = "none";
        label.style.transform = "translateX(-50%)";
      }
    }
    if(lesson==='retries' && packet.dataset.route==='dlq') {
      const packetBounds=packet.getBoundingClientRect(),center=packetBounds.left+packetBounds.width/2-bounds.left;
      const x=(brokerRight.x+consumerLeft.x)/2,y=point($('#dlq-topic'),'right').y;
      label.style.maxWidth=`${consumerLeft.x-brokerRight.x-6}px`;
      label.style.transform=`translateX(calc(-50% + ${x-center}px))`;
      label.style.bottom='auto';label.style.top=`${y-(packetBounds.top-bounds.top)-label.getBoundingClientRect().height/2}px`;
    }
    let rect = label.getBoundingClientRect();
    if(lesson==='retries' && visible.some(entry=>rect.left<entry.rect.right+4&&rect.right>entry.rect.left-4&&rect.top<entry.rect.bottom+4&&rect.bottom>entry.rect.top-4)) {
      label.style.bottom='auto';label.style.top='calc(100% + 8px)';
      rect=label.getBoundingClientRect();
    }
    if (visible.some((entry) => entry.text === label.textContent && rect.left < entry.rect.right + 4 && rect.right > entry.rect.left - 4 && rect.top < entry.rect.bottom + 4 && rect.bottom > entry.rect.top - 4)) label.style.visibility = "hidden";
    else visible.push({ text: label.textContent, rect });
  }
  packetLayoutFrame = packets.length ? requestAnimationFrame(arrangePacketLabels) : null;
}

function path(name, shape, hidden = false, muted = false) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
  element.setAttribute("d", shape);
  element.setAttribute("class", `connection-path${hidden ? " motion-route" : ""}${muted ? " is-muted" : ""}`);
  element.dataset.route = name;
  $("#groups-paths").append(element);
  routes.set(name, element);
  return element;
}

function positionPacket(packet, progress) {
  if (!packet.isConnected) return;
  const route = routes.get(packet.dataset.route);
  if (!route) return;
  packet.dataset.progress = String(progress);
  const fraction = packet.dataset.reverse === "true" ? 1 - progress : progress;
  const position = route.getPointAtLength(route.getTotalLength() * fraction);
  packet.style.transform = `translate(${position.x - 6.5}px, ${position.y - 6.5}px)`;
  route.classList.add("is-active");
}

function drawRoutes() {
  $("#groups-paths").replaceChildren();
  routes.clear();
  const bounds = stage.getBoundingClientRect();
  $("#groups-connections").setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  const producer = point($("#groups-producer"), "right");
  const broker = point($("#groups-broker"), "left");
  const middle = (producer.x + broker.x) / 2;
  path("producer", `M ${producer.x} ${producer.y} H ${middle} V ${broker.y} H ${broker.x}`);
  const brokerRight = point($("#groups-broker"), "right").x;
  const topic = point($("#topic-boundary"), "right");
  const coordinator = point($("#coordinator"), "right");
  const targets = [["orders", $("#orders-card")], ["A", member(0)], ["B", member(1)], ["message", $("#message-card")]].filter(([,element])=>!element.hidden);
  const positions = targets.map(([name, element]) => ({ name, ...point(element, "left") }));
  const spine = (brokerRight + positions[0].x) / 2;
  path("broker-entry", `M ${brokerRight} ${topic.y} H ${spine}`);
  path("coordinator-entry", `M ${brokerRight} ${coordinator.y} H ${spine}`).classList.add("coordinator-route");
  path("spine", `M ${spine} ${Math.min(topic.y, coordinator.y, ...positions.map((entry) => entry.y))} V ${Math.max(topic.y, coordinator.y, ...positions.map((entry) => entry.y))}`);
  for (const target of positions) {
    const muted = (scene > 0 || lesson === "retries" || lesson === "offsets" || lesson === "schemas") && ["orders", "message"].includes(target.name);
    path(`branch-${target.name}`, `M ${spine} ${target.y} H ${target.x}`, false, muted);
    path(target.name, `M ${brokerRight} ${topic.y} H ${spine} V ${target.y} H ${target.x}`, true);
    if (["offsets","retries","schemas"].includes(lesson)) path(`commit-${target.name}`, `M ${brokerRight} ${coordinator.y} H ${spine} V ${target.y} H ${target.x}`, true);
  }
  if (!$("#lesson-database").hidden) {
    const source = point($("#finance-card"), "bottom");
    const destination = point($("#lesson-database"), "top");
    const lane = (source.y + destination.y) / 2;
    path("database", `M ${source.x} ${source.y} V ${lane} H ${destination.x} V ${destination.y}`);
    if(lesson==='retries') path('database-0',`M ${source.x} ${source.y} V ${destination.y}`);
    if (lesson === 'offsets') for (const partition of [0]) {
      const finance=point($('#finance-card'),'left'),origin=point(member(partition),'left');
      const database=point($('#lesson-database'),'left'),x=spine+(partition?10:-10),y=database.y+(partition?8:-8);
      path(`database-${partition}`, `M ${finance.x} ${origin.y} H ${x} V ${y} H ${database.x}`);
    }
  }
  if (!$("#dlq-topic").hidden) {
    if (lesson === "retries") {
      const source = point($("#finance-card"), "bottom");
      const destination = point($("#dlq-topic"), "right");
      const lane = (source.y + point($("#lesson-database"), "top").y) / 2;
      path("dlq", `M ${source.x} ${source.y} V ${lane} H ${spine} V ${destination.y} H ${destination.x}`);
    }
  }
  const registry = $("#lesson-registry");
  if (registry && !registry.hidden) {
    if (lesson === "schemas") {
      const destination = point(registry, "left");
      path("registry", `M ${producer.x} ${producer.y} H ${middle} V ${destination.y} H ${destination.x}`);
      const registryRight = point(registry, "right");
      path("registry-read", `M ${registryRight.x} ${registryRight.y} H ${spine} V ${positions.find((target) => target.name === "A").y}`);
      for (const partition of [0]) {
        const source = point(member(partition), "left");
        path(`schema-${partition}`, `M ${source.x} ${source.y} H ${spine} V ${registryRight.y} H ${registryRight.x}`, true);
      }
    } else {
    const producerBottom = point($("#groups-producer"), "bottom");
    const registryTop = point(registry, "top");
    path("registry", `M ${producerBottom.x} ${producerBottom.y} V ${registryTop.y}`);
    const registryRight = point(registry, "right");
    const registryLane = (registryRight.x + point($("#groups-broker"), "left").x) / 2;
    const bottom = bounds.height - 9;
    path("registry-read", `M ${spine} ${topic.y} V ${bottom} H ${registryLane} V ${registryRight.y} H ${registryRight.x}`);
    for (const partition of [0, 1]) {
      const source = point(member(partition), "left");
      path(`schema-${partition}`, `M ${source.x} ${source.y} H ${spine} V ${bottom} H ${registryLane} V ${registryRight.y} H ${registryRight.x}`, true);
    }
    }
  }
  stage.querySelectorAll(".packet:not(#packet-template)").forEach((packet) => positionPacket(packet, Number(packet.dataset.progress ?? 0)));
}

let packetQueue = Promise.resolve();
async function fly(name, label, signal, reverse = false) {
  if(lesson!=='retries') return flyPacket(name,label,signal,reverse);
  const previous=packetQueue;
  let release;
  packetQueue=new Promise(resolve=>{release=resolve;});
  try { await previous;active(signal);await wait(0,signal);return await flyPacket(name,label,signal,reverse); }
  finally {release();}
}
async function flyPacket(name, label, signal, reverse = false) {
  active(signal);
  const route = routes.get(name);
  if (!route) throw new Error(`Missing route ${name}`);
  const packet = $("#packet-template").cloneNode(true);
  packet.removeAttribute("id");
  packet.dataset.route = name;
  packet.dataset.reverse = String(reverse);
  packet.style.display = "grid";
    const registryRoute = name === "registry" || name.startsWith("schema-") || name.startsWith("commit-");
  packet.classList.toggle("packet--registry", registryRoute);
  packet.classList.toggle("packet--vertical", (name.startsWith("database") && lesson!=='offsets') || (name === "registry" && lesson !== "schemas"));
  $("small", packet).textContent = label;
  stage.append(packet);
  if (packetLayoutFrame === null) packetLayoutFrame = requestAnimationFrame(arrangePacketLabels);
  positionPacket(packet, 0);
  route.classList.add("is-active");
  try { await motion(0, 1, PACKET_DURATION, signal, { onUpdate: (progress) => { if (!signal.aborted) positionPacket(packet, progress); } }); }
  finally { packet.remove(); routes.get(name)?.classList.remove("is-active"); }
}

function update() {
  for (const partition of [0, 1]) {
    const row = $(`[data-partition="${partition}"]`);
    const window = $(".record-window", row);
    window.replaceChildren();
    for (const record of model.logs[partition].slice(-4)) {
      const entry = document.createElement("span");
      entry.className = "stored-record";

      entry.title = `${identity(record)} · ${record.eventId} · ${record.event}`;
      const dot = document.createElement("span");
      dot.className = "record-dot";
      dot.textContent = record.offset;
      displayRecordProgress(dot, record, { scope: window, playback: playbackControls, groups: ["finance"], nextByGroup: { finance: model.next },
        processed: lesson !== "offsets" || (model.effects[record.eventId] ?? 0) > 0,
        failed: model.lostEvent === record.eventId || (record.offset >= model.next[partition] && (model.businessError === record.eventId || model.journal.some(e => e.eventId === record.eventId && ["database-failure", "business-failure"].includes(e.phase)))) });
      const label = document.createElement("small");
      label.textContent = lesson === "offsets" && record.eventId === model.lostEvent && model.storedNext[partition] > record.offset
        ? "SKIPPED" : record.event === "DisputeCreated" ? "CREATED" : "RESOLVED";
      entry.append(dot, label);
      window.append(entry);
    }
    $(".record-count", row).textContent = model.logs[partition].length;
    $(".member-lag", member(partition)).textContent = `LAG ${model.logs[partition].length - model.next[partition]}`;
    $(".member-history", member(partition)).textContent = `${lesson==='retries'?'POS':'POSITION'} ${model.position[partition]} · NEXT ${model.next[partition]}`;
    if (lesson === "schemas") $(":scope > small", member(partition)).textContent = `P${partition} · READER V${model.readerVersion ?? 1}`;
  }
  const offsets = (values) => (['retries','offsets','schemas'].includes(lesson)?values.slice(0,1):values).map((offset, partition) => `P${partition} · NEXT ${offset}`).join("\n");
  $("#finance-offset").textContent = offsets(['retries','offsets','schemas'].includes(lesson) ? model.storedNext : model.next);
  for (const service of ["orders", "message"]) {
    $(`#${service}-offset`).textContent = offsets(model.serviceNext[service]);
    $(`#${service}-next`).textContent = offsets(model.serviceNext[service]);
  }
  $("#broker-state").textContent = model.logs.some((records) => records.length) ? "RETAINED LOG" : "LOG EMPTY";
  $("#coordinator-state").textContent = lesson === "offsets" ? "COMMITTED NEXT" : "FINANCE GROUP OFFSETS";
  $("#database-details").textContent = databaseRecord
    ? `${databaseRecord.eventId} · EFFECTS ${model.effects[databaseRecord.eventId] ?? 0}`
    : lesson === "offsets" ? "Business effects · 0" : "EVENT · — · EFFECTS · —";
  if(lesson==='offsets') {
    if(databaseRecord?.eventId===model.lostEvent) $('#database-state').textContent='EFFECTS 0 · LOST';
    $('#database-transaction').textContent=scene===2&&databaseRecord&&model.handled.includes(databaseRecord.eventId)
      ? `ATOMIC DB TRANSACTION · ${databaseRecord.eventId} + EFFECT ${model.effects[databaseRecord.eventId]??0}` : '';
  }
  $("#dlq-records").replaceChildren();
  const deadLetters = lesson === "retries" ? model.dlq.slice(-3) : model.dlq.slice(-2);
  for (const [index, record] of deadLetters.entries()) {
    const entry = document.createElement("div");
    entry.textContent = `DLQ P0:${record.offset} · ${record.eventId}\nSOURCE P${record.sourcePartition}:${record.sourceOffset} · ${record.error}`;
    if (lesson === "retries") {
      entry.className = "queued-record";
      entry.style.gridColumn = String(3 - index);
      entry.title = entry.textContent;
      entry.style.gridColumn = '';
      entry.textContent = `DLQ P0:${record.offset}\n${record.eventId.split(":")[0]}\nSource P${record.sourcePartition}:${record.sourceOffset}\n${record.payload?.reason}`;
      entry.dataset.dlqOffset=record.offset;
      entry.title=`Source ${record.sourceTopic} P${record.sourcePartition}:${record.sourceOffset} · ${record.eventId} · ${JSON.stringify(record.payload)} · ${record.error} · attempts ${record.attempts}`;
    }
    $("#dlq-records").append(entry);
  }

}

function render() {
  const definition = definitions[lesson][scene];
  $("#scene-heading").textContent = definition[0];
  $("#scene-prompt").textContent = definition[1];
  $("#scene-counter").textContent = `${scene + 1} / ${definitions[lesson].length}`;

  $("#previous-button").disabled = scene === 0;
  $("#next-button").disabled = scene === definitions[lesson].length - 1;
  $("#next-button").textContent = scene === 0 ? "Next →" : scene === definitions[lesson].length - 1 ? "Complete" : "Next →";
  $("#lesson-database").hidden = lesson === "schemas" || (scene === 0 && lesson !== "retries" && lesson !== "offsets");
  $("#dlq-topic").hidden = true;
  $("#finance-state").textContent = "GROUP ACTIVE";
  $("#consumer-column-note").textContent = "EXAMPLE PARTITION ASSIGNMENT";
  for (const service of ["orders", "message"]) {
    $(`#${service}-card`).classList.toggle("is-deemphasized", scene > 0 || lesson === "retries" || lesson === "offsets" || lesson === "schemas");
    $(`#${service}-state`).textContent = scene > 0 || lesson === "retries" || lesson === "offsets" || lesson === "schemas" ? "IDLE" : "WAITING";
  }
  $("#database-state").textContent = "READY";
  $("#lesson-database").dataset.activity = "idle";
  if (lesson === "retries") {
    $('#finance-state').textContent='finance-disputes';
    $('.retention-note').textContent='RETAINED LOG · COMMITS DO NOT REMOVE RECORDS';
    member(1).hidden=true;
    $('[data-partition="1"]').hidden=true;
    $(':scope > strong',member(0)).textContent='Finance · P0';
    $('#consumer-column-note').textContent='ONE FINANCE CONSUMER · P0';
    $('#broker-note').textContent='P0 · one ordered log';
    $("#retry-count").textContent = scene===0?'APP LOGIC · no retries':scene===1?'1 initial + up to 3 retries · time compressed':'APP LOGIC · non-retriable · no retries';
    $('#dlq-topic').hidden = !dlqEnabled;
    if(scene===2){$('#next-button').disabled=true;$('#next-button').textContent=dlqEnabled?'Complete':'Next →';}
    if(scene===2&&dlqEnabled){$('#scene-heading').textContent='Non-retriable record · DLQ';}
    $('#dlq-fail').hidden = !dlqEnabled;
    $('#dlq-retry').hidden = true;
    $('#producer-note').textContent = 'Continuing production · P0' ;
    step('starting', scene===1?'APP LOGIC':'', definition[1]);

  }
  if(lesson==='offsets') {
    $('.ownership-legend').textContent='KAFKA · FINANCE APP LOGIC · DATABASE';
    $('#finance-state').textContent='finance-disputes';
    $('#consumer-column-note').textContent='ONE FINANCE CONSUMER · P0';
    $('#broker-note').textContent='P0 · one ordered log';
    $('#producer-state').textContent='READY';
    $('#producer-note').textContent='Ready to send DisputeResolved';
    $(':scope > strong',member(0)).textContent='Finance A';
    $('.member-history',member(0)).hidden=true;
    $('#orders-card').hidden=true;
    $('#message-card').hidden=true;
    $('[data-event="DisputeResolved"]').hidden=false;
    $('[data-member="B"]').hidden=true;
    $('[data-partition="1"]').hidden=true;
    $('.member-lag',member(0)).hidden=true;
    $('.internal-topic').hidden=true;
    $('#coordinator .coordinator-heading strong').textContent='GROUP COORDINATOR · finance-disputes';
    $('#coordinator-state').textContent='COMMITTED NEXT';
    document.querySelectorAll('.offset-grid > div').forEach(row=>{row.hidden=!row.querySelector('#finance-offset');});
    document.querySelectorAll('.offset-grid > div strong').forEach(value=>{if(value.id==='finance-offset')value.previousElementSibling.textContent='finance-disputes';});
    $('#offset-comparison').hidden=true;
    $('#offset-comparison').textContent='';
    $('#database-transaction').textContent='';
    step('starting','',definition[1]);
  }
  if (lesson === "schemas") {
    $('#lesson-registry').hidden = scene < 2;
    $('#registry-state').textContent = model.schemas.length ? `ID ${model.schemas.at(-1).id} · READY` : 'READY';
    $('#lesson-registry').dataset.activity = 'idle';
    registryDetails();
    $('#producer-note').textContent = scene < 2 ? 'JSON · LOCAL CONTRACT' : 'JSON SCHEMA · PRODUCER SERIALIZER';
    $('#broker-note').textContent = 'SELECTED EXAMPLE · P0 / Finance A';
    $('.retention-note').textContent='RETAINED LOG · COMMITS DO NOT REMOVE RECORDS';
    $('#consumer-column-note').textContent = 'ONE FINANCE MEMBER · P0';
    $('[data-member="B"]').hidden=true;
    $('[data-partition="1"]').hidden=true;
    $('#orders-card').hidden=true;
    $('#message-card').hidden=true;
    $('.internal-topic').hidden=true;
    document.querySelectorAll('.offset-grid > div').forEach(row=>{row.hidden=!row.querySelector('#finance-offset');});
    $('#finance-state').textContent='finance-disputes';
    $('#schema-safe-step').hidden = scene !== 4;
    showJsonProposal(scene === 1 || scene === 3 ? incompatibleJsonSchema : (model.writerVersion === 2 ? jsonSchemaV2 : jsonSchemaV1), scene === 3);
    readerContract();
    if(scene === 1) $('.member-state',member(0)).textContent='P0:0 PROCESSED';
    if(scene >= 3) $('.member-state',member(0)).textContent='P0:0 PROCESSED · NEXT 1';
    step('starting','',definition[1]);
    if(scene === 4) $('#schema-safe-step').textContent='V1 in Kafka · Finance V1 · NEXT 1';
  }

  playback();
  update();
  drawRoutes();
}

function playback() {
  $("#pause-button").textContent = paused ? "▶ Resume" : "Ⅱ Pause";
  $("#pause-button").setAttribute("aria-pressed", String(paused));
  $("#flow-state span").textContent = document.hidden ? "PAUSED · tab hidden" : paused ? "PAUSED" : running ? "PLAYING" : lesson === "retries" ? "STOPPED" : "LIVE";
  $("#flow-state").classList.toggle("is-paused", paused);
  $("#flow-state").classList.toggle("is-playing", running && !paused);
}

async function publish(partition, signal, fields = {}) {
  active(signal);
  const event = fields.event ?? "DisputeCreated";
  const card = $(`[data-event="${event}"]`);
  card.classList.add("is-active");
  $("small", card).textContent = fields.schemaId ? `SCHEMA ID ${fields.schemaId} · ${"JSON"}` : "SENDING · NO KEY";
  $("#producer-state").textContent = "PUBLISHING";
  $("#groups-producer").dataset.activity = "idle";
  await fly("producer", lesson === "schemas" ? `SEND · P0:${model.logs[0].length}` : lesson === "retries" ? `SEND · P${partition}:${model.logs[partition].length}` : event === "DisputeCreated" ? "SEND · CREATED" : "SEND · RESOLVED", signal);
  active(signal);
  const record = appendRecord(model, partition, fields);
  $("small", card).textContent = `${identity(record)} · ${record.eventId}`;
  if (lesson === "schemas" && !record.schemaId) $("small", card).textContent = `${identity(record)} · ${Object.keys(record.payload)[0]}`;
  $("#producer-state").textContent = "APPENDED";
  if (lesson === "offsets") $("#producer-note").textContent = `${identity(record)} · appended to Kafka`;
  card.classList.remove("is-active");
  update();
  $("#broker-state").textContent = `APPENDED · ${identity(record)}`;
  return record;
}

async function receive(record, signal, service = null, redelivery = false) {
  const partition = record.partition;
  const target = service ?? (partition === 0 ? "A" : "B");
  const card = service ? $(`#${service}-card`) : member(partition);
  const status = service ? $(`#${service}-state`) : $(".member-state", card);
  status.textContent = "POLLING";
  await fly(target, `POLL P${partition}`, signal, true);
  await fly(target, `${redelivery ? "REDELIVER" : "RECORD"} · ${identity(record)}`, signal);
  if (!service) {
    model.position[partition] = record.offset + 1;
    $(".member-record", card).textContent = `${identity(record)} · ${record.eventId}`;
    update();
  }
}

async function process(record, signal, { duration = 1300, activity = "processing", service = null, label = "PROCESSING", progressEnd = 100 } = {}) {
  const card = service ? $(`#${service}-card`) : member(record.partition);
  const fill = service ? $(".progress-fill", card) : $(".member-progress i", card);
  card.dataset.activity = activity;
  card.classList.add("is-processing");
  const status = service ? $(`#${service}-state`) : $(".member-state", card);
  status.textContent = label;
  await motion(fill, { width: ["0%", `${progressEnd}%`] }, duration, signal);
  active(signal);
  if (progressEnd === 100) fill.style.width = "0%";
  card.classList.remove("is-processing");
  card.dataset.activity = "idle";
  status.textContent = "WAITING";
}

function commit(record) {
  commitRecord(model, record);
  update();
}

async function animateCommit(record, signal) {
  const card = member(record.partition);
  card.dataset.activity = "committing";
  $(".member-state", card).textContent = "COMMITTING";
  await fly(`commit-${record.partition === 0 ? "A" : "B"}`, `COMMIT P${record.partition} · NEXT ${record.offset + 1}`, signal, true);
  active(signal);
  if (['retries','offsets','schemas'].includes(lesson)) {
    model.storedNext[record.partition]=record.offset+1;
    model.journal.push({phase:'commit-stored',partition:record.partition,offset:record.offset,eventId:record.eventId});
    $('#finance-offset').textContent=(['retries','offsets','schemas'].includes(lesson)?model.storedNext.slice(0,1):model.storedNext).map((n,p)=>`P${p} · NEXT ${n}`).join('\n');
    $('.member-state',card).textContent='COMMIT ACK';
    if(lesson==='offsets')step('commit-response','COMMIT REQUEST','The request stores P0 · NEXT 1 with the finance-disputes group coordinator.');
    await fly(`commit-${record.partition===0?'A':'B'}`, `ACK P${record.partition} · NEXT ${record.offset+1}`, signal);
    active(signal);
    model.journal.push({phase:'commit-ack',partition:record.partition,offset:record.offset,eventId:record.eventId});
  }
  commit(record);
  if(lesson==='offsets') step('commit-acknowledged','COMMIT ACKNOWLEDGED','The coordinator confirms NEXT 1. After a restart, Finance resumes after P0:0.');
  $("#finance-offset").parentElement.classList.add("is-updated");
  $(".member-state", card).textContent = "COMMITTED";
  await wait(900, signal);
  $("#finance-offset").parentElement.classList.remove("is-updated");
  card.dataset.activity = "idle";
}

async function finish(record, signal) {
  await receive(record, signal);
  await process(record, signal);
  active(signal);
  applyEffect(model, record);
  if (lesson === "offsets") await animateCommit(record, signal);
  else commit(record);
}

async function fresh(partition, signal, fields = {}) {
  const record = await publish(partition, signal, fields);
  await Promise.all([0, 1].map(async (pendingPartition) => {
    const limit = pendingPartition === partition ? record.offset : model.logs[pendingPartition].length;
    while (model.next[pendingPartition] < limit) await finish(model.logs[pendingPartition][model.next[pendingPartition]], signal);
  }));
  return record;
}

async function healthy(signal) {
  let partition = 0;
  while (true) {
    const record = await fresh(partition, signal, { userId: "customer-49328" });
    await Promise.all([finish(record, signal), ...["orders", "message"].map(async (service) => {
      await receive(record, signal, service);
      await process(record, signal, { service, duration: 1000 });
      active(signal);
      model.serviceNext[service][partition] = record.offset + 1;
      update();
    })]);
    partition = 1 - partition;
    await wait(900, signal);
  }
}

async function databaseOperation(record, signal, fail = false, idempotent = false) {
  databaseRecord = record;
  const retrying = lesson === "retries" && model.attempts > 0;
  member(record.partition).dataset.activity = retrying ? "retrying" : "processing";
  $(".member-state", member(record.partition)).textContent = "DB OPERATION";
  $("#database-state").textContent = idempotent ? "TRANSACTION" : "WRITE";
  $("#lesson-database").dataset.activity = retrying ? "retrying" : "processing";
  if (lesson === "retries") $("#retry-count").textContent = `ATTEMPTS ${model.attempts + 1} / 3 · RETRIES ${model.attempts}`;
  update();
  if(lesson==='offsets') model.journal.push({phase:'database-start',eventId:record.eventId,offset:record.offset});
  await fly(lesson==='offsets'?'database-0':"database", idempotent ? "TX · EVENT ID + EFFECT" : "DB WRITE", signal);
  await motion($(".database-progress i"), { width: ["0%", "100%"] }, 900, signal);
  active(signal);
  $(".database-progress i").style.width = "0%";
  if (fail) {
    $("#database-state").textContent = "TIMEOUT";
    $("#lesson-database").dataset.activity = lesson === "retries" && model.attempts < 2 ? "retrying" : "error";
    return false;
  }
  const applied = applyEffect(model, record, idempotent);
  if(lesson==='offsets') model.journal.push({phase:applied?'database-success':'database-deduplicated',eventId:record.eventId,offset:record.offset,atomic:idempotent});
  $("#database-state").textContent = applied ? "SAVED" : "EVENT ID EXISTS";
  if(lesson==='offsets') $("#lesson-database").dataset.activity = "success";
  member(record.partition).dataset.activity = "idle";
  $(".member-state", member(record.partition)).textContent = "WAITING";
  update();
  return applied;
}

// Application policy: dependency retries and poison handling are separate flows.
async function retryTraffic(signal) {
  const outage=scene===0, poison=scene===2, withDLQ=poison;
  $('#database-state').textContent=poison?'AVAILABLE':'UNAVAILABLE';
  $('#lesson-database').dataset.activity=poison?'success':'error';
  const journal=(name,record,extra={})=>model.journal.push({phase:name,partition:record.partition,offset:record.offset,eventId:record.eventId,...extra});
  const produce=async()=>{
    let index=0;
    while(!signal.aborted) {
      await wait(100,signal);
      const businessId=model.businessSequence++;
      const fields={eventId:`dispute-${businessId}:created`,payload:{dispute_id:businessId,order_id:98765+index,reason:poison&&index%4===0?'unsupported':'object_not_received'}};
      if(poison&&index===0) fields.eventId='dispute-49328:created';
      const record=await publish(0,signal,fields);
      journal('append',record);index++;
      // Recovery arrivals leave time for both consumers to finish their poll/write/commit cycle.
      await wait(outage?1800:poison?5000:PACKET_DURATION*6,signal);
    }
  };
  const write=async(record,fail)=>{
    const p=record.partition,card=member(p);
    databaseRecord=record;
    card.dataset.activity=fail?'retrying':'processing';
    $('.member-state',card).textContent=fail?'DB REQUEST':'DB WRITE';
    $('#database-state').textContent=fail?'UNAVAILABLE':'WRITE';
    $('#lesson-database').dataset.activity=fail?'retrying':'processing';
    await fly(`database-${p}`,'DB WRITE',signal);
    await process(record,signal,{duration:750,activity:fail?'retrying':'processing',label:fail?'WAITING FOR DB':'WRITING'});
    journal(fail?'database-failure':'database-success',record);
    if(!fail){applyEffect(model,record);update();}
    $('#database-state').textContent=fail?'WRITE FAILED':'SAVED';
    $('#lesson-database').dataset.activity=fail?'retrying':'success';
  };
  const attempts=async(record)=>{
    const p=record.partition,card=member(p);
    for(let n=1;n<=4;n++) {
      model.retryAttempts[p]=n;
      $('#retry-count').textContent=`ATTEMPT ${n} / 4 · RETRY ${n-1} / 3`;
      step('retry-attempt','APP LOGIC',`Same record P${p}:${record.offset} · attempt ${n} of 4. NEXT stays unchanged until success.`);
      await write(record,n<4);
      if(n===4) {
        await animateCommit(record,signal);journal('processed',record);
        $('#retry-count').textContent='SUCCESS · INITIAL + 3 RETRIES';
        step('retry-success','APP LOGIC','Database recovered on retry 3. Write succeeded, then NEXT advanced. Finance resumes processing.');
        card.dataset.activity='success';$('.member-state',card).textContent='PROCESSED · RETRY 3';
        return;
      }
      model.businessError=record.eventId;update();
      const seconds=2**(n-1);
      journal('backoff',record,{attempt:n,retry:n,delaySeconds:seconds});
      step('retry-backoff','APP LOGIC',`Retry ${n} of 3 · backoff ${seconds}s · time compressed. Same record; NEXT unchanged.`);
      $('.member-state',card).textContent=`Retry ${n}/3 · wait ${seconds}s`;
      $('#retry-count').textContent=`BACKOFF ${seconds}s · TIME COMPRESSED`;
      await wait(450+250*n,signal);
    }
  };
  const healthyWrite=async(record)=>{
    $('#retry-count').textContent='APP LOGIC · processing next valid record';
    await process(record,signal,{duration:750});await write(record,false);
    await animateCommit(record,signal);journal('processed',record);
    member(record.partition).dataset.activity='success';$('.member-state',member(record.partition)).textContent='PROCESSED';

  };
  const consumer=async(p)=>{
    while(!signal.aborted) {
      if(scene===1&&p===1&&model.next[0]===0){
        $('.member-state',member(p)).textContent='WAITING · DATABASE DOWN';
        while(model.next[0]===0)await wait(100,signal);
      }
      while(model.next[p]>=model.logs[p].length)await wait(100,signal);
      const record=model.logs[p][model.next[p]];
      await receive(record,signal);journal('receive',record);
      if(!poison&&record.offset===0&&(outage||p===0)){
        if(outage){
          model.retryAttempts[p]=1;await write(record,true);model.businessError=record.eventId;update();
          $('.member-state',member(p)).textContent=`P${p} PAUSED · NEXT 0`;member(p).dataset.activity='error';
          step('no-retries-blocked','APP LOGIC','Database unavailable. Application pauses failed work; NEXT stays unchanged. Committing past it could skip unfinished work after restart.');
          while(!signal.aborted)await wait(1000,signal);return;
        }
        await attempts(record);model.businessError=null;update();continue;
      }
      if(poison&&p===0&&record.payload.reason==='unsupported'){
        model.retryAttempts[p]=1;
        await process(record,signal,{duration:900,label:'VALIDATING'});
        journal('business-failure',record,{attempt:1,retriable:false});
        model.businessError=record.eventId;update();
        member(p).dataset.activity='error';
        $('.member-state',member(p)).textContent='NON-RETRIABLE · unsupported value';
        $('#retry-count').textContent='VALIDATION FAILED · NO RETRIES';
        if(!dlqEnabled){
          $('#next-button').disabled=false;
          step('poison-blocked','','NON-RETRIABLE: unsupported business value. P0 is paused; NEXT unchanged. Retrying the same payload cannot fix it.');
          while(!signal.aborted)await wait(1000,signal);
          return;
        }
        step('dlq-publish','APP LOGIC','Publish the failed record to the separate DLQ topic; wait for its ACK before source commit. These operations are not atomic.');
        await fly('dlq',`DLQ · ${identity(record)}`,signal);
        if(dlqFailureSelected){
          journal('dlq-publish-failed',record);step('dlq-publish-failed','WHAT CAN GO WRONG','DLQ publication failed. Source NEXT stays unchanged. Retry publication explicitly; never skip the source record.');
          $('.member-state',member(0)).textContent='DLQ FAILED · NEXT 0';$('#dlq-retry').hidden=false;
          await new Promise((resolve,reject)=>{
            const button=$('#dlq-retry');
            const cleanup=()=>{button.removeEventListener('click',retry);signal.removeEventListener('abort',abort);button.hidden=true;};
            const retry=()=>{cleanup();resolve();},abort=()=>{cleanup();reject(new DOMException('Scene changed','AbortError'));};
            button.addEventListener('click',retry);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
          });
          active(signal);await fly('dlq',`DLQ RETRY · ${identity(record)}`,signal);
        }
        appendDeadLetter(model,record);journal('dlq-stored',record);update();
        step('dlq-ack','APP LOGIC','The DLQ stored the original identity, payload and failure context. Wait for the publication ACK.');
        await fly('dlq','DLQ ACK',signal,true);journal('dlq-ack',record);
        await animateCommit(record,signal);journal('poison-skipped-after-dlq',record);
        model.businessError=null;update();
        step('dlq-isolated','APP LOGIC','DLQ isolates failed work; it repairs neither record nor dependency. Investigation, correction and replay require application or operator action.');
      } else {
        await healthyWrite(record);
        if(withDLQ&&p===0)step('poison-next-valid','APP LOGIC','Next valid P0 record succeeded. An incompatible event that reaches Kafka can also be a poison record for a consumer. No automatic DLQ replay.');
      }
    }
  };
  await Promise.all([produce(),consumer(0)]);
}

async function crash(record, signal) {
  const card=member(0);
  card.dataset.activity='error';$('.member-state',card).textContent='CRASHED';
  step('crashed','APP LOGIC',scene===0?'Finance fails before this event’s business write completes.':'The database write finished, but this event’s offset was not committed.');
  model.journal.push({phase:'crashed',eventId:record.eventId,offset:record.offset});
  await wait(1700,signal);
  model.membership='left';model.assignment=[];
  $(':scope > strong',card).textContent='Finance A';
  $('#finance-state').textContent='MEMBER LOST';$(':scope > small',card).textContent='UNASSIGNED';
  if(scene===0){model.businessError=record.eventId;model.lostEvent=record.eventId;databaseRecord=record;}
  step('member-left','KAFKA','After failure detection, Finance leaves the group and loses its P0 assignment.');
  await motion(card,{opacity:[1,.35]},650,signal);
  update();
}

async function restartFinance(record, signal) {
  const card=member(0);
  active(signal);model.membership='rejoining';$('#finance-state').textContent='REJOINING';
  step('rejoining','KAFKA','Restarted Finance rejoins finance-disputes. Kafka reassigns P0.');
  await fly('commit-A','JOIN GROUP',signal,true);await wait(1000,signal);
  model.membership='joined';model.assignment=[0];model.position[0]=model.storedNext[0];
  $(':scope > strong',card).textContent='Finance A';
  $(':scope > small',card).textContent='P0';$('#finance-state').textContent='ASSIGNED P0';
  card.dataset.activity='idle';$('.member-state',card).textContent='REASSIGNED';$('.member-progress i',card).style.width='0%';
  step('reassigned','KAFKA',`P0 is reassigned. Finance resumes from committed NEXT ${model.storedNext[0]}.`);
  model.journal.push({phase:'resume',position:model.position[0],storedNext:model.storedNext[0]});update();
  await motion(card,{opacity:[.35,1]},650,signal);await wait(1400,signal);
  $('.member-progress i',card).style.width='0%';card.dataset.activity='idle';$('.member-state',card).textContent='WAITING';
  if(scene===0){
    $('#database-state').textContent='EFFECTS 0 · LOST';
    $('#offset-comparison').hidden=false;
    step('resume-poll','KAFKA',`Finance polls from P0 · NEXT ${model.storedNext[0]}. P0:0 remains in Kafka, behind its resume position.`);
    await fly('A',`POLL FROM NEXT ${model.storedNext[0]}`,signal,true);
    active(signal);
    $('.member-state',card).textContent=`NO RECORD AT NEXT ${model.storedNext[0]}`;
    $('.member-record',card).textContent='P0:0 SKIPPED · ledger effect missing';
    model.journal.push({phase:'resume-poll-empty',position:model.position[0],storedNext:model.storedNext[0]});
    update();
    $('#offset-comparison').textContent='P0:0 stays in Kafka · Finance skips it · ledger effects: 0';
    step('complete','COMMIT FIRST',`Finance polls from NEXT ${model.storedNext[0]}. P0:0 is skipped; no ledger entry was written.`);
    return;
  }
  await receive(record,signal,null,true);
  if(scene===1)member(0).classList.add('is-repeated');
  step('redelivery','KAFKA','The broker delivers the same P0:0 record and business event ID again.');
}
async function offsetProcess(record,signal,idempotent=false,options={}) {
  step('processing','APP LOGIC',idempotent?'Processing runs on every delivery. Producer idempotence protects producer retries; this handler deduplicates database effects.':'Finance runs its application handler for the displayed business event.');
  model.processingCounts[record.eventId]=(model.processingCounts[record.eventId]??0)+1;
  model.journal.push({phase:'processing',eventId:record.eventId,offset:record.offset});
  await process(record,signal,options);
}
async function runOffsetsStory(signal) {
  const record = await publish(0, signal, {event:'DisputeResolved',eventId:'dispute-49328:resolved'});

  await receive(record, signal);
  step('delivered', 'KAFKA', 'Finance receives DisputeResolved at P0:0. The ledger is empty; committed next is 0.');

  if (scene === 0) {
    await animateCommit(record, signal);
    step('committed-before-processing', 'COMMIT FIRST', 'The coordinator confirmed NEXT 1 before Finance started the ledger write.');
    await crash(record, signal);
    await restartFinance(record, signal);
    model.journal.push({phase:'skipped',eventId:record.eventId,offset:record.offset,storedNext:model.storedNext[0],effects:model.effects[record.eventId]??0});
    $('#lesson-database').dataset.activity = 'error';
    $('#offset-comparison').hidden = false;
    $('#offset-comparison').textContent = 'Benefit · no replay after restart. Risk · the ledger entry was skipped.';
    step('complete', 'COMMIT FIRST', `Finance resumes at NEXT ${model.storedNext[0]} and finds no P0:1 yet. P0:0 remains in Kafka, skipped; ledger effects stay at 0.`);
    return;
  }

  await offsetProcess(record, signal, scene === 2);
  await databaseOperation(record, signal, false, scene === 2);
  step('written-uncommitted', 'DATABASE WRITE', scene === 2
    ? 'The ledger entry and event ID were saved together. Kafka committed next remains 0.'
    : 'The ledger entry is saved. Kafka committed next remains 0.');
  await crash(record, signal);
  await restartFinance(record, signal);
  model.journal.push({phase:'redelivery',eventId:record.eventId,offset:record.offset});
  await offsetProcess(record, signal, scene === 2);
  await databaseOperation(record, signal, false, scene === 2);
  step(scene === 2 ? 'deduplicated' : 'duplicate-written', 'APPLICATION HANDLER', scene === 2
    ? 'EVENT ID EXISTS · Finance handled the redelivery; the ledger stays at one entry.'
    : 'SAME EVENT AGAIN · the second database write creates a duplicate ledger entry.');
  if(scene===1){$('#lesson-database').dataset.activity='error';$('#database-state').textContent='DUPLICATE EFFECT';}
  else $('#lesson-database').dataset.activity='success';
  await animateCommit(record, signal);
  $('#offset-comparison').hidden = false;
  $('#offset-comparison').textContent = scene === 1
    ? 'Benefit · the event is retried after a crash. Risk · a completed database write can happen twice.'
    : 'The application recognizes the event ID and keeps one ledger effect. Kafka itself does not make the database write exactly once.';
  step('complete', scene === 1 ? 'WRITE, THEN COMMIT' : 'IDEMPOTENT DATABASE WRITE', scene === 1
    ? 'Finance committed NEXT 1 after the replay. The ledger contains 2 effects for one event.'
    : 'Finance committed NEXT 1 after the replay. The ledger still contains 1 effect for one event.');
}

function showJsonProposal(schema, proposal = false) {
  const renamed = !Object.hasOwn(schema.properties, 'dispute_id');
  const version = renamed || Object.hasOwn(schema.properties, 'note') ? 2 : 1;
  const field = renamed ? 'order_dispute_id' : 'dispute_id';
  $('#schema-version').textContent = `${proposal ? `PROPOSED V${version} · NOT SENT` : `WRITER V${version}`} · ${scene < 2 ? 'LOCAL JSON' : 'JSON SCHEMA'}`;
  $('#producer-schema').textContent = `${field} · required\norder_id · required\nreason · required${schema.properties.note ? '\nnote · optional' : ''}`;
  $('#schema-proposal').dataset.version = String(version);
  const payload = { [field]: 12345, order_id: 98765, reason: 'object_not_received', ...(schema.properties.note ? {note:'investigate delivery'} : {}) };
  $('#schema-payload').textContent = `${field}: 12345 · order_id: 98765\nreason: object_not_received${schema.properties.note ? '\nnote: investigate delivery' : ''}`;
  return payload;
}
function readerContract() {
  $('#consumer-contract').textContent = `FINANCE V${model.readerVersion ?? 1} · dispute_id, order_id, reason${model.readerVersion === 2 ? ' · optional note handled' : ''}`;
}
function registryDetails() {
  $('#registry-details').textContent = `BACKWARD (Confluent default) · configured STRICT\nclosed JSON · IDs ${model.schemas.map(s=>s.id).join(', ') || '—'} · Finance lookups ${model.registryRequests}`;
}
async function parseJsonRecord(record, signal) {
  await receive(record, signal);
  $('.member-record',member(0)).textContent = `${identity(record)} · ${record.eventId} · V${record.writerVersion ?? 1}`;
  if(record.schemaId) {
    const cacheKey = `0:${record.schemaId}`;
    if(!model.cache.includes(cacheKey)) {
      step('schema-lookup','SCHEMA REGISTRY (CONFLUENT)','Retrieve the writer schema by ID. This does not upgrade Finance’s contract or business logic.');
      $('.member-state',member(0)).textContent = 'SCHEMA LOOKUP';
      member(0).dataset.activity = 'lookup';
      $('#registry-state').textContent = `GET ID ${record.schemaId}`;
      await fly('schema-0',`GET ID ${record.schemaId}`,signal);
      await fly('schema-0',`SCHEMA ID ${record.schemaId}`,signal,true);
      active(signal);model.cache.push(cacheKey);model.registryRequests++;
      model.journal.push({phase:'schema-cached',schemaId:record.schemaId,readerVersion:model.readerVersion});
    } else step('schema-cache','SCHEMA REGISTRY (CONFLUENT)',`Reuse cached writer schema ID ${record.schemaId}; Finance remains READER V${model.readerVersion}.`);
    $('#registry-state').textContent = `ID ${record.schemaId} · CACHED`;registryDetails();await wait(1200,signal);
  }
  step('validation','APP LOGIC',`Finance validates against its explicitly deployed V${model.readerVersion} contract and application handling.`);
  await process(record,signal,{label:`VALIDATING V${model.readerVersion}`,duration:1100});
  active(signal);
  if(!validatesJson(model.readerVersion === 2 ? jsonSchemaV2 : jsonSchemaV1, record.payload)) {
    model.businessError=record.eventId;member(0).dataset.activity='error';$('.member-state',member(0)).textContent='APP LOGIC · VALIDATION FAILED';
    model.journal.push({phase:'validation-failed',eventId:record.eventId});update();
    step('validation-failed','WHAT CAN GO WRONG','APP LOGIC: the renamed event reached Kafka and can become a poison record for this consumer. Its offset is not committed.');return;
  }
  await process(record,signal,{label:'APP LOGIC · PROCESSING',duration:1100});active(signal);
  applyEffect(model,record);model.journal.push({phase:'processed',eventId:record.eventId,writerVersion:record.writerVersion??1,readerVersion:model.readerVersion});
  await animateCommit(record,signal);member(0).dataset.activity='success';$('.member-state',member(0)).textContent='VALIDATED · PROCESSED';
}
async function schemaSend(schema,signal,schemaId,probe=false) {
  const payload=showJsonProposal(schema);
  const writerVersion=schema.properties.note?2:1;
  if(probe){$('#schema-version').textContent=`CANARY V${writerVersion} · PRODUCTION WRITER V1`;}
  const record=await publish(0,signal,{format:schemaId?'JSON_SCHEMA':'JSON',payload,schemaId,writerVersion});
  await parseJsonRecord(record,signal);return record;
}
async function schemaBaseline(signal) {
  await schemaSend(jsonSchemaV1,signal);
  step('complete','LOCAL CONTRACTS MATCH','Finance validated P0:0 and committed NEXT 1. The two applications agreed on V1 without Registry.');
}
async function invalidPayload(signal) {
  const payload=showJsonProposal(incompatibleJsonSchema);
  const record=await publish(0,signal,{format:'JSON',payload,writerVersion:2});
  await parseJsonRecord(record,signal);
  step('complete','APP LOGIC · VALIDATION FAILED','P0:1 remains in Kafka. Finance cannot process the renamed field, so committed NEXT stays 1.');
}
async function registration(signal,schema) {
  $('#registry-state').textContent='REGISTERING';$('#lesson-registry').dataset.activity='processing';
  registryDetails();await fly('registry','POST',signal);active(signal);
  const result=registerSchema(model,schema);model.journal.push({phase:'registration',status:result.status,id:result.id});
  $('#registry-state').textContent=result.status===409?'HTTP 409 · INCOMPATIBLE':`ID ${result.id} · V${result.version}`;
  $('#lesson-registry').dataset.activity=result.status===409?'error':'idle';registryDetails();
  await fly('registry',result.status===409?'HTTP 409':`ID ${result.id}`,signal,true);return result;
}
async function registryBaseline(signal) {
  const baseline=await registration(signal,jsonSchemaV1);
  await schemaSend(jsonSchemaV1,signal,baseline.id);
  step('complete','SCHEMA REGISTRY (CONFLUENT)','Schema ID 1 travelled with the event. Finance fetched its writer schema once, then its deployed V1 handler processed P0:0 and committed NEXT 1.');
}
async function rejectedSchema(signal) {
  showJsonProposal(incompatibleJsonSchema,true);
  step('rename-registration','SCHEMA REGISTRY (CONFLUENT)','The producer serializer attempts to register the required rename before publishing.');
  model.rejectionBefore={counts:model.logs.map(p=>p.length),next:[...model.next]};
  const result=await registration(signal,incompatibleJsonSchema);active(signal);
  if(result.status!==409)throw new Error('Required rename must be rejected');
  $('#producer-state').textContent='SERIALIZER FAILED';$('#groups-producer').dataset.activity='error';
  step('complete','SCHEMA REGISTRY (CONFLUENT)','HTTP 409: configured serializer stops this send. P0 still has one V1 record; Finance remains at NEXT 1. Kafka itself did not reject a record.');
}
// Each click performs one beat; the next click either advances or reveals the next beat.
function schemaNavigation() {
  if(lesson!=='schemas')return;
  const next=$('#next-button');
  const complete=scene===4?schemaBeat===3:schemaBeat===0;
  next.disabled=running||paused||(scene===4&&complete);
  next.title=running?'Wait for this beat to finish.':paused?'Resume before continuing.':'';
  next.textContent=running?'Playing…':scene===4
    ? ['Register V2 →','Upgrade Finance →','Upgrade producer →','Show takeaway →','Story complete'][schemaBeat+1]
    : complete?(scene===3?'Safe rollout →':'Next scene →'):['Send V1 →','Send renamed event →','Register and send V1 →','Try rename →'][scene];
  $('#previous-button').disabled=running||(scene===0&&schemaBeat===-1);
  next.setAttribute('aria-label',next.textContent);
}
async function safeEvolution(signal) {
  if(schemaBeat===0){
    showJsonProposal(jsonSchemaV2,true);
    const result=await registration(signal,jsonSchemaV2);
    if(result.status!==200)throw new Error('Optional note V2 must be accepted');
    $('#schema-safe-step').textContent='V2 registered · Finance V1 · producer V1';
    step('safe-registered','SCHEMA REGISTRY (CONFLUENT)','V2 adds optional note. Configured STRICT/BACKWARD accepts it; no application has changed yet.');
  } else if(schemaBeat===1){
    await process({partition:0},signal,{label:'DEPLOY FINANCE V2',duration:1000});
    active(signal);model.readerVersion=2;readerContract();
    model.journal.push({phase:'consumer-upgraded',readerVersion:2,writerVersion:1});
    const record=await schemaSend(jsonSchemaV1,signal,1);
    if(record.offset!==1)throw new Error('Finance V2 must process V1 at P0:1');
    $('#schema-safe-step').textContent='Finance V2 handles V1 · producer still V1';
    step('safe-finance','APP LOGIC','Finance was explicitly upgraded and handled a new V1 record at P0:1. Committed NEXT is 2; Registry did not deploy its code.');
  } else if(schemaBeat===2){
    model.writerVersion=2;model.journal.push({phase:'producer-upgraded',writerVersion:2});
    const record=await schemaSend(jsonSchemaV2,signal,2);
    if(record.offset!==2)throw new Error('Producer V2 must append P0:2');
    $('#schema-safe-step').textContent='Producer V2 → Finance V2 · NEXT 3';
    step('safe-producer','APP LOGIC','Producer V2 sent P0:2 with optional note. Finance V2 handled it and committed NEXT 3.');
  } else {
    $('#schema-safe-step').textContent='Safe rollout · V2 registered · Finance first · producer second';
    step('complete','THE KAFKA WAY','Check compatibility, deploy the consumer, then deploy the producer. A required rename needs staged migration; Registry cannot guarantee business compatibility.');
  }
  active(signal);schemaCheckpoints[schemaBeat]=structuredClone(model);
  update();registryDetails();readerContract();schemaNavigation();
}

function showSchemaCheckpoint(beat) {
  const record=model.logs[0].at(-1);
  $('.member-record',member(0)).textContent=record?`${identity(record)} · ${record.eventId} · V${record.writerVersion}`:'—';
  $('[data-event="DisputeCreated"] small').textContent=record?`${identity(record)} · ${record.eventId}`:'DisputeCreated';
  $('#registry-state').textContent=`ID ${model.schemas.at(-1).id} · READY`;
  if(beat===0){showJsonProposal(jsonSchemaV2,true);$('#schema-safe-step').textContent='V2 registered · Finance V1 · producer V1';step('safe-registered','SCHEMA REGISTRY (CONFLUENT)','V2 adds optional note. Configured STRICT/BACKWARD accepts it; no application has changed yet.');}
  if(beat===1){showJsonProposal(jsonSchemaV1);$('#schema-safe-step').textContent='Finance V2 handles V1 · producer still V1';step('safe-finance','APP LOGIC','Finance was explicitly upgraded and handled P0:1. Committed NEXT is 2; Registry did not deploy its code.');}
  if(beat>=2){showJsonProposal(jsonSchemaV2);$('#schema-safe-step').textContent=beat===3?'Safe rollout · V2 registered · Finance first · producer second':'Producer V2 → Finance V2 · NEXT 3';step(beat===3?'complete':'safe-producer',beat===3?'THE KAFKA WAY':'APP LOGIC',beat===3?'Check compatibility, deploy the consumer, then deploy the producer. A required rename needs staged migration; Registry cannot guarantee business compatibility.':'Producer V2 sent P0:2 with optional note. Finance V2 handled it and committed NEXT 3.');}
  readerContract();registryDetails();update();drawRoutes();schemaNavigation();
}

async function run(signal) {
  await new Promise(requestAnimationFrame);
  active(signal);
  drawRoutes();
  if (lesson === "retries") return retryTraffic(signal);
  if (lesson === "offsets") return;
  if (lesson === "schemas") return scene === 0 ? schemaBaseline(signal) : scene === 1 ? invalidPayload(signal) : scene === 2 ? registryBaseline(signal) : scene === 3 ? rejectedSchema(signal) : safeEvolution(signal);
  if (scene === 0) return healthy(signal);
}

function primeSchemaStartingState(destination) {
  if(destination===0||destination===2)return;
  if(destination>=3)registerSchema(model,jsonSchemaV1);
  const record=appendRecord(model,0,{eventId:'dispute-49328:created',format:destination>=3?'JSON_SCHEMA':'JSON',payload:{dispute_id:12345,order_id:98765,reason:'object_not_received'},schemaId:destination>=3?1:undefined,writerVersion:1});
  model.businessSequence=49329;
  model.position[0]=1;
  model.storedNext[0]=1;
  commitRecord(model,record);
  if(destination>=3){model.cache.push('0:1');model.registryRequests=1;}
  model.readerVersion=1;model.writerVersion=1;
}

function enter(destination, restore = false, showDLQ = false) {
  cancel();
  if (lesson === "retries" || lesson === "schemas" || lesson === "offsets") {
    model = createModel();
    dlqFailureSelected = false;dlqEnabled=lesson==="retries"&&destination===2&&showDLQ;
    checkpoints[destination] = structuredClone(model);
    if(lesson==='schemas')primeSchemaStartingState(destination);
  } else if (restore) model = structuredClone(checkpoints[destination] ?? checkpoints[1] ?? createModel());
  else checkpoints[destination] = structuredClone(model);
  for (const partition of [0, 1]) {
    const record = model.logs[partition][model.position[partition] - 1];
    $(".member-record", member(partition)).textContent = record ? `${identity(record)} · ${record.eventId}` : "—";
  }
  scene = destination;
  if(lesson==='schemas'){schemaBeat=-1;schemaCheckpoints.length=0;}
  if(lesson==='offsets'){
    model.membership='joined';model.assignment=[0];model.processingCounts={};model.lostEvent=null;
    $(':scope > small',member(0)).textContent='P0';
  }
  databaseRecord = null;
  $('#groups-producer').dataset.activity='idle';$('#producer-state').textContent='READY';
  document.querySelectorAll('.event-card').forEach(card=>{$('small',card).textContent=card.dataset.event;});
  if(lesson==='offsets')$('.event-card small').textContent='DisputeResolved · dispute-49328:resolved';
  if(lesson==='retries'){$('#dlq-fail').setAttribute('aria-pressed','false');$('#dlq-fail').textContent='Fail DLQ publication';}
  running = lesson !== 'offsets' && lesson !== 'schemas';
  render();
  schemaNavigation();
  if(lesson==='offsets'||lesson==='schemas'){
    if(lesson==='offsets')syncOffsetControls();
    playback();
    return;
  }
  const signal = controller.signal;
  run(signal).catch((error) => { if (error.name !== "AbortError") console.error(error); }).finally(() => {
    if (!signal.aborted) { running = false; playback(); schemaNavigation(); }
  });
}

$("#next-button").addEventListener("click", () => {
  if(lesson==='offsets'){
    if(running||paused)return;
    if(phase==='complete'){
      if(scene>=definitions.offsets.length-1)return;
      enter(scene+1);
    }
    running=true;syncOffsetControls();playback();
    const signal=controller.signal;
    runOffsetsStory(signal).catch(error=>{if(error.name!=='AbortError')console.error(error);}).finally(()=>{
      if(!signal.aborted){running=false;syncOffsetControls();playback();}
    });
    return;
  }
  if(lesson==='schemas') {
    if(running||paused)return;
    if(scene<4&&schemaBeat===0){enter(scene+1);return;}
    if(scene===4&&schemaBeat===3)return;
    schemaBeat++;running=true;schemaNavigation();playback();
    const signal=controller.signal;
    run(signal).catch(error=>{if(error.name!=='AbortError')console.error(error);}).finally(()=>{if(!signal.aborted){running=false;playback();schemaNavigation();}});
    return;
  }
  if(lesson==='retries'&&scene===2&&phase==='poison-blocked'){
    enter(2,true,true);return;
  }
  if (scene >= definitions[lesson].length - 1) return;
  lastAdvance = performance.now();
  enter(scene + 1);
});
$("#previous-button").addEventListener("click", () => {
  if(lesson==='schemas') {
    if(scene===4&&schemaBeat>=0){
      const prior=schemaBeat-1;
      cancel();model=prior<0?createModel():structuredClone(schemaCheckpoints[prior]);
      if(prior<0)primeSchemaStartingState(4);
      schemaBeat=prior;running=false;render();
      if(prior>=0)showSchemaCheckpoint(prior);
      playback();schemaNavigation();return;
    }
    if(schemaBeat===0){enter(scene);return;}
    if(scene>0){enter(scene-1);return;}
  }
  if(lesson==='retries'&&scene===2&&dlqEnabled){enter(2,true);return;}
  if(scene>0)enter(scene-1,true);
});
$("#reset-button").addEventListener("click", () => {
  cancel();
  model = createModel();
  checkpoints.length = 0;
  document.querySelectorAll(".member-record").forEach((label) => { label.textContent = "—"; });
  $("#database-details").textContent = "Business effects · 0";
  enter(["retries","offsets","schemas"].includes(lesson) ? scene : 0, true, dlqEnabled);
});
document.querySelectorAll("[data-replay]").forEach((button) => button.addEventListener("click", () => enter(Number(button.dataset.replay), true)));
playbackControls.subscribe(({paused: value}) => {
  paused = value;
  playback();
  if (lesson === 'offsets') syncOffsetControls();
  if (lesson === 'schemas') schemaNavigation();
});
$("#scenario-select").addEventListener("change", (event) => location.assign(event.target.value));
if (lesson==='retries') {
  const geometry=new ResizeObserver(()=>requestAnimationFrame(drawRoutes));
  document.querySelectorAll('.node').forEach(node=>geometry.observe(node));
  $('#dlq-fail').addEventListener('click',()=>{dlqFailureSelected=!dlqFailureSelected;$('#dlq-fail').setAttribute('aria-pressed',String(dlqFailureSelected));$('#dlq-fail').textContent=dlqFailureSelected?'DLQ failure selected':'Fail DLQ publication';});
}
if(lesson==='schemas'){const geometry=new ResizeObserver(()=>requestAnimationFrame(drawRoutes));document.querySelectorAll('.node').forEach(node=>geometry.observe(node));}
window.addEventListener("resize", () => requestAnimationFrame(drawRoutes));
enter(0);

import { displayRecordProgress } from "../../shared/scripts/record-progress.js";
import { createPlayback, PACKET_DURATION } from "../../shared/scripts/playback.js";
import { animate } from "motion";
import { partitionForKey } from "./groups-partitioning.js";

const $ = (selector, root = document) => root.querySelector(selector);
const stage = $("#groups-stage");
const svgGroup = $("#groups-paths");
const playbackControls = createPlayback();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const animations = new Set();
const routes = { data: new Map(), control: new Map() };
const scenes = [
  ["THE FINANCE BACKLOG", "One partition, one Finance consumer. What happens when processing cannot keep up?", ""],
  ["A GROUP OF ONE", "Finance already belongs to a consumer group. Would another member help?", "THE KAFKA WAY"],
  ["A SECOND FINANCE CONSUMER", "Finance B joined the same group. Why is it idle?", ""],
  ["ADD A SECOND PARTITION", "One partition per consumer. What happens to the records already in P0?", ""],
  ["TWO CONSUMERS · SHARED WORK", "New records reach both partitions; the existing backlog stays in P0.", "THE KAFKA WAY"],
  ["A THIRD FINANCE MEMBER", "There are two partitions and three Finance members. What happens to the extra member?", ""],
  ["TWO EVENTS · TWO PARTITIONS", "What do you notice about the event order?", ""],
  ["ONE DISPUTE KEY", "Created and Resolved share a dispute key. Where might they land, and in what order?", ""],
];
const nextLabels = ["Reveal Finance group →", "Add Finance B →", "Add partition P1 →", "Send to both partitions →", "Add Finance C →", "Show unkeyed events →", "Show keyed events →", "Complete"];
const state = {
  scene: 0,
  partitionCount: 1,
  records: [],
  offsets: { orders: [0, 0], message: [0, 0], "finance-disputes": [0, 0] },
  readers: ["A"],
  grouped: true,
  groupRevealed: false,
  rebalancing: false,
  step: "",
  checkpoint: false,
  assignments: { 0: "A" },
  outcome: "",
  processedByGroup: {},
  appliedByGroup: {},
  starts: {},
  acknowledged: {},
  events: [],
};
const history = [];
let busy = false;
let paused = document.hidden;
let producerRoute;
let orderingCheckpoint = null;
let orderingReturn = null;
let flowController = new AbortController();
let laggedMembers = new Set();
let memberTransitionSignal = null;
const activePackets = new Set();

function assertActive(signal) {
  if (signal.aborted) throw new DOMException("Scene changed", "AbortError");
}

async function finishAnimation(animation, signal = flowController.signal) {
  assertActive(signal);
  animations.add(animation);
  const release = playbackControls.track(animation);
  let abort;
  try {
    await Promise.race([
      animation.finished,
      new Promise((resolve, reject) => {
        abort = () => { animation.stop(); reject(new DOMException("Scene changed", "AbortError")); };
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
    assertActive(signal);
  } finally {
    signal.removeEventListener("abort", abort);
    animations.delete(animation);
    release();
  }
}

function cancelFlow() {
  flowController.abort();
  flowController = new AbortController();
  stage.querySelectorAll(".packet:not(#packet-template)").forEach((packet) => packet.remove());
  document.querySelectorAll(".is-processing,.is-receiving,.event-card.is-active").forEach((card) => card.classList.remove("is-processing", "is-receiving", "is-active"));
  document.querySelectorAll(".member-progress i,.progress-fill").forEach((fill) => { fill.style.transform = "scaleX(0)"; });
  $("#coordinator").classList.remove("is-active");
  $('[data-partition="1"]').classList.remove("is-new-partition");
  for (const element of [$("#finance-members"), $('[data-partition="1"]')]) {
    element.style.opacity = "";
    element.style.transform = "";
  }
  paused = playbackControls.paused;
}

function recordIdentity(record) {
  return `P${record.partition}:${record.offset}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Read-only snapshot for browser verification of the synthetic model.
export function simulationSnapshot() {
  return clone({ ...state, busy, paused, pendingMemberTransition: Boolean(memberTransitionSignal && !memberTransitionSignal.aborted) });
}

function restoreProducerEvents() {
  document.querySelectorAll(".event-card").forEach((card) => {
    $("small", card).textContent = card.dataset.event;
    card.classList.remove("is-active");
  });
}

function groupId(member) {
  return "finance-disputes";
}

function targetElement(target) {
  if (target.startsWith("finance-")) return $(`[data-member="${target.slice(8)}"]`);
  return $(`#${target}-card`);
}

function center(element, origin) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2 - origin.left, y: rect.top + rect.height / 2 - origin.top };
}

function edge(element, origin, side) {
  const rect = element.getBoundingClientRect();
  return { x: (side === "right" ? rect.right : rect.left) - origin.left, y: rect.top + rect.height / 2 - origin.top };
}

function path(d, name, hidden = false, control = false) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
  element.setAttribute("d", d);
  element.dataset.route = name;
  element.setAttribute("class", `connection-path${control ? " coordinator-route" : ""}${hidden ? " motion-route" : ""}`);
  if (state.scene >= 1 && (name.includes("orders") || name.includes("message"))) element.classList.add("is-muted");
  svgGroup.append(element);
  return element;
}

function drawRoutes() {
  svgGroup.replaceChildren();
  routes.data.clear();
  routes.control.clear();
  const bounds = stage.getBoundingClientRect();
  $("#groups-connections").setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  const producer = $("#groups-producer");
  const broker = $("#groups-broker");
  const topic = $("#topic-boundary");
  const coordinator = $("#coordinator");
  const brokerRight = broker.getBoundingClientRect().right - bounds.left;
  const coordinatorRight = edge(coordinator, bounds, "right").x + 8;
  const producerEdge = edge(producer, bounds, "right");
  const producerExit = state.scene >= 6 ? edge($(".selection-output"), bounds, "right") : producerEdge;
  const brokerLeft = edge(broker, bounds, "left");
  const producerMiddle = (producerEdge.x + brokerLeft.x) / 2;
  producerRoute = path(`M ${producerExit.x} ${producerExit.y} H ${producerMiddle} V ${brokerLeft.y} H ${brokerLeft.x}`, "producer");

  const targets = ["orders", ...state.readers.map((member) => `finance-${member}`), "message"];
  const entries = targets.map((name) => ({ name, element: targetElement(name) })).filter(({ element }) => element);
  if (!entries.length) return;
  const positions = entries.map(({ name, element }) => ({ name, element, point: edge(element, bounds, "left") }));
  const spineX = (brokerRight + positions[0].point.x) / 2;
  const dataY = center(topic, bounds).y;
  const controlY = center(coordinator, bounds).y;
  const minY = Math.min(...positions.map(({ point }) => point.y), dataY, controlY);
  const maxY = Math.max(...positions.map(({ point }) => point.y), dataY, controlY);

  path(`M ${brokerRight} ${dataY} H ${spineX}`, "broker-entry");
  path(`M ${coordinatorRight} ${controlY} H ${spineX}`, "coordinator-entry", false, true);
  path(`M ${spineX} ${minY} V ${maxY}`, "consumer-spine");
  positions.forEach(({ name, point }) => path(`M ${spineX} ${point.y} H ${point.x}`, `branch-${name}`));

  for (const { name, point } of positions) {
    routes.data.set(name, path(`M ${brokerRight} ${dataY} H ${spineX} V ${point.y} H ${point.x}`, `data-${name}`, true));
    routes.control.set(name, path(`M ${coordinatorRight} ${controlY} H ${spineX} V ${point.y} H ${point.x}`, `control-${name}`, true, true));
  }
  activePackets.forEach(packet => positionPacket(packet, Number(packet.dataset.progress)));
}

function positionPacket(packet, progress) {
  packet.dataset.progress = String(progress);
  const route = svgGroup.querySelector(`[data-route="${packet.dataset.route}"]`);
  if (!route) return;
  const fraction = packet.dataset.reverse === "true" ? 1 - progress : progress;
  const point = route.getPointAtLength(route.getTotalLength() * fraction);
  packet.style.transform = `translate(${point.x - packet.offsetWidth / 2}px, ${point.y - packet.offsetHeight / 2}px)`;
  const bounds = stage.getBoundingClientRect();
  const left = (packet.dataset.route === "producer" ? $("#groups-producer") : $("#groups-broker")).getBoundingClientRect().right - bounds.left;
  const right = (packet.dataset.route === "producer" ? $("#groups-broker") : $("#orders-card")).getBoundingClientRect().left - bounds.left;
  const label = $("small", packet);
  label.style.maxWidth = `${right - left - 6}px`;
  const half = label.getBoundingClientRect().width / 2;
  const desired = Math.max(left + half + 3, Math.min(right - half - 3, point.x));
  label.style.left = `${desired - point.x + packet.offsetWidth / 2}px`;
  const placed = [];
  for (const active of activePackets) $("small", active).style.bottom = "17px";
  for (const active of activePackets) {
    const current = $("small", active);
    for (let attempt = 0; attempt < activePackets.size; attempt += 1) {
      const rect = current.getBoundingClientRect();
      const collides = placed.some(other => Math.min(rect.right, other.right) > Math.max(rect.left, other.left) && Math.min(rect.bottom, other.bottom) > Math.max(rect.top, other.top));
      if (!collides) break;
      current.style.bottom = `${parseFloat(current.style.bottom) + rect.height + 3}px`;
    }
    placed.push(current.getBoundingClientRect());
  }
}

function setActive(route) {
  route?.classList.add(route.dataset.route.startsWith("control-") ? "is-control-active" : "is-active");
}

async function fly(route, label, { reverse = false } = {}) {
  const signal = flowController.signal;
  assertActive(signal);
  if (!route) return;
  if (state.scene >= 1 && /^(data|control)-(orders|message)$/.test(route.dataset.route)) {
    // Keep the modeled delivery timing; only hide the background group's traffic.
    await wait(PACKET_DURATION);
    return;
  }
  const token = $("#packet-template").cloneNode(true);
  token.removeAttribute("id");
  token.hidden = false;
  token.style.display = "grid";
  token.dataset.route = route.dataset.route;
  token.dataset.reverse = String(reverse);
  token.classList.toggle("packet--control", route.dataset.route.startsWith("control-"));
  $("small", token).textContent = label;
  stage.append(token);
  activePackets.add(token);
  positionPacket(token, 0);
  setActive(route);
  const animation = animate(0, 1, { duration: playbackControls.duration(PACKET_DURATION) / 1000, ease: "linear", onUpdate: value => { if (!signal.aborted) positionPacket(token, value); } });
  try { await finishAnimation(animation, signal); }
  finally { activePackets.delete(token); token.remove(); svgGroup.querySelector(`[data-route="${route.dataset.route}"]`)?.classList.remove("is-active", "is-control-active"); }
}

function wait(duration) {
  return playbackControls.wait(duration, {signal: flowController.signal});
}

function groupLag(id, partition = null) {
  const next = (state.offsets[id] ?? [0, 0]).map((offset, partition) => offset ?? state.starts[id]?.[partition] ?? 0);
  return state.records.reduce((total, record) => total + Number((partition === null || record.partition === partition) && record.offset >= next[record.partition]), 0);
}

function updateOffsets() {
  const format = (group, values = state.offsets) => Array.from({ length: state.partitionCount }, (_, partition) =>
    `P${partition} · ${values[group]?.[partition] === null ? `UNCOMMITTED · START ${state.starts[group]?.[partition] ?? 0}` : `NEXT ${values[group]?.[partition] ?? 0}`}`).join("\n");
  $("#coordinator").classList.toggle("finance-focus", state.scene > 0);
  $("#orders-offset").textContent = format("orders");
  $("#message-offset").textContent = format("message");
  $("#finance-offset").textContent = format("finance-disputes");
  $("#orders-next").textContent = format("orders", state.acknowledged);
  $("#message-next").textContent = format("message", state.acknowledged);
  for (const id of state.readers) {
    const group = groupId(id);
    const partitions = state.grouped ? Object.entries(state.assignments).filter(([, member]) => member === id).map(([p]) => Number(p)) : Array.from({length:state.partitionCount},(_,p)=>p);
    const card = targetElement(`finance-${id}`);
    const label = card && $(".member-next", card);
    if (label) label.textContent = partitions.map(p => {
      const acknowledged = state.acknowledged[group]?.[p];
      return acknowledged === null
        ? `P${p} · START ${state.starts[group]?.[p] ?? 0} · UNCOMMITTED`
        : `P${p} · NEXT ${acknowledged ?? 0}`;
    }).join(" · ");
  }
  $("#coordinator-state").textContent = state.rebalancing ? "REBALANCING" : state.scene > 0 ? "FINANCE GROUP OFFSETS" : "INDEPENDENT GROUP OFFSETS";
  updateFinanceLagUI();
}

function updateFinanceLagUI() {
  for (const id of state.readers) {
    const card = $(`[data-member="${id}"]`);
    if (!card) continue;
    const group = state.grouped ? "finance-disputes" : groupId(id);
    const partitions = state.grouped
      ? Object.entries(state.assignments).filter(([, member]) => member === id).map(([partition]) => Number(partition))
      : [null];
    const lag = partitions.reduce((total, partition) => total + groupLag(group, partition), 0);
    $(".member-lag", card).textContent = partitions.length ? `LAG ${lag}` : "LAG —";
    if (!partitions.length || state.rebalancing) continue;
    if (lag > 1) laggedMembers.add(id);
    const behind = state.scene <= 3 && (lag > 1 || (lag > 0 && laggedMembers.has(id)));
    if (!lag) laggedMembers.delete(id);
    if (card.dataset.activity !== "error") card.dataset.activity = behind ? "lagging" : card.classList.contains("is-processing") ? "processing" : "idle";
    const status = $(".member-state", card);
    if (status && ["WAITING", "IDLE", "LAGGING"].includes(status.textContent)) status.textContent = behind ? "LAGGING" : "IDLE";
  }
}

function updateRecordWindow() {
  for (let partition = 0; partition < 2; partition += 1) {
    const row = $(`[data-partition="${partition}"]`);
    row.classList.toggle("is-hidden", partition >= state.partitionCount);
    const window = $(".record-window", row);
    window.replaceChildren();
    const records = state.records.filter((record) => record.partition === partition);
    for (const record of records.slice(-4)) {
      const entry = document.createElement("span");
      entry.className = "stored-record";
      const dot = document.createElement("span");
      const trackedGroups = state.scene === 0 ? ["orders", "message", "finance-disputes"] : ["finance-disputes"];
      dot.className = "record-dot";
      dot.textContent = String(record.offset);
      dot.title = `${record.event} · ${record.dispute} · P${partition} offset ${record.offset}${record.key ? ` · key ${record.key}` : " · no key"}`;
      displayRecordProgress(dot, record, { groups: trackedGroups, nextByGroup: state.acknowledged, scope: window, playback: playbackControls,
        failed: state.events.some(e => e.phase === "rejected" && e.record === recordIdentity(record)) && (state.acknowledged["finance-disputes"]?.[partition] ?? 0) <= record.offset });
      const label = document.createElement("small");
      label.textContent = record.event === "DisputeCreated" ? "CREATED" : "RESOLVED";
      entry.append(dot, label);
      window.append(entry);
    }
    $(".record-count", row).textContent = `${records.length}`;
  }
  $("#broker-state").textContent = state.records.length ? "RECORDS APPENDED" : "READY";
  $("#broker-note").textContent = state.partitionCount === 1 ? "P0 partition leader · one ordered log" : "P0 and P1 · separate logs";
}

function renderFinanceMembers() {
  const wrapper = $("#finance-members");
  wrapper.replaceChildren();
  wrapper.classList.toggle("finance-group-boundary", state.groupRevealed);
  wrapper.dataset.groupLabel = `FINANCE GROUP · finance-disputes · ${state.readers.length} ${state.readers.length === 1 ? "MEMBER" : "MEMBERS"}`;
  const visible = state.readers.slice();
  for (const id of visible) {
    const card = document.createElement("div");
    card.className = "finance-member";
    card.dataset.member = id;
    card.dataset.activity = "idle";
    const name = document.createElement("strong");
    name.textContent = `Finance ${id}`;
    const meta = document.createElement("small");
    const assigned = state.grouped ? Object.entries(state.assignments).filter(([, member]) => member === id).map(([partition]) => `P${partition}`).join(" + ") : "P0 + P1 · reads full topic";
    meta.textContent = state.rebalancing ? "WAITING FOR ASSIGNMENT" : assigned ? `ASSIGNED · ${assigned}` : "NO PARTITIONS ASSIGNED";
    const lag = document.createElement("span");
    lag.className = "member-lag";
    const memberState = document.createElement("span");
    memberState.className = "member-state";
    memberState.textContent = state.rebalancing ? "REBALANCING" : assigned ? "WAITING" : "IDLE";
    const offsetGroup = state.grouped ? "finance-disputes" : groupId(id);
    const memberPartitions = state.grouped
      ? Object.entries(state.assignments).filter(([, member]) => member === id).map(([partition]) => Number(partition))
      : [null];
    const memberLag = memberPartitions.reduce((total, partition) => total + groupLag(offsetGroup, partition), 0);
    lag.textContent = assigned ? `LAG ${memberLag}` : "LAG —";
    const progress = document.createElement("div");
    progress.className = "member-progress";
    progress.setAttribute("aria-hidden", "true");
    const fill = document.createElement("i");
    progress.append(fill);
    card.append(name, meta, lag, memberState, progress);
    const recordLabel = document.createElement("small");
    recordLabel.className = "member-record";
    const lastCommit = state.events.findLast(event => event.phase === "commit-ack" && event.member === `finance-${id}`);
    const lastRecord = lastCommit && state.records.find(record => recordIdentity(record) === lastCommit.record);
    recordLabel.textContent = lastRecord ? `${recordIdentity(lastRecord)} · ${lastRecord.event === "DisputeCreated" ? "CREATED" : "RESOLVED"}` : "—";
    if (state.outcome === "failed" && state.assignments[1] === id) {
      card.dataset.activity = "error";
      memberState.textContent = "FAILED";
      const failedRecord = state.records.find((record) => record.partition === 1 && record.offset === state.offsets["finance-disputes"][1]);
      if (failedRecord) recordLabel.textContent = `${recordIdentity(failedRecord)} · RESOLVED`;
    }
    const recordHistory = document.createElement("small");
    recordHistory.className = "member-history";
    const recordDetails = document.createElement("div");
    recordDetails.className = "member-records";
    recordDetails.append(recordLabel, recordHistory);
    card.append(recordDetails);
    const nextLabel = document.createElement("small");
    nextLabel.className = "member-next";
    card.append(nextLabel);
    if (!assigned && !state.rebalancing) card.classList.add("is-idle");
    wrapper.append(card);
  }
  updateFinanceOutcome();
}

function updateFinanceOutcome() {
  const status = $("#finance-state");
  status.textContent = state.outcome ? (state.outcome === "failed" ? "FAILED" : "PROCESSED") : state.grouped ? "GROUP ACTIVE" : "READY";
  $("#finance-card").dataset.activity = state.outcome === "failed" ? "failed" : "idle";
  const outcome = $("#finance-outcome");
  outcome.hidden = !state.outcome;
  outcome.dataset.outcome = state.outcome;
  outcome.textContent = state.outcome === "failed" ? "FAILED · APP LOGIC" : state.outcome === "success" ? "SUCCESS" : "";

}

function render() {
  $("#partition-selection").hidden = state.scene < 6;
  $(".producer-events").hidden = state.scene >= 6;
  const scene = scenes[state.scene];
  $("#scene-heading").textContent = scene[0];
  $("#scene-counter").textContent = `${state.scene + 1} / ${scenes.length}`;
  $("#scene-number").textContent = "02";
  $("#prompt-label").textContent = scene[2];
  $("#scene-prompt").textContent = scene[1];
  if (state.scene === 5) { $("#prompt-label").textContent = "THE KAFKA WAY"; $("#scene-prompt").textContent = "Assigned members cannot outnumber the subscribed partitions."; }
  if (state.scene === 4 && !busy) { $("#prompt-label").textContent = "THE KAFKA WAY"; $("#scene-prompt").textContent = "One group shares the work: P0 → A, P1 → B. Each partition has one assigned member."; }
  if (state.scene === 6 && state.outcome === "failed") { $("#prompt-label").textContent = "WHAT CAN GO WRONG?"; $("#scene-prompt").textContent = "APP LOGIC · Resolved arrived before Created was applied. The failed record remains uncommitted."; }
  if (state.scene === 7 && state.outcome === "success") { $("#prompt-label").textContent = "THE KAFKA WAY"; $("#scene-prompt").textContent = "Ordering holds within a partition, with unchanged partitioning and ordered processing."; }
  $("#consumer-column-note").textContent = state.scene === 0 ? "3 INDEPENDENT GROUPS" : "FINANCE · ONE SHARED GROUP";
  $("#group-partition-count")?.remove();
  if (!$(".event-card.is-active")) $("#producer-state").textContent = state.records.length ? "APPENDED" : "READY";
  $("#producer-note").textContent = state.scene === 6
    ? "One possible unkeyed placement"
    : state.scene === 7
      ? "Two sends · same key"
      : state.scene >= 3 ? "Illustrative producer partitioning · both partitions" : "Does not wait for consumers";
  $("#finance-card").dataset.activity = "idle";
  updateFinanceOutcome();
  updateRecordWindow();
  updateOffsets();

  $("#orders-card").classList.toggle("is-deemphasized", state.scene >= 1);
  $("#message-card").classList.toggle("is-deemphasized", state.scene >= 1);
  $("#group-rate")?.remove();
  $("#flow-state span").textContent = document.hidden ? "PAUSED · tab hidden" : paused ? "PAUSED" : busy ? "PLAYING" : "LIVE";
  $("#flow-state").classList.toggle("is-paused", paused);
  $("#flow-state").classList.toggle("is-playing", (busy) && !paused);
  $("#previous-button").disabled = state.scene === 0;
  $("#next-button").disabled = busy || state.scene === scenes.length - 1;
  $("#next-button").title = busy ? "Transition in progress; wait for this step to finish" : "Advance to the next scene";
  $("#next-button").textContent = nextLabels[state.scene];
  $("#pause-button").disabled = false;
  $("#reset-button").disabled = false;
  $("#replay-unkeyed").disabled = false;
  $("#replay-keyed").disabled = false;
  $("#replay-scene").hidden = state.scene >= 6;
  $("#replay-unkeyed").hidden = false;
  $("#replay-keyed").hidden = false;
  $("#pause-button").textContent = paused ? "▶ Resume" : "Ⅱ Pause";
  $("#pause-button").setAttribute("aria-pressed", String(paused));
  if (state.step) { $("#prompt-label").textContent = state.rebalancing ? "REBALANCING" : "CURRENT STEP"; $("#scene-prompt").textContent = state.step; }
  if (state.checkpoint && !busy && !paused) $("#flow-state span").textContent = "SCENE READY";
  requestAnimationFrame(drawRoutes);
}

function appendRecord(event, partition, dispute, key = null) {
  const offset = state.records.filter((record) => record.partition === partition).length;
  const record = { event, partition, dispute, key, offset };
  state.records.push(record);
  state.events.push({phase:"append",scene:state.scene,record:recordIdentity(record),event,dispute,partition,key});
  updateRecordWindow();
  updateFinanceLagUI();
  return record;
}

async function showPartitionSelection(event, partition, key) {
  const signal = flowController.signal;
  const source = $("#selection-key"), method = $("#selection-method"), result = $("#selection-result");
  const isKeyed = key !== null;
  document.querySelectorAll(".event-card.is-active").forEach(card => card.classList.remove("is-active"));
  const card = $(`[data-event="${event}"]`);
  card.classList.add("is-active");
  $("small", card).textContent = isKeyed ? `SELECTING · KEY ${key}` : "SELECTING · NO KEY";
  const eventName = event === "DisputeCreated" ? "Dispute Created" : "Dispute Resolved";
  $("#selection-event").textContent = eventName;
  $("#selection-output-event").textContent = eventName;
  source.textContent = isKeyed ? `Key supplied: ${key}` : "No key supplied";
  method.textContent = isKeyed ? "Hash key" : "Select partition";
  result.textContent = "P?";
  $("#selection-note").textContent = isKeyed ? "Same key + same partition count → same partition" : "One possible distribution · Related messages may go to different partitions";
  for (const phase of ["input", "method", "selected"]) {
    assertActive(signal);
    source.dataset.active = String(phase === "input");
    method.dataset.active = String(phase === "method");
    result.dataset.active = String(phase === "selected");
    if (phase === "method") method.textContent = isKeyed ? "Hash key" : "Select partition";
    if (phase === "selected") {
      result.textContent = `P${partition}`;
      $("#selection-output-event").textContent = `${eventName} · ready to send`;
    }
    $("#producer-state").textContent = phase === "selected" ? "PARTITION SELECTED" : "SELECTING PARTITION";
    state.events.push({phase:"partition-selection",stage:phase,event,key,partition,method:isKeyed?"hash":"sticky"});
    drawRoutes();
    const link = phase === "input" ? $("#selection-input-link") : phase === "method" ? $("#selection-output-link") : null;
    if (link) {
      $("i", link).dataset.label = `${event === "DisputeCreated" ? "CREATED" : "RESOLVED"}${phase === "method" ? ` · P${partition}` : ""}`;
      link.classList.add("is-travelling");
      try { await playbackControls.wait(PACKET_DURATION, { signal, progress: value => { link.style.setProperty("--travel", `${value * 100}%`); } }); }
      finally { link.classList.remove("is-travelling"); }
    } else await wait(650);
  }
  assertActive(signal);
}

async function publish(event, partition, dispute, key = null) {
  const signal = flowController.signal;
  if (state.scene >= 6) {
    if (key !== null) partition = partitionForKey(key, state.partitionCount);
    await showPartitionSelection(event, partition, key);
    assertActive(signal);
  }
  $("#producer-state").textContent = "PUBLISHING";
  const producerEvent = $(`[data-event="${event}"]`);
  const detail = $("small", producerEvent);
  document.querySelectorAll(".event-card.is-active").forEach((card) => card.classList.remove("is-active"));
  producerEvent?.classList.add("is-active");
  if (detail) detail.textContent = `SENDING · ${dispute}${key ? ` · KEY ${key}` : " · NO KEY"}`;
  await new Promise(requestAnimationFrame);
  assertActive(signal);
  await fly(producerRoute, `${event === "DisputeCreated" ? "SEND · CREATED" : "SEND · RESOLVED"}${state.scene >= 6 ? ` · P${partition}` : ""}`);
  const record = appendRecord(event, partition, dispute, key);
  if (detail) detail.textContent = `P${partition}:${record.offset} · ${dispute}${key ? ` · KEY ${key}` : ""}`;
  $("#producer-state").textContent = "APPENDED";
  producerEvent?.classList.remove("is-active");
  return record;
}

async function progress(target, duration = 500) {
  const card = targetElement(target);
  const fill = target.startsWith("finance-") ? $(".member-progress i", card) : $(".progress-fill", card);
  const activeCard = target.startsWith("finance-") ? card : card;
  if (state.scene === 0 || target.startsWith("finance-")) activeCard.classList.add("is-processing");
  if (target.startsWith("finance-")) {
    card.dataset.activity = "processing";
    $(".member-state", card).textContent = "PROCESSING";
  }
  const animation = animate(fill, { scaleX: [0, 1] }, { duration: reducedMotion ? 0.1 : duration / 1000, ease: "linear" });
  updateFinanceLagUI();
  await finishAnimation(animation);
  fill.style.transform = "scaleX(0)";
  activeCard.classList.remove("is-processing");
  if (target.startsWith("finance-")) updateFinanceLagUI();
}

async function readRecord(record, target, group, { processTime = 420, commit = true, poll = true, existing = false, onProcessing, batchRecords = null } = {}) {
  const signal = flowController.signal;
  const dataRoute = routes.data.get(target);
  const card = targetElement(target);
  const status = target.startsWith("finance-") ? $(".member-state", card) : $(`#${target}-state`);
  if (status) status.textContent = "POLLING";
  if (poll) await fly(dataRoute, `POLL P${record.partition}`, { reverse: true });
  const eventLabel = record.event === "DisputeCreated" ? "CREATED" : "RESOLVED";
  const identity = batchRecords ? `P${record.partition}:${batchRecords[0].offset}–${record.offset}` : recordIdentity(record);
  await fly(dataRoute, `${batchRecords ? "BATCH · " : ""}${eventLabel} · ${identity}`);
  state.events.push({phase:"received",scene:state.scene,member:target,group,record:recordIdentity(record)});
  if (state.scene === 0 || target.startsWith("finance-")) card.classList.add("is-receiving");
  if (status) status.textContent = "PROCESSING";
  if (target.startsWith("finance-")) {
    card.dataset.activity = "processing";
    $(".member-record", card).textContent = `${identity} · ${eventLabel}`;
  }
  onProcessing?.(record);
  await progress(target, processTime);
  assertActive(signal);
  card.classList.remove("is-receiving");
  const applied = state.appliedByGroup[group] ??= [];
  if (record.event === "DisputeResolved" && !applied.includes(record.dispute)) commit = false;
  if (record.event === "DisputeCreated") {
    for (const entry of batchRecords ?? [record]) if (!applied.includes(entry.dispute)) applied.push(entry.dispute);
  }
  if (!commit) {
    state.events.push({phase:"rejected",scene:state.scene,member:target,group,record:recordIdentity(record)});
    card.dataset.activity = "error";
    if (status) status.textContent = "FAILED";
    return;
  }
  for (const entry of batchRecords ?? [record]) state.events.push({phase:"processed",scene:state.scene,member:target,group,record:recordIdentity(entry)});
  state.acknowledged[group] ??= [...state.offsets[group]];
  // Teaching abstraction: the successful offset commit completes without packet animation.
  state.offsets[group][record.partition] = Math.max(state.offsets[group][record.partition], record.offset + 1);
  state.events.push({phase:"commit-stored",scene:state.scene,member:target,group,record:recordIdentity(record),next:record.offset+1});
  state.acknowledged[group][record.partition] = state.offsets[group][record.partition];
  state.events.push({phase:"commit-ack",scene:state.scene,member:target,group,record:recordIdentity(record),next:record.offset+1});
  updateOffsets();
  updateRecordWindow();
  if (status) status.textContent = "WAITING";
  if (target.startsWith("finance-")) {
    const member = target.slice("finance-".length);
    const groupIdForMember = state.grouped ? "finance-disputes" : groupId(member);
    const processed = state.processedByGroup[groupIdForMember] ??= [];
    for (const processedRecord of batchRecords ?? [record]) {
      const processedIdentity = recordIdentity(processedRecord);
      if (!processed.includes(processedIdentity)) processed.push(processedIdentity);
    }
    if (processed.length > 24) processed.splice(0, processed.length - 24);

  }
  updateFinanceLagUI();
}

// Live traffic remains independent of Finance's pace and group coordination.
async function consumeContinuously(group, target, slow = false) {
  const signal = flowController.signal;
  while (true) {
    assertActive(signal);
    const partitions = slow
      ? Object.entries(state.assignments).filter(([, member]) => `finance-${member}` === target).map(([partition]) => Number(partition))
      : Array.from({length:state.partitionCount}, (_, partition) => partition);
    const record = nextGroupRecord(group, partitions);
    if (!record) { await wait(50); continue; }
    const batch = slow ? [record] : state.records.filter(entry => entry.partition === record.partition && entry.offset >= record.offset);
    await readRecord(batch.at(-1), target, group, {
      processTime: slow ? 6500 : 360 * batch.length,
      batchRecords: batch.length > 1 ? batch : null,
    });
    assertActive(signal);
    if (slow && state.scene === 0 && busy) {
      busy = false;
      history[0] = clone(state);
      render();
    }
  }
}

function startFinanceTraffic() {
  Promise.all(state.readers.map(member => consumeContinuously("finance-disputes", `finance-${member}`, true)))
    .catch(error => { if (error.name !== "AbortError") console.error(error); });
}

function startOtherTraffic() {
  const signal = flowController.signal;
  const producer = async () => {
    while (true) {
      assertActive(signal);
      const index = state.records.length;
      const partition = state.partitionCount === 2 && !state.rebalancing && state.assignments[1] ? index % 2 : 0;
      await publish("DisputeCreated", partition, String(900000 + index));
      await wait(900);
    }
  };
  Promise.all([producer(), consumeContinuously("orders", "orders"), consumeContinuously("message", "message")])
    .catch(error => { if (error.name !== "AbortError") console.error(error); });
}

async function runIntro() {
  busy = (state.offsets["finance-disputes"]?.[0] ?? 0) === 0;
  state.checkpoint = false;
  renderFinanceMembers();
  render();
  startOtherTraffic();
  startFinanceTraffic();
}

function nextGroupRecord(group, partitions, preferredPartitions = []) {
  const order = [...preferredPartitions, ...partitions.filter((partition) => !preferredPartitions.includes(partition))];
  for (const partition of order) {
    const nextOffset = state.offsets[group]?.[partition] ?? state.starts[group]?.[partition] ?? 0;
    const record = state.records.find((item) => item.partition === partition && item.offset === nextOffset);
    if (record) return record;
  }
  return null;
}

function setStep(text) {
  state.step = text;
  state.events.push({ phase: "teaching-step", scene: state.scene, text });
  render();
}

async function reveal(element) {
  await finishAnimation(animate(element, { opacity: [0, 1], scale: [0.94, 1] }, {
    duration: playbackControls.duration(1300) / 1000,
    ease: "easeOut", onUpdate: drawRoutes,
  }));
  drawRoutes();
}

async function revealGroup() {
  state.groupRevealed = true;
  renderFinanceMembers();
  setStep("This is the existing Finance group — currently one member, assigned P0.");
  await reveal($("#finance-members"));
  await wait(700);
  state.step = "";
  state.checkpoint = true;
}

// Illustrative classic-group rebalance: stop data traffic, show coordination,
// then reveal each assignment separately. This is not a protocol packet trace.
async function rebalance(assignments) {
  state.rebalancing = true;
  state.assignments = {};
  renderFinanceMembers();
  setStep("Finance pauses for reassignment. Production and the other groups keep working.");
  $("#coordinator").classList.add("is-active");
  await wait(1000);
  for (const [partition, member] of Object.entries(assignments)) {
    setStep(`Assign P${partition} to Finance ${member}.`);
    await fly(routes.control.get(`finance-${member}`), `ASSIGN P${partition} → ${member}`);
    state.assignments[partition] = member;
    state.events.push({phase:"assigned",scene:state.scene,partition:Number(partition),member});
    const card = targetElement(`finance-${member}`);
    $("small", card).textContent = `ASSIGNED · P${partition}`;
    $(".member-state", card).textContent = "ASSIGNED";
    await finishAnimation(animate(card, { backgroundColor: ["#ede6fa", "#ffffff"] }, {duration: playbackControls.duration(800) / 1000}));
    updateOffsets();
  }
  state.rebalancing = false;
  $("#coordinator").classList.remove("is-active");
  renderFinanceMembers();
  state.step = "";
  render();
  $("#coordinator-state").textContent = "PARTITIONS ASSIGNED";
  await wait(500);
}

async function addReader() {
  state.readers.push("B");
  renderFinanceMembers();
  setStep("Finance B joins the same finance-disputes group.");
  await reveal(targetElement("finance-B"));
  await fly(routes.control.get("finance-B"), "JOIN GROUP · B", { reverse: true });
  await rebalance({0:"A"});
  state.step = "One partition, two members: Finance A owns P0; Finance B has no partition and stays idle.";
  state.checkpoint = true;
}

async function addPartition() {
  state.partitionCount = 2;
  state.offsets["finance-disputes"][1] = null;
  state.acknowledged["finance-disputes"][1] = null;
  state.starts["finance-disputes"] = [0, 0];
  setStep("Add an empty partition P1. Existing records stay in P0.");
  const row = $('[data-partition="1"]');
  row.classList.add("is-new-partition");
  await reveal(row);
  await wait(800);
  row.classList.remove("is-new-partition");
  await rebalance({0:"A",1:"B"});
  state.step = "P0 → Finance A · P1 → Finance B. New records use both partitions; the old backlog stays in P0.";
  state.checkpoint = true;
}

async function showParallel() {
  setStep("Live traffic: Finance A reads P0 and Finance B reads P1. Orders and Message Center continue independently.");
  state.checkpoint = false;
}

async function addIdleMember() {
  state.readers.push("C");
  renderFinanceMembers();
  setStep("Finance C joins the same group. There are still only two partitions.");
  await reveal(targetElement("finance-C"));
  await fly(routes.control.get("finance-C"), "JOIN GROUP · C", {reverse:true});
  await rebalance({0:"A",1:"B"});
  state.checkpoint = true;
}

function startOrderingExample(keyed) {
  // New teaching example, not a Kafka topic/offset reset during normal operation.
  state.records = [];
  state.events = [];
  state.offsets = { orders: [0, 0], message: [0, 0], "finance-disputes": [0, 0] };
  state.acknowledged = { orders: [0, 0], message: [0, 0], "finance-disputes": [0, 0] };
  state.starts = {};
  state.processedByGroup = {};
  state.appliedByGroup = {};
  state.outcome = "";
  state.checkpoint = false;
  state.rebalancing = false;
  restoreProducerEvents();
  renderFinanceMembers();
  setStep(keyed ? "NEW EXAMPLE · The producer hashes the same key to select the same partition." : "NEW EXAMPLE · One possible unkeyed placement: Created goes to P0, Resolved to P1.");
}

async function showUnkeyed() {
  startOrderingExample(false);
  orderingCheckpoint = clone(state);
  $("#replay-unkeyed").disabled = false;
  $("#replay-keyed").disabled = false;
  const created = await publish("DisputeCreated", 0, "49340");
  const resolved = await publish("DisputeResolved", 1, "49340");
  await readRecord(resolved, "finance-B", "finance-disputes", { processTime: 700, commit: false, poll: true });
  state.outcome = "failed";
  $("#finance-outcome").hidden = false;
  $("#finance-outcome").dataset.outcome = "failed";
  $("#finance-outcome").textContent = "FAILED · APP LOGIC";
  $("#prompt-label").textContent = "WHAT CAN GO WRONG?";
  $("#scene-prompt").textContent = "APP LOGIC · Resolved arrived before Created was applied. The failed record remains uncommitted.";
  await readRecord(created, "finance-A", "finance-disputes", { processTime: 500 });
  state.step = "";
  state.scene = 6;
}

async function showKeyed() {
  const signal = flowController.signal;
  startOrderingExample(true);
  await new Promise(requestAnimationFrame);
  assertActive(signal);
  const partition = partitionForKey("dispute-49341", state.partitionCount);
  const created = await publish("DisputeCreated", partition, "49341", "dispute-49341");
  const resolved = await publish("DisputeResolved", partition, "49341", "dispute-49341");
  await readRecord(created, `finance-${state.assignments[partition]}`, "finance-disputes", { processTime: 650 });
  await readRecord(resolved, `finance-${state.assignments[partition]}`, "finance-disputes", { processTime: 650 });
  state.outcome = "success";
  updateFinanceOutcome();
  $("#prompt-label").textContent = "THE KAFKA WAY";
  $("#scene-prompt").textContent = "Ordering holds within a partition, with unchanged partitioning and ordered processing.";
  state.step = "";
  state.scene = 7;
}


async function advance() {
  if (busy) return;
  if (memberTransitionSignal && !memberTransitionSignal.aborted) return;
  if (state.scene >= scenes.length - 1) return;
  const currentScene = state.scene;
  const transitions = [revealGroup, addReader, addPartition, showParallel, addIdleMember, showUnkeyed, showKeyed];
  const transition = transitions[currentScene];
  history[currentScene] = clone(state);
  cancelFlow();
  restoreProducerEvents();
  const signal = flowController.signal;
  if (currentScene === 4) memberTransitionSignal = signal;
  busy = true;
  try {
    state.step = "";
    state.checkpoint = false;
    state.scene = currentScene + 1;
    render();
    history[state.scene] = clone(state);
    if (state.scene < 6) startOtherTraffic();
    await transition();
    assertActive(signal);
    if (state.scene < 6) { state.checkpoint = false; startFinanceTraffic(); }
    history[state.scene] = clone(state);
  } catch (error) {
    if (error.name !== "AbortError") console.error(error);
  } finally {
    if (memberTransitionSignal === signal) memberTransitionSignal = null;
    if (!signal.aborted) { busy = false; render(); }
  }
}

async function previous() {
  if (state.scene === 0) return;
  cancelFlow();
  busy = false;
  const restored = state.scene === 6 && orderingReturn ? orderingReturn : history[state.scene - 1];
  if (state.scene === 6) orderingReturn = null;
  Object.assign(state, clone(restored));
  history.splice(state.scene + 1);
  restoreProducerEvents();
  laggedMembers = new Set(state.scene === 0 ? ["A"] : []);
  renderFinanceMembers();
  busy = false;
  render();
  if (state.scene === 0) {
    runIntro().catch(error => { if (error.name !== "AbortError") console.error(error); });
  } else if (state.scene < 6) {
    state.checkpoint = false; startOtherTraffic(); startFinanceTraffic();
  }
}

async function reset() {
  cancelFlow();
  paused = playbackControls.paused;
  Object.assign(state, {
    scene: 0,
    partitionCount: 1,
    records: [],
    offsets: { orders: [0, 0], message: [0, 0], "finance-disputes": [0, 0] },
    readers: ["A"],
    grouped: true,
    groupRevealed: false,
    rebalancing: false,
    step: "",
    checkpoint: false,
    assignments: { 0: "A" },
    outcome: "",
      processedByGroup: {},
    appliedByGroup: {},
    starts: {},
    acknowledged: {},
    events: [],
  });
  orderingCheckpoint = null;
  orderingReturn = null;
  laggedMembers.clear();
  restoreProducerEvents();
  history.length = 0;
  busy = false;
  try { await runIntro(); } catch (error) { if (error.name !== "AbortError") console.error(error); }
}

playbackControls.subscribe(({paused: value}) => {
  paused = value;
  $("#flow-state span").textContent = document.hidden ? "PAUSED · tab hidden" : paused ? "PAUSED" : busy ? "PLAYING" : state.checkpoint ? "SCENE READY" : "LIVE";
  $("#flow-state").classList.toggle("is-paused", paused);
  $("#flow-state").classList.toggle("is-playing", (busy) && !paused);
});
$("#next-button").addEventListener("click", advance);
$("#previous-button").addEventListener("click", previous);
$("#reset-button").addEventListener("click", reset);
$("#replay-scene").addEventListener("click", async () => {
  if (state.scene === 0) return reset();
  const scene = state.scene;
  cancelFlow();
  Object.assign(state, clone(history[scene - 1]));
  busy = false;
  restoreProducerEvents();
  renderFinanceMembers();
  render();
  await advance();
});
async function replayOrdering(keyed) {
  if (state.scene < 6) {
    orderingReturn = clone(state);
    orderingCheckpoint = clone({ ...state, scene: 6, partitionCount: 2,
      readers: ["A", "B"], grouped: true, groupRevealed: true,
      assignments: { 0: "A", 1: "B" }, rebalancing: false });
    history[6] = clone({ ...orderingCheckpoint, records: [], events: [],
      offsets: { orders: [0, 0], message: [0, 0], "finance-disputes": [0, 0] },
      acknowledged: {}, starts: {}, processedByGroup: {}, appliedByGroup: {},
      outcome: "", step: "", checkpoint: false });
  }
  cancelFlow();
  const signal = flowController.signal;
  busy = true;
  render();
  try {
    Object.assign(state, clone(orderingCheckpoint), { scene: keyed ? 7 : 6, step: "", checkpoint: false });
    restoreProducerEvents();
    renderFinanceMembers();
    render();
    await new Promise(requestAnimationFrame);
    assertActive(signal);
    await (keyed ? showKeyed() : showUnkeyed());
    history[state.scene] = clone(state);
  } catch (error) {
    if (error.name !== "AbortError") console.error(error);
  } finally {
    if (!signal.aborted) { busy = false; render(); }
  }
}
$("#replay-unkeyed").addEventListener("click", () => replayOrdering(false));
$("#replay-keyed").addEventListener("click", () => replayOrdering(true));
$("#scenario-select").addEventListener("change", (event) => location.assign(event.target.value));
window.addEventListener("resize", () => requestAnimationFrame(drawRoutes));
render();
requestAnimationFrame(drawRoutes);
runIntro().catch((error) => { if (error.name !== "AbortError") console.error(error); });

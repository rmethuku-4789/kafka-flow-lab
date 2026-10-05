import { animate } from "motion";

const $ = (selector, root = document) => root.querySelector(selector);
const stage = $("#groups-stage");
const svgGroup = $("#groups-paths");
const speedInput = $("#speed-control");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const animations = new Set();
const routes = { data: new Map(), control: new Map() };
const scenes = [
  ["THE FINANCE BACKLOG", "Finance is falling behind while records keep arriving. What would you try?", "ASK THE ROOM"],
  ["A SECOND FINANCE READER", "What do you notice about the Finance readers?", "ASK THE ROOM"],
  ["A SECOND PARTITION", "New records now land on both partitions. What is still being repeated?", "ASK THE ROOM"],
  ["PARTITION ASSIGNMENT", "With two Finance members sharing one group, how might their partitions be assigned?", "ASK THE ROOM"],
  ["A THIRD FINANCE MEMBER", "There are two partitions and three Finance members. What might happen to the extra member?", "ASK THE ROOM"],
  ["TWO EVENTS · TWO PARTITIONS", "What do you notice about the event order?", "ASK THE ROOM"],
  ["ONE DISPUTE KEY", "Created and Resolved share a dispute key. Where might they land, and in what order?", "ASK THE ROOM"],
];
const nextLabels = ["What would you do? →", "Next →", "Next →", "Next →", "Next →", "Show keyed events →", "Complete"];
const state = {
  scene: 0,
  partitionCount: 1,
  records: [],
  offsets: { orders: [0, 0], message: [0, 0], "finance-disputes": [0, 0] },
  readers: ["A"],
  grouped: false,
  assignments: { 0: "A", 1: "B" },
  outcome: "",
  duplicateRecord: null,
  processedByGroup: {},
  appliedByGroup: {},
  starts: {},
};
const history = [];
let speed = Number(speedInput.value);
let busy = false;
let paused = false;
let producerRoute;
let resumeWaiters = [];
let liveTrafficPromise = null;
let stopLiveTraffic = false;
let orderingCheckpoint = null;
let flowController = new AbortController();
let laggedMembers = new Set();
let duplicateReady = false;
let memberTransitionSignal = null;

function assertActive(signal) {
  if (signal.aborted) throw new DOMException("Scene changed", "AbortError");
}

async function finishAnimation(animation, signal = flowController.signal) {
  assertActive(signal);
  animations.add(animation);
  animation.speed = speed;
  if (paused) animation.pause();
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
  }
}

function cancelFlow() {
  flowController.abort();
  flowController = new AbortController();
  stopLiveTraffic = true;
  liveTrafficPromise = null;
  resumeWaiters.splice(0).forEach((resume) => resume());
  stage.querySelectorAll(".packet:not(#packet-template)").forEach((packet) => packet.remove());
  document.querySelectorAll(".is-processing,.is-receiving,.event-card.is-active").forEach((card) => card.classList.remove("is-processing", "is-receiving", "is-active"));
  document.querySelectorAll(".member-progress i,.progress-fill").forEach((fill) => { fill.style.transform = "scaleX(0)"; });
  $("#coordinator").classList.remove("is-active");
  paused = false;
}

function recordIdentity(record) {
  return `P${record.partition}:${record.offset}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function restoreProducerEvents() {
  document.querySelectorAll(".event-card").forEach((card) => {
    const record = state.records.filter((entry) => entry.event === card.dataset.event).at(-1);
    $("small", card).textContent = record
      ? `${recordIdentity(record)} · ${record.dispute}${record.key ? ` · KEY ${record.key}` : ""}`
      : card.dataset.event;
    card.classList.remove("is-active");
  });
}

function groupId(member) {
  return state.grouped ? "finance-disputes" : member === "A" ? "finance-disputes" : `finance-copy-${member.toLowerCase()}`;
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
  const brokerLeft = edge(broker, bounds, "left");
  const producerMiddle = (producerEdge.x + brokerLeft.x) / 2;
  producerRoute = path(`M ${producerEdge.x} ${producerEdge.y} H ${producerMiddle} V ${brokerLeft.y} H ${brokerLeft.x}`, "producer");

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
}

function setActive(route) {
  route?.classList.add("is-active");
}

async function fly(route, label, { reverse = false } = {}) {
  const signal = flowController.signal;
  assertActive(signal);
  if (!route) return;
  const token = $("#packet-template").cloneNode(true);
  token.removeAttribute("id");
  token.hidden = false;
  token.style.display = "grid";
  $("small", token).textContent = label;
  stage.append(token);
  const rect = token.getBoundingClientRect();
  const length = route.getTotalLength();
  const points = reducedMotion ? [route.getPointAtLength(0), route.getPointAtLength(length)] :
    Array.from({ length: 34 }, (_, index) => route.getPointAtLength(length * index / 33));
  if (reverse) points.reverse();
  setActive(route);
  const animation = animate(token, {
    x: points.map(({ x }) => x - rect.width / 2),
    y: points.map(({ y }) => y - rect.height / 2),
  }, { duration: reducedMotion ? 0.1 : 0.95, ease: "linear" });
  await finishAnimation(animation, signal);
  token.remove();
  route.classList.remove("is-active");
}

async function wait(duration, interruptible = false) {
  const signal = flowController.signal;
  let remaining = reducedMotion ? 20 : duration;
  while (remaining > 0) {
    assertActive(signal);
    if (interruptible && stopLiveTraffic) return;
    if (paused) {
      await new Promise((resolve) => resumeWaiters.push(resolve));
      continue;
    }
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining / speed)));
    if (!paused) remaining -= (performance.now() - start) * speed;
  }
  assertActive(signal);
}

function groupLag(id, partition = null) {
  const next = (state.offsets[id] ?? [0, 0]).map((offset, partition) => offset ?? state.starts[id]?.[partition] ?? 0);
  return state.records.reduce((total, record) => total + Number((partition === null || record.partition === partition) && record.offset >= next[record.partition]), 0);
}

function updateOffsets() {
  const format = (group) => Array.from({ length: state.partitionCount }, (_, partition) =>
    `P${partition} · ${state.offsets[group]?.[partition] === null ? `UNCOMMITTED · START ${state.starts[group]?.[partition] ?? 0}` : `NEXT ${state.offsets[group]?.[partition] ?? 0}`}`).join("  ");
  $("#orders-offset").textContent = format("orders");
  $("#message-offset").textContent = format("message");
  $("#finance-offset").textContent = state.grouped
    ? format("finance-disputes")
    : state.readers.length > 1
      ? `A · ${format("finance-disputes")}\nB · ${format("finance-copy-b")}`
      : format("finance-disputes");
  $("#orders-next").textContent = format("orders");
  $("#message-next").textContent = format("message");
  $("#coordinator-state").textContent = state.grouped ? "FINANCE GROUP OFFSETS" : "INDEPENDENT GROUP OFFSETS";
  updateFinanceLagUI();
}

function updateFinanceLagUI() {
  for (const id of state.readers) {
    const card = $(`[data-member="${id}"]`);
    if (!card) continue;
    if (id === "C") continue;
    const group = state.grouped ? "finance-disputes" : groupId(id);
    const partitions = state.grouped
      ? Object.entries(state.assignments).filter(([, member]) => member === id).map(([partition]) => Number(partition))
      : [null];
    const lag = partitions.reduce((total, partition) => total + groupLag(group, partition), 0);
    $(".member-lag", card).textContent = `LAG ${lag}`;
    if (lag > 1) laggedMembers.add(id);
    const behind = !state.grouped && (lag > 1 || (lag > 0 && laggedMembers.has(id)));
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
      dot.className = `record-dot${record === records.at(-1) ? " is-latest" : ""}`;
      dot.textContent = String(record.offset);
      dot.title = `${record.event} · ${record.dispute} · P${partition} offset ${record.offset}${record.key ? ` · key ${record.key}` : " · no key"}`;
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
  wrapper.classList.toggle("finance-group-boundary", state.grouped);
  wrapper.dataset.groupLabel = "ONE FINANCE CONSUMER GROUP · SHARED GROUP ID";
  const visible = state.readers.slice();
  for (const id of visible) {
    const card = document.createElement("div");
    card.className = "finance-member";
    card.dataset.member = id;
    card.dataset.activity = id === "C" ? "idle" : "idle";
    const name = document.createElement("strong");
    name.textContent = `Finance ${id}`;
    const meta = document.createElement("small");
    const assigned = state.grouped ? Object.entries(state.assignments).filter(([, member]) => member === id).map(([partition]) => `P${partition}`).join(" + ") : "P0 + P1 · reads full topic";
    meta.textContent = state.grouped
      ? assigned || ""
      : id === "B" && state.readers.includes("B")
        ? `GROUP · ${groupId(id)} · RESET LATEST`
        : `GROUP · ${groupId(id)}`;
    const lag = document.createElement("span");
    lag.className = "member-lag";
    const memberState = document.createElement("span");
    memberState.className = "member-state";
    memberState.textContent = id === "C" ? "" : "WAITING";
    const offsetGroup = state.grouped ? "finance-disputes" : groupId(id);
    const memberPartitions = state.grouped
      ? Object.entries(state.assignments).filter(([, member]) => member === id).map(([partition]) => Number(partition))
      : [null];
    const memberLag = memberPartitions.reduce((total, partition) => total + groupLag(offsetGroup, partition), 0);
    lag.textContent = id === "C" ? "" : `LAG ${memberLag}`;
    const progress = document.createElement("div");
    progress.className = "member-progress";
    progress.setAttribute("aria-hidden", "true");
    const fill = document.createElement("i");
    progress.append(fill);
    card.append(name, meta, lag, memberState, progress);
    const recordLabel = document.createElement("small");
    recordLabel.className = "member-record";
    recordLabel.textContent = "—";
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
    if (id === "C") card.classList.add("is-idle");
    wrapper.append(card);
  }
  updateFinanceOutcome();
}

function updateFinanceOutcome() {
  const status = $("#finance-state");
  status.textContent = state.outcome ? (state.outcome === "failed" ? "FAILED" : "PROCESSED") : state.grouped ? "GROUP ACTIVE" : "READY";
  $("#finance-card").dataset.activity = state.outcome === "failed" ? "failed" : "idle";
  const outcome = $("#finance-outcome");
  const duplicate = !state.grouped && state.duplicateRecord;
  outcome.hidden = !state.outcome;
  outcome.dataset.outcome = state.outcome;
  outcome.textContent = state.outcome === "failed" ? "FAILED" : state.outcome === "success" ? "SUCCESS" : "";
  document.querySelectorAll(".finance-member").forEach((card) => {
    card.classList.toggle("is-shared-processing", Boolean(duplicate) && card.dataset.member !== "C");
  });
}

function showDuplicateRecord(record) {
  if (state.scene === 1 && !duplicateReady) return;
  state.duplicateRecord = record;
  if (state.grouped) return;
  for (const id of state.readers) {
    const card = $(`[data-member="${id}"]`);
    if (!card || id === "C") continue;
    card.classList.add("is-shared-processing");
    $(".member-history", card).textContent = `PROCESSED · ${recordIdentity(record)} · ${record.event === "DisputeCreated" ? "CREATED" : "RESOLVED"}`;
  }
}

function render() {
  const scene = scenes[state.scene];
  $("#scene-heading").textContent = scene[0];
  $("#scene-counter").textContent = `${state.scene + 1} / ${scenes.length}`;
  $("#scene-number").textContent = "03";
  $("#prompt-label").textContent = scene[2];
  $("#scene-prompt").textContent = scene[1];
  $("#consumer-column-note").textContent = state.grouped
    ? "EXAMPLE PARTITION ASSIGNMENT"
    : `${state.readers.length + 2} INDEPENDENT GROUPS`;
  $("#group-partition-count")?.remove();
  $("#producer-state").textContent = state.records.length ? "APPENDED" : "READY";
  $("#producer-note").textContent = state.scene === 5
    ? "One possible unkeyed placement"
    : state.scene === 6
      ? "Two sends · same key"
      : state.scene === 2 ? "Higher input rate · both partitions" : "Does not wait for consumers";
  $("#finance-card").dataset.activity = "idle";
  updateFinanceOutcome();
  updateRecordWindow();
  updateOffsets();
  $("#message-state").textContent = state.scene >= 1 ? "IDLE" : "WAITING";
  $("#orders-state").textContent = state.scene >= 1 ? "IDLE" : "WAITING";
  $("#orders-card").classList.toggle("is-deemphasized", state.scene >= 1);
  $("#message-card").classList.toggle("is-deemphasized", state.scene >= 1);
  $("#group-rate")?.remove();
  $("#flow-state span").textContent = busy || liveTrafficPromise ? paused ? "PAUSED" : "PLAYING" : "LIVE";
  $("#flow-state").classList.toggle("is-paused", paused);
  $("#flow-state").classList.toggle("is-playing", (busy || liveTrafficPromise) && !paused);
  $("#previous-button").disabled = state.scene === 0;
  $("#next-button").disabled = state.scene === scenes.length - 1;
  $("#next-button").textContent = nextLabels[state.scene];
  $("#pause-button").disabled = !busy && !liveTrafficPromise;
  $("#reset-button").disabled = false;
  $("#replay-unkeyed").disabled = !orderingCheckpoint;
  $("#replay-keyed").disabled = !orderingCheckpoint;
  $("#pause-button").textContent = paused ? "▶ Resume" : "Ⅱ Pause";
  $("#pause-button").setAttribute("aria-pressed", String(paused));
  requestAnimationFrame(drawRoutes);
}

function appendRecord(event, partition, dispute, key = null) {
  const offset = state.records.filter((record) => record.partition === partition).length;
  const record = { event, partition, dispute, key, offset };
  state.records.push(record);
  updateRecordWindow();
  updateFinanceLagUI();
  return record;
}

async function publish(event, partition, dispute, key = null) {
  const signal = flowController.signal;
  $("#producer-state").textContent = "PUBLISHING";
  const producerEvent = $(`[data-event="${event}"]`);
  const detail = $("small", producerEvent);
  document.querySelectorAll(".event-card.is-active").forEach((card) => card.classList.remove("is-active"));
  producerEvent?.classList.add("is-active");
  if (detail) detail.textContent = `SENDING · ${dispute}${key ? ` · KEY ${key}` : " · NO KEY"}`;
  await new Promise(requestAnimationFrame);
  assertActive(signal);
  await fly(producerRoute, event === "DisputeCreated" ? "SEND · CREATED" : "SEND · RESOLVED");
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
  activeCard.classList.add("is-processing");
  if (target.startsWith("finance-")) {
    card.dataset.activity = "processing";
    $(".member-state", card).textContent = "PROCESSING";
  }
  const stall = target === "finance-A" && state.scene === 0 && laggedMembers.has("A");
  const animation = animate(fill, { scaleX: [0, stall ? 0.35 : 1] }, { duration: reducedMotion ? 0.1 : duration / 1000, ease: "linear" });
  updateFinanceLagUI();
  await finishAnimation(animation);
  if (stall) {
    $(".member-state", card).textContent = "LAGGING";
    while (true) await wait(100);
  }
  fill.style.transform = "scaleX(0)";
  activeCard.classList.remove("is-processing");
  if (target.startsWith("finance-")) updateFinanceLagUI();
}

async function readRecord(record, target, group, { processTime = 420, commit = true, poll = true, existing = false, onProcessing, batchRecords = null } = {}) {
  const signal = flowController.signal;
  if (state.scene === 0 && target === "finance-A" && record.offset >= 3) laggedMembers.add("A");
  const dataRoute = routes.data.get(target);
  const card = targetElement(target);
  const status = target.startsWith("finance-") ? $(".member-state", card) : $(`#${target}-state`);
  if (status) status.textContent = "POLLING";
  if (poll) await fly(dataRoute, `POLL P${record.partition}`, { reverse: true });
  const eventLabel = record.event === "DisputeCreated" ? "CREATED" : "RESOLVED";
  const identity = batchRecords ? `P${record.partition}:${batchRecords[0].offset}–${record.offset}` : recordIdentity(record);
  await fly(dataRoute, `${existing ? "EXISTING · " : ""}${batchRecords ? "BATCH" : "RECORD"} · ${eventLabel} · ${identity}`);
  card.classList.add("is-receiving");
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
    card.dataset.activity = "error";
    if (status) status.textContent = "FAILED";
    return;
  }
  state.offsets[group][record.partition] = Math.max(state.offsets[group][record.partition], record.offset + 1);
  updateOffsets();
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
    const otherGroups = state.readers.filter((reader) => reader !== member).map((reader) => state.grouped ? "finance-disputes" : groupId(reader));
    if (!state.grouped && otherGroups.some((otherGroup) => otherGroup !== groupIdForMember && (state.processedByGroup[otherGroup] ?? []).includes(identity))) {
      showDuplicateRecord(record);
    }
  }
  updateFinanceLagUI();
}

async function readFastGroups(record) {
  await Promise.all([
    readRecord(record, "orders", "orders", { processTime: 360 }),
    readRecord(record, "message", "message", { processTime: 420 }),
  ]);
}

async function runIntro() {
  const signal = flowController.signal;
  busy = true;
  render();
  state.partitionCount = 1;
  state.records = [];
  state.offsets = { orders: [0, 0], message: [0, 0], "finance-disputes": [0, 0] };
  state.processedByGroup = {};
  state.appliedByGroup = {};
  state.readers = ["A"];
  state.grouped = false;
  state.outcome = "";
  renderFinanceMembers();
  render();
  for (let index = 0; index < 3; index += 1) {
    assertActive(signal);
    const record = await publish("DisputeCreated", 0, ["49328", "49329", "49330", "49331"][index]);
    const fast = readFastGroups(record);
    await Promise.all([fast, readRecord(record, "finance-A", "finance-disputes", { processTime: 520 })]);
    if (index === 2) await wait(180);
  }
  assertActive(signal);
  laggedMembers.add("A");
  state.scene = 0;
  busy = false;
  history.splice(0, history.length, clone(state));
  render();
  startLaggingTraffic();
}

async function runLaggingTraffic() {
  let sequence = 0;
  while (!stopLiveTraffic) {
    const record = await publish("DisputeCreated", 0, `live-${sequence + 1}`);
    sequence += 1;
    await readFastGroups(record);
    await wait(1200, true);
  }
}

function startLaggingTraffic() {
  if (liveTrafficPromise) return;
  stopLiveTraffic = false;
  const signal = flowController.signal;
  liveTrafficPromise = Promise.all([
    runLaggingTraffic(),
    consumeGroup("finance-disputes", "finance-A", [0], 4000),
  ]).catch((error) => { if (error.name !== "AbortError") console.error(error); }).finally(() => {
    if (signal.aborted) return;
    liveTrafficPromise = null;
    if (!busy) render();
  });
  render();
}

async function stopLaggingTraffic() {
  cancelFlow();
}

function startLiveFlow(tasks) {
  const signal = flowController.signal;
  stopLiveTraffic = false;
  liveTrafficPromise = Promise.all(tasks).catch((error) => { if (error.name !== "AbortError") console.error(error); }).finally(() => {
    if (signal.aborted) return;
    liveTrafficPromise = null;
    if (!busy) render();
  });
  render();
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

async function produceContinuously(partitionCount, prefix, delay) {
  const signal = flowController.signal;
  let sequence = 0;
  while (!stopLiveTraffic) {
    assertActive(signal);
    const partition = sequence % partitionCount;
    const record = await publish("DisputeCreated", partition, `${prefix}-${sequence + 1}`);
    sequence += 1;
    await wait(delay, true);
    if (stopLiveTraffic) return record;
  }
}

async function consumeGroup(group, target, partitions, processTime, { preferredPartitions = [], existingBefore, onProcessing } = {}) {
  const signal = flowController.signal;
  let partitionOrder = [...preferredPartitions, ...partitions.filter((partition) => !preferredPartitions.includes(partition))];
  while (!stopLiveTraffic) {
    assertActive(signal);
    const record = nextGroupRecord(group, partitionOrder);
    if (!record) {
      await wait(50, true);
      continue;
    }
    const pending = state.grouped ? state.records.filter((entry) => entry.partition === record.partition && entry.offset >= record.offset &&
      (!existingBefore || record.offset >= existingBefore[record.partition] || entry.offset < existingBefore[record.partition])).slice(0, 4) : [];
    const batch = pending.length > 1 ? pending : null;
    const delivered = batch ? batch.at(-1) : record;
    await readRecord(delivered, target, group, {
      processTime: (typeof processTime === "function" ? processTime(record) : processTime) * (batch?.length ?? 1),
      batchRecords: batch,
      existing: existingBefore && record.offset < existingBefore[record.partition],
      onProcessing: (current) => onProcessing?.(current),
    });
    partitionOrder = [...partitionOrder.filter((partition) => partition !== record.partition), record.partition];
  }
}

function startIndependentFinanceFlow({ partitionCount, prefix, delay, priorities = {}, processTimes = {}, onProcessing } = {}) {
  stopLiveTraffic = false;
  const partitions = Array.from({ length: partitionCount }, (_, index) => index);
  const signal = flowController.signal;
  const firstPublication = publish("DisputeCreated", 0, `${prefix}-opening`);
  startLiveFlow([
    firstPublication.then(() => { assertActive(signal); return produceContinuously(partitionCount, prefix, delay); }),
    firstPublication.then(() => { assertActive(signal); return consumeGroup("finance-disputes", "finance-A", partitions, processTimes.A ?? 620, {
      preferredPartitions: priorities.A ?? [],
      onProcessing: (record) => onProcessing?.("A", record),
    }); }),
    firstPublication.then(() => { assertActive(signal); return consumeGroup("finance-copy-b", "finance-B", partitions, processTimes.B ?? 620, {
      preferredPartitions: priorities.B ?? [],
      onProcessing: (record) => onProcessing?.("B", record),
    }); }),
  ]);
}

function startGroupedFinanceFlow({ partitionCount, prefix, delay, readers = ["A", "B"], existingBefore, onProcessing } = {}) {
  stopLiveTraffic = false;
  const signal = flowController.signal;
  const firstPublication = publish("DisputeCreated", 0, `${prefix}-opening`);
  const tasks = [firstPublication.then(async () => {
    assertActive(signal);
    if (state.scene === 4) await wait(delay);
    assertActive(signal);
    return produceContinuously(partitionCount, prefix, delay);
  })];
  for (const member of readers) {
    const partition = Number(Object.entries(state.assignments).find(([, assigned]) => assigned === member)?.[0]);
    if (!Number.isInteger(partition) || partition >= partitionCount) continue;
    tasks.push(firstPublication.then(() => { assertActive(signal); return consumeGroup("finance-disputes", `finance-${member}`, [partition], 620, {
      existingBefore,
      onProcessing: (record) => onProcessing?.(member, record),
    }); }));
  }
  startLiveFlow(tasks);
}

async function addReader() {
  const signal = flowController.signal;
  duplicateReady = false;
  if (groupLag("finance-disputes")) laggedMembers.add("A");
  state.readers.push("B");
  state.offsets["finance-copy-b"] = [null, null];
  state.starts["finance-copy-b"] = [state.records.filter((record) => record.partition === 0).length, 0];
  state.processedByGroup["finance-copy-b"] = [];
  renderFinanceMembers();
  render();
  await new Promise(requestAnimationFrame);
  assertActive(signal);
  for (let index = 0; index < 2; index += 1) {
    const record = await publish("DisputeCreated", 0, `finance-b-start-${index + 1}`);
    await readRecord(record, "finance-B", "finance-copy-b", { processTime: 420 });
  }
  let recoveryDone = false;
  const recoverA = async () => {
    while (groupLag("finance-disputes")) {
      assertActive(signal);
      const pending = state.records.filter((record) => record.partition === 0 && record.offset >= (state.offsets["finance-disputes"][0] ?? 0));
      const batch = pending.length > 1 ? pending : null;
      const record = batch ? batch.at(-1) : pending[0];
      await readRecord(record, "finance-A", "finance-disputes", { processTime: batch ? 5500 : 1600, existing: true, batchRecords: batch });
    }
    recoveryDone = true;
  };
  await Promise.all([
    recoverA(),
    (async () => {
      while (!recoveryDone) {
        assertActive(signal);
        const record = await publish("DisputeCreated", 0, `finance-b-recovery-${state.records.length}`);
        await readRecord(record, "finance-B", "finance-copy-b", { processTime: 420 });
        if (!recoveryDone) await wait(3500);
      }
    })(),
  ]);
  const remaining = nextGroupRecord("finance-disputes", [0]);
  if (remaining) await readRecord(remaining, "finance-A", "finance-disputes", { processTime: 900, existing: true });
  laggedMembers.delete("A");
  duplicateReady = true;
  while (true) {
    assertActive(signal);
    const record = await publish("DisputeCreated", 0, `finance-pair-${state.records.length}`);
    await Promise.all([
      readRecord(record, "finance-A", "finance-disputes", { processTime: 620 }),
      readRecord(record, "finance-B", "finance-copy-b", { processTime: 620 }),
    ]);
    await wait(800);
  }
}

async function addPartition() {
  const signal = flowController.signal;
  state.partitionCount = 2;
  state.offsets["finance-disputes"][1] = null;
  state.offsets["finance-copy-b"][1] = null;
  state.starts["finance-disputes"] = [0, 0];
  state.starts["finance-copy-b"][1] = 0;
  state.duplicateRecord = null;
  renderFinanceMembers();
  render();
  const row = $('[data-partition="1"]');
  const reveal = animate(row, { opacity: [0, 1], y: [10, 0] }, { duration: reducedMotion ? 0.1 : 0.55, ease: "easeOut" });
  await finishAnimation(reveal);
  await new Promise(requestAnimationFrame);
  assertActive(signal);
  laggedMembers.add("A");
  laggedMembers.add("B");
  startIndependentFinanceFlow({
    partitionCount: 2,
    prefix: "finance-p1-live",
    delay: 500,
  });
}

async function formGroup() {
  const signal = flowController.signal;
  const existingBefore = [0, 1].map((partition) => state.records.filter((record) => record.partition === partition).length);
  state.grouped = true;
  state.readers = ["A", "B"];
  state.duplicateRecord = null;
  renderFinanceMembers();
  render();
  const boundary = $("#finance-members");
  await finishAnimation(animate(boundary, { opacity: [0.45, 1] }, { duration: reducedMotion ? 0.1 : 0.5 }));
  $("#coordinator-state").textContent = "REBALANCING MEMBERS";
  await wait(700);
  $("#coordinator-state").textContent = "PARTITIONS ASSIGNED";
  await new Promise(requestAnimationFrame);
  assertActive(signal);
  startGroupedFinanceFlow({
    partitionCount: 2,
    prefix: "finance-group-live",
    delay: 500,
    existingBefore,
  });
}

async function addIdleMember() {
  const signal = flowController.signal;
  const existingBefore = [0, 1].map((partition) => state.records.filter((record) => record.partition === partition).length);
  state.readers.push("C");
  renderFinanceMembers();
  render();
  startGroupedFinanceFlow({ partitionCount: 2, prefix: "finance-c-live", delay: 3500, readers: ["A", "B", "C"], existingBefore });
  const card = $('[data-member="C"]');
  const reveal = animate(card, { opacity: [0, 0.62], y: [8, 0] }, { duration: reducedMotion ? 0.1 : 0.5, ease: "easeOut" });
  await finishAnimation(reveal);
  assertActive(signal);
}

async function showUnkeyed() {
  state.outcome = "";
  orderingCheckpoint = clone(state);
  const created = await publish("DisputeCreated", 0, "49340");
  const resolved = await publish("DisputeResolved", 1, "49340");
  await readRecord(resolved, "finance-B", "finance-disputes", { processTime: 700, commit: false, poll: true });
  state.outcome = "failed";
  $("#finance-outcome").hidden = false;
  $("#finance-outcome").dataset.outcome = "failed";
  $("#finance-outcome").textContent = "FAILED";
  await readRecord(created, "finance-A", "finance-disputes", { processTime: 500 });
  state.scene = 5;
}

async function showKeyed() {
  const signal = flowController.signal;
  state.outcome = "";
  renderFinanceMembers();
  render();
  await new Promise(requestAnimationFrame);
  assertActive(signal);
  const created = await publish("DisputeCreated", 0, "49341", "dispute-49341");
  const resolved = await publish("DisputeResolved", 0, "49341", "dispute-49341");
  await readRecord(created, "finance-A", "finance-disputes", { processTime: 650 });
  await readRecord(resolved, "finance-A", "finance-disputes", { processTime: 650 });
  state.outcome = "success";
  updateFinanceOutcome();
  state.scene = 6;
}

async function drainAssignedRecords() {
  const existingBefore = [0, 1].map((partition) => state.records.filter((record) => record.partition === partition).length);
  for (;;) {
    const pending = [0, 1].map((partition) => nextGroupRecord("finance-disputes", [partition])).filter(Boolean);
    if (!pending.length) return;
    const ready = pending.filter((record) => record.event === "DisputeCreated" || (state.appliedByGroup["finance-disputes"] ?? []).includes(record.dispute));
    if (!ready.length) throw new Error("Pending Resolved has no applied Created event; cannot advance its offset");
    await Promise.all(ready.map((record) => readRecord(
      record,
      `finance-${state.assignments[record.partition]}`,
      "finance-disputes",
      { processTime: 360, existing: record.offset < existingBefore[record.partition] },
    )));
  }
}

async function advance() {
  if (memberTransitionSignal && !memberTransitionSignal.aborted) return;
  if (state.scene >= scenes.length - 1) return;
  const currentScene = state.scene;
  const transitions = [addReader, addPartition, formGroup, addIdleMember, showUnkeyed, showKeyed];
  const transition = transitions[currentScene];
  history[currentScene] = clone(state);
  cancelFlow();
  const signal = flowController.signal;
  if (currentScene === 3) memberTransitionSignal = signal;
  busy = true;
  try {
    if (currentScene >= 4) {
      render();
      await drainAssignedRecords();
      assertActive(signal);
    }
    state.scene = currentScene + 1;
    render();
    history[state.scene] = clone(state);
    await transition();
    assertActive(signal);
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
  const restored = history[state.scene - 1];
  Object.assign(state, clone(restored));
  history.splice(state.scene + 1);
  restoreProducerEvents();
  laggedMembers = new Set(state.scene === 0 ? ["A"] : []);
  renderFinanceMembers();
  busy = false;
  render();
  startSceneTraffic();
}

function startSceneTraffic() {
  if (state.scene === 0) return startLaggingTraffic();
  if (state.scene === 1 || state.scene === 2) {
    return startIndependentFinanceFlow({
      partitionCount: state.partitionCount,
      prefix: `finance-resume-${state.scene}`,
      delay: state.scene === 1 ? 3500 : 500,
    });
  }
  if (state.scene === 3 || state.scene === 4) {
    const existingBefore = [0, 1].map((partition) => state.records.filter((record) => record.partition === partition).length);
    return startGroupedFinanceFlow({
      partitionCount: state.partitionCount,
      prefix: `finance-group-resume-${state.scene}`,
      delay: state.scene === 4 ? 3500 : 500,
      readers: state.scene === 4 ? ["A", "B", "C"] : ["A", "B"],
      existingBefore,
    });
  }
}

async function reset() {
  cancelFlow();
  paused = false;
  animations.forEach((animation) => animation.play());
  resumeWaiters.splice(0).forEach((resume) => resume());
  Object.assign(state, {
    scene: 0,
    partitionCount: 1,
    records: [],
    offsets: { orders: [0, 0], message: [0, 0], "finance-disputes": [0, 0] },
    readers: ["A"],
    grouped: false,
    assignments: { 0: "A", 1: "B" },
    outcome: "",
    duplicateRecord: null,
    processedByGroup: {},
    appliedByGroup: {},
    starts: {},
  });
  orderingCheckpoint = null;
  laggedMembers.clear();
  duplicateReady = false;
  restoreProducerEvents();
  history.length = 0;
  busy = false;
  try { await runIntro(); } catch (error) { if (error.name !== "AbortError") console.error(error); }
}

function togglePause() {
  paused = !paused;
  animations.forEach((animation) => paused ? animation.pause() : animation.play());
  $("#pause-button").textContent = paused ? "▶ Resume" : "Ⅱ Pause";
  $("#pause-button").setAttribute("aria-pressed", String(paused));
  $("#flow-state span").textContent = paused ? "PAUSED" : busy || liveTrafficPromise ? "PLAYING" : "LIVE";
  $("#flow-state").classList.toggle("is-paused", paused);
  $("#flow-state").classList.toggle("is-playing", (busy || liveTrafficPromise) && !paused);
  if (!paused) resumeWaiters.splice(0).forEach((resume) => resume());
}

$("#next-button").addEventListener("click", advance);
$("#previous-button").addEventListener("click", previous);
$("#reset-button").addEventListener("click", reset);
$("#pause-button").addEventListener("click", togglePause);
async function replayOrdering(keyed) {
  if (!orderingCheckpoint) return;
  cancelFlow();
  const signal = flowController.signal;
  busy = true;
  render();
  try {
    Object.assign(state, clone(orderingCheckpoint), { scene: keyed ? 6 : 5 });
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
speedInput.addEventListener("input", () => {
  speed = Number(speedInput.value);
  $("#speed-output").textContent = `${speed.toFixed(2).replace(/0$/, "")}×`;
  animations.forEach((animation) => { animation.speed = speed; });
});
window.addEventListener("resize", () => requestAnimationFrame(drawRoutes));
render();
requestAnimationFrame(drawRoutes);
runIntro().catch((error) => { if (error.name !== "AbortError") console.error(error); });

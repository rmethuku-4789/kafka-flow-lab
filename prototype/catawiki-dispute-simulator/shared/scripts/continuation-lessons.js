import { animate } from "motion";
import { createModel, appendRecord, commitRecord, applyEffect, appendDeadLetter, schemaV1, incompatibleSchema, compatibleSchema, registerSchema, beginAvroTopic, jsonSchemaV1, incompatibleJsonSchema } from "./continuation-model.js";

const $ = (selector, root = document) => root.querySelector(selector);
const lesson = document.body.dataset.lesson;
const stage = $("#groups-stage");
const animations = new Set();
const routes = new Map();
const checkpoints = [];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const definitions = {
  retries: [
    ["THE DATABASE OPERATION", "What would you do when all three attempts fail?"],
    ["A DIFFERENT FAILURE PATH · NEW RUN", "Where does the failed record go this time?"],
  ],
  offsets: [
    ["COMMIT BEFORE PROCESSING", "What do you notice after the restart?"],
    ["PROCESS BEFORE COMMIT", "What changed in the ledger after the restart?"],
    ["THE BUSINESS EVENT ID", "What do you notice about the business effect count?"],
  ],
  schemas: [
    ["THE CURRENT CONTRACT", "What if we need to change this schema?"],
    ["WITHOUT SCHEMA REGISTRY", "What could we do before sending this?"],
    ["WITH SCHEMA REGISTRY · NEW RUN", "What happens if we try that rename now?"],
    ["THE RENAMED FIELD · NEW RUN", "Where does the changed event stop?"],
  ],
};
let model = createModel();
let scene = 0;
let controller = new AbortController();
let paused = false;
let running = false;
let speed = Number($("#speed-control").value);
let lastAdvance = -Infinity;
let databaseRecord = null;
let packetLayoutFrame = null;

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
  document.querySelectorAll(".member-progress i,.progress-fill,.database-progress i").forEach((fill) => { fill.style.width = "0%"; fill.style.transform = "none"; });
  document.querySelectorAll(".finance-member").forEach((card) => { card.style.opacity = "1"; card.dataset.activity = "idle"; $(".member-state", card).textContent = "WAITING"; });
  document.querySelectorAll(".is-updated").forEach((card) => card.classList.remove("is-updated"));
  if (lesson === "offsets") $("#connect-button").hidden = true;
  paused = false;
}

async function wait(milliseconds, signal) {
  active(signal);
  let remaining = reducedMotion ? Math.min(milliseconds, 120) : milliseconds;
  let previous = performance.now();
  while (remaining > 0) {
    await new Promise(requestAnimationFrame);
    active(signal);
    const now = performance.now();
    if (!paused) remaining -= Math.min(now - previous, 100) * speed;
    previous = now;
  }
}

async function motion(element, keyframes, duration, signal, options = {}) {
  active(signal);
  const animation = animate(element, keyframes, { duration: reducedMotion ? 0.12 : duration / 1000, ease: "linear", ...options });
  animations.add(animation);
  animation.speed = speed;
  if (paused) animation.pause();
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
    const rect = label.getBoundingClientRect();
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
  const targets = [["orders", $("#orders-card")], ["A", member(0)], ["B", member(1)], ["message", $("#message-card")]];
  const positions = targets.map(([name, element]) => ({ name, ...point(element, "left") }));
  const spine = (brokerRight + positions[0].x) / 2;
  path("broker-entry", `M ${brokerRight} ${topic.y} H ${spine}`);
  path("coordinator-entry", `M ${brokerRight} ${coordinator.y} H ${spine}`).classList.add("coordinator-route");
  path("spine", `M ${spine} ${Math.min(topic.y, coordinator.y, ...positions.map((entry) => entry.y))} V ${Math.max(topic.y, coordinator.y, ...positions.map((entry) => entry.y))}`);
  for (const target of positions) {
    const muted = (scene > 0 || lesson === "retries" || lesson === "offsets" || lesson === "schemas") && ["orders", "message"].includes(target.name);
    path(`branch-${target.name}`, `M ${spine} ${target.y} H ${target.x}`, false, muted);
    path(target.name, `M ${brokerRight} ${topic.y} H ${spine} V ${target.y} H ${target.x}`, true);
    if (lesson === "offsets" || lesson === "retries") path(`commit-${target.name}`, `M ${brokerRight} ${coordinator.y} H ${spine} V ${target.y} H ${target.x}`, true);
  }
  if (!$("#lesson-database").hidden) {
    const source = point($("#finance-card"), "bottom");
    const destination = point($("#lesson-database"), "top");
    const lane = (source.y + destination.y) / 2;
    path("database", `M ${source.x} ${source.y} V ${lane} H ${destination.x} V ${destination.y}`);
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
      path("registry-read", `M ${registryRight.x} ${registryRight.y} H ${spine} V ${positions[1].y}`);
      for (const partition of [0, 1]) {
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

async function fly(name, label, signal, reverse = false) {
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
  packet.classList.toggle("packet--vertical", name === "database" || (name === "registry" && lesson !== "schemas"));
  $("small", packet).textContent = label;
  stage.append(packet);
  if (packetLayoutFrame === null) packetLayoutFrame = requestAnimationFrame(arrangePacketLabels);
  positionPacket(packet, 0);
  route.classList.add("is-active");
  try { await motion(0, 1, name === "database" ? 650 : 950, signal, { onUpdate: (progress) => { if (!signal.aborted) positionPacket(packet, progress); } }); }
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
      entry.classList.toggle("is-finance-committed", record.offset < model.next[partition]);
      entry.classList.toggle("is-unapplied", model.businessError === record.eventId || (model.attempts > 0 && model.failed?.eventId === record.eventId));
      entry.title = `${identity(record)} · ${record.eventId} · ${record.event}`;
      const dot = document.createElement("span");
      dot.className = "record-dot";
      dot.textContent = record.offset;
      const label = document.createElement("small");
      label.textContent = record.event === "DisputeCreated" ? "CREATED" : "RESOLVED";
      entry.append(dot, label);
      window.append(entry);
    }
    $(".record-count", row).textContent = model.logs[partition].length;
    $(".member-lag", member(partition)).textContent = `LAG ${model.logs[partition].length - model.next[partition]}`;
    $(".member-history", member(partition)).textContent = `POSITION ${model.position[partition]} · NEXT ${model.next[partition]}`;
    if (lesson === "schemas") $(":scope > small", member(partition)).textContent = model.avroTopic ? `P${partition} · READER V1` : `P${partition}`;
  }
  const offsets = (values) => values.map((offset, partition) => `P${partition} · NEXT ${offset}`).join("\n");
  $("#finance-offset").textContent = offsets(model.next);
  for (const service of ["orders", "message"]) {
    $(`#${service}-offset`).textContent = offsets(model.serviceNext[service]);
    $(`#${service}-next`).textContent = offsets(model.serviceNext[service]);
  }
  $("#broker-state").textContent = model.logs.some((records) => records.length) ? "RETAINED LOG" : "LOG EMPTY";
  $("#coordinator-state").textContent = "FINANCE GROUP OFFSETS";
  $("#database-details").textContent = databaseRecord
    ? `${databaseRecord.eventId} · EFFECTS ${model.effects[databaseRecord.eventId] ?? 0}`
    : "EVENT · — · EFFECTS · —";
  $("#dlq-records").replaceChildren();
  const deadLetters = lesson === "retries" ? model.dlq.slice(-3).reverse() : model.dlq.slice(-2);
  for (const [index, record] of deadLetters.entries()) {
    const entry = document.createElement("div");
    entry.textContent = `DLQ P0:${record.offset} · ${record.eventId}\nSOURCE P${record.sourcePartition}:${record.sourceOffset} · ${record.error}`;
    if (lesson === "retries") {
      entry.className = "queued-record";
      entry.style.gridColumn = String(3 - index);
      entry.title = entry.textContent;
      entry.textContent = `P0:${record.offset}\n${record.eventId}\nSOURCE P${record.sourcePartition}:${record.sourceOffset}`;
    }
    $("#dlq-records").append(entry);
  }
  if (lesson === "schemas") {
    $("#topic-boundary .topic-heading strong").textContent = model.avroTopic ? "…_customer_info_disputes_avro" : "…_customer_info_disputes";
    $("#dlq-topic").hidden = !model.archives.length;
    $("#dlq-topic").classList.add("lesson-archive");
    $("#dlq-topic .topic-heading strong").textContent = "…_customer_info_disputes · JSON";
    $("#dlq-records").textContent = model.archives.map((archive) => archive.logs.map((records, partition) => `P${partition} · ${records.length} RETAINED · NEXT ${archive.next[partition]}`).join("\n")).join("\n");
  }
}

function render() {
  const definition = definitions[lesson][scene];
  $("#scene-heading").textContent = definition[0];
  $("#scene-prompt").textContent = definition[1];
  $("#scene-counter").textContent = `${scene + 1} / ${definitions[lesson].length}`;
  $("#previous-button").disabled = scene === 0;
  $("#next-button").disabled = scene === definitions[lesson].length - 1;
  $("#next-button").textContent = scene === 0 ? "What would you do? →" : scene === definitions[lesson].length - 1 ? "Complete" : "Next →";
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
    $("#retry-count").textContent = "ATTEMPTS 0 / 3 · RETRIES 0";
    $('[data-replay="1"]').hidden = scene === 0;
  }
  if (lesson === "schemas") {
    $("#lesson-registry").hidden = scene < 2;
    $("#registry-state").textContent = "READY";
    $("#lesson-registry").dataset.activity = "idle";
    $("#registry-details").textContent = "…_customer_info_disputes-value\nJSON SCHEMA · FULL";
    $("#producer-note").textContent = scene < 2 ? "JSON · LOCAL CONTRACT" : "JSON SCHEMA · AUTO REGISTER";
    showJsonProposal(scene === 1 || scene === 3 ? incompatibleJsonSchema : jsonSchemaV1);
    $("#consumer-contract").textContent = "READER V1 · REQUIRED: dispute_id, order_id, reason";
    if (model.businessError && !model.avroTopic) {
      member(0).dataset.activity = "error";
      $(".member-state", member(0)).textContent = "FAILED";
    }
  }
  playback();
  update();
  drawRoutes();
}

function playback() {
  $("#pause-button").textContent = paused ? "▶ Resume" : "Ⅱ Pause";
  $("#pause-button").setAttribute("aria-pressed", String(paused));
  $("#flow-state span").textContent = paused ? "PAUSED" : running ? "PLAYING" : lesson === "retries" ? "STOPPED" : "LIVE";
  $("#flow-state").classList.toggle("is-paused", paused);
  $("#flow-state").classList.toggle("is-playing", running && !paused);
}

async function publish(partition, signal, fields = {}) {
  active(signal);
  const event = fields.event ?? "DisputeCreated";
  const card = $(`[data-event="${event}"]`);
  card.classList.add("is-active");
  $("small", card).textContent = fields.schemaId ? `SCHEMA ID ${fields.schemaId} · ${fields.format === "JSON_SCHEMA" ? "JSON" : "AVRO"}` : "SENDING · NO KEY";
  $("#producer-state").textContent = "PUBLISHING";
  $("#groups-producer").dataset.activity = "idle";
  await fly("producer", lesson === "schemas" ? `SEND · ${Object.hasOwn(fields.payload, "dispute_id") ? "dispute_id" : "order_dispute_id"}` : lesson === "retries" ? `SEND · P${partition}:${model.logs[partition].length}` : event === "DisputeCreated" ? "SEND · CREATED" : "SEND · RESOLVED", signal);
  active(signal);
  const record = appendRecord(model, partition, fields);
  $("small", card).textContent = `${identity(record)} · ${record.eventId}`;
  if (lesson === "schemas" && !record.schemaId) $("small", card).textContent = `${identity(record)} · ${Object.keys(record.payload)[0]}`;
  $("#producer-state").textContent = "APPENDED";
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
  commit(record);
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
  await fly("database", idempotent ? "TX · EVENT ID + EFFECT" : "DB WRITE", signal);
  await motion($(".database-progress i"), { width: ["0%", "100%"] }, 900, signal);
  active(signal);
  $(".database-progress i").style.width = "0%";
  if (fail) {
    $("#database-state").textContent = "TIMEOUT";
    $("#lesson-database").dataset.activity = lesson === "retries" && model.attempts < 2 ? "retrying" : "error";
    return false;
  }
  const applied = applyEffect(model, record, idempotent);
  $("#database-state").textContent = applied ? "SAVED" : "EVENT ID EXISTS";
  member(record.partition).dataset.activity = "idle";
  $(".member-state", member(record.partition)).textContent = "WAITING";
  update();
  return applied;
}

async function failedOperation(record, signal) {
  await process(record, signal, { duration: 1100, activity: model.attempts > 0 ? "retrying" : "processing" });
  await databaseOperation(record, signal, true);
  active(signal);
  model.attempts += 1;
  const exhausted = model.attempts === 3;
  member(0).dataset.activity = exhausted ? "error" : "retrying";
  $(".member-state", member(0)).textContent = exhausted ? "FAILED" : "RETRYING";
  $(".member-record", member(0)).textContent = `${identity(record)} · ${record.eventId}`;
  $("#retry-count").textContent = `ATTEMPTS ${model.attempts} / 3 · RETRIES ${model.attempts - 1}`;
  $("#database-state").textContent = `${exhausted ? "✕" : "⚠"} WRITE ${model.attempts} FAILED`;
  $("#lesson-database").dataset.activity = exhausted ? "error" : "retrying";
  $(".database-progress i").style.width = "100%";
  update();
  await wait(1500, signal);
}

async function retryRecord(signal) {
  if (!model.failed) {
    while (model.next[0] >= model.logs[0].length) await wait(100, signal);
    active(signal);
    model.failed = model.logs[0][model.next[0]];
    model.attempts = 0;
    $("#finance-state").textContent = "P0 ACTIVE";
    await receive(model.failed, signal);
  }
  if (model.attempts === 0) await failedOperation(model.failed, signal);
  while (model.attempts < 3) {
    const retry = model.attempts;
    await process(model.failed, signal, { duration: 800 * 2 ** (retry - 1), activity: "retrying", label: `RETRY ${retry}/2` });
    $("#database-state").textContent = `RETRY ${retry}/2`;
    await failedOperation(model.failed, signal);
  }
  member(0).dataset.activity = "error";
  $(".member-state", member(0)).textContent = "FAILED · 3 ATTEMPTS";
  $("#finance-state").textContent = "P0 BLOCKED";
}

async function deadLetter(signal) {
  await retryRecord(signal);
  const source = model.failed;
  $("#dlq-topic").hidden = false;
  await new Promise(requestAnimationFrame);
  active(signal);
  drawRoutes();
  await fly("dlq", `DLQ SEND · ${identity(source)}`, signal);
  active(signal);
  appendDeadLetter(model, source);
  update();
  await wait(500, signal);
  await animateCommit(source, signal);
  model.failed = null;
  update();
  $(".member-state", member(0)).textContent = "STORED IN DLQ";
  member(0).dataset.activity = "success";
  $("#finance-state").textContent = "P0 ACTIVE";
}

async function retryTraffic(signal) {
  let databaseRecovered = false;
  let databaseTail = Promise.resolve();
  const produce = async () => {
    let partition = 0;
    while (!signal.aborted) {
      await publish(partition, signal);
      partition = 1 - partition;
      await wait(4500, signal);
    }
  };
  const save = async (record) => {
    await process(record, signal);
    const previousWrite = databaseTail;
    let release;
    databaseTail = new Promise((resolve) => { release = resolve; });
    try {
      member(record.partition).dataset.activity = "idle";
      $(".member-state", member(record.partition)).textContent = "WAITING FOR DB";
      await previousWrite;
      active(signal);
      await databaseOperation(record, signal);
      active(signal);
      $("#lesson-database").dataset.activity = "success";
      member(record.partition).dataset.activity = "success";
      $(".member-state", member(record.partition)).textContent = "SAVED";
      await wait(900, signal);
    } finally {
      release();
    }
    await animateCommit(record, signal);
    member(record.partition).dataset.activity = "success";
    await wait(1200, signal);
  };
  const healthyReads = async (partition) => {
    while (!signal.aborted) {
      while (model.next[partition] >= model.logs[partition].length) await wait(100, signal);
      active(signal);
      const record = model.logs[partition][model.next[partition]];
      await receive(record, signal);
      await save(record);
    }
  };
  const consumeP0 = async () => {
    if (scene === 0) {
      await retryRecord(signal);
      while (!signal.aborted) await wait(1000, signal);
      return;
    }
    await deadLetter(signal);
    active(signal);
    model.attempts = 0;
    $("#retry-count").textContent = "DATABASE RECOVERED";
    $("#database-state").textContent = "RECOVERED";
    $("#lesson-database").dataset.activity = "success";
    $(".database-progress i").style.width = "0%";
    await wait(2000, signal);
    active(signal);
    databaseRecovered = true;
    $("#finance-state").textContent = "DB AVAILABLE";
    await healthyReads(0);
  };
  const consumeP1 = async () => {
    while (!model.logs[1].length) await wait(100, signal);
    active(signal);
    const record = model.logs[1][0];
    await receive(record, signal);
    member(1).dataset.activity = "retrying";
    $(".member-state", member(1)).textContent = "DB UNAVAILABLE";
    while (!databaseRecovered) await wait(100, signal);
    await save(record);
    await healthyReads(1);
  };
  await Promise.all([produce(), consumeP0(), consumeP1()]);
}

async function crash(record, signal) {
  const card = member(record.partition);
  card.dataset.activity = "error";
  $(".member-state", card).textContent = "CRASHED";
  $(".member-record", card).textContent = `${identity(record)} · ${record.eventId}`;
  await wait(1700, signal);
  await motion(card, { opacity: [1, 0.35] }, 650, signal);
  const button = $("#connect-button");
  button.hidden = false;
  await new Promise((resolve, reject) => {
    const cleanup = () => { button.removeEventListener("click", reconnect); signal.removeEventListener("abort", abort); button.hidden = true; };
    const reconnect = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(new DOMException("Scene changed", "AbortError")); };
    button.addEventListener("click", reconnect);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  active(signal);
  $(".member-state", card).textContent = "RESTARTING";
  model.position[record.partition] = model.next[record.partition];
  update();
  await motion(card, { opacity: [0.35, 1] }, 650, signal);
  $(".member-progress i", card).style.width = "0%";
  card.dataset.activity = "idle";
  $(".member-state", card).textContent = "WAITING";
}

async function commitBefore(signal) {
  const successful = await fresh(0, signal);
  await receive(successful, signal);
  await animateCommit(successful, signal);
  await process(successful, signal);
  await databaseOperation(successful, signal);
  await wait(1200, signal);
  const record = await fresh(0, signal);
  databaseRecord = record;
  update();
  await receive(record, signal);
  await animateCommit(record, signal);
  await process(record, signal, { duration: 900, progressEnd: 35 });
  model.businessError = record.eventId;
  databaseRecord = record;
  $("#lesson-database").dataset.activity = "error";
  $("#database-state").textContent = "EFFECTS 0";
  update();
  await crash(record, signal);
  const following = await fresh(0, signal);
  await receive(following, signal);
  await animateCommit(following, signal);
  await process(following, signal);
  await databaseOperation(following, signal);
  databaseRecord = record;
  $("#lesson-database").dataset.activity = "error";
  update();
}

async function commitAfter(signal, idempotent = false) {
  const successful = await fresh(0, signal);
  await receive(successful, signal);
  await process(successful, signal);
  await databaseOperation(successful, signal, false, idempotent);
  await animateCommit(successful, signal);
  await wait(1200, signal);
  const record = await fresh(0, signal);
  await receive(record, signal);
  await process(record, signal);
  await databaseOperation(record, signal, false, idempotent);
  await wait(900, signal);
  await crash(record, signal);
  await receive(record, signal, null, true);
  if (!idempotent) member(0).classList.add("is-repeated");
  await process(record, signal);
  await databaseOperation(record, signal, false, idempotent);
  active(signal);
  await animateCommit(record, signal);
  if (!idempotent) member(0).classList.add("is-repeated");
  else {
    member(0).dataset.activity = "success";
    $(".member-state", member(0)).textContent = "PROCESSED";
  }
}

function showJsonProposal(schema) {
  const version = Object.hasOwn(schema.properties, "dispute_id") ? 1 : 2;
  const field = version === 1 ? "dispute_id" : "order_dispute_id";
  $("#schema-version").textContent = `WRITER V${version} · JSON SCHEMA`;
  $("#producer-schema").textContent = `{"type":"object", "properties":{\n "${field}":{"type":"integer"},\n "order_id":{"type":"integer"},\n "reason":{"type":"string"}},\n "required":["${field}","order_id","reason"],\n "additionalProperties":false}`;
  $("#schema-proposal").dataset.version = String(version);
  const payload = { [field]: 12345, order_id: 98765, reason: "object_not_received" };
  $("#schema-payload").textContent = `{ "${field}":12345,\n "order_id":98765,\n "reason":"object_not_received" }`;
  $('[data-event="DisputeCreated"] small').textContent = `PROPOSED · ${field}`;
  return payload;
}

async function parseJsonRecord(record, signal) {
  await receive(record, signal);
  $(".member-record", member(record.partition)).textContent = `${identity(record)} · ${Object.keys(record.payload)[0]}: 12345`;
  if (record.schemaId) {
    const cacheKey = `${record.partition}:${record.schemaId}`;
    if (!model.cache.includes(cacheKey)) {
      $(".member-state", member(record.partition)).textContent = "SCHEMA LOOKUP";
      member(record.partition).dataset.activity = "lookup";
      $("#registry-state").textContent = `GET ID ${record.schemaId}`;
      await fly(`schema-${record.partition}`, `GET ID ${record.schemaId}`, signal);
      await fly(`schema-${record.partition}`, `SCHEMA ID ${record.schemaId}`, signal, true);
      active(signal);
      model.cache.push(cacheKey);
      model.registryRequests += 1;
    }
    $("#registry-state").textContent = `ID ${record.schemaId} · CACHED`;
    $("#lesson-registry").dataset.activity = "idle";
    $("#registry-details").textContent = `…_customer_info_disputes-value\nJSON SCHEMA · FULL · ID ${record.schemaId}\nSCHEMA LOOKUPS ${model.registryRequests}`;
  }
  await process(record, signal, { label: "PARSING", duration: 900 });
  $(".member-state", member(record.partition)).textContent = "PARSED";
  await wait(700, signal);
  await process(record, signal, { label: "VALIDATING V1", duration: 1100 });
  if (!jsonSchemaV1.required.every((field) => Object.hasOwn(record.payload, field)) || Object.entries(record.payload).some(([field, value]) => !jsonSchemaV1.properties[field] || (jsonSchemaV1.properties[field].type === "integer" ? !Number.isInteger(value) : typeof value !== "string"))) {
    model.businessError = record.eventId;
    member(record.partition).dataset.activity = "error";
    $(".member-state", member(record.partition)).textContent = "VALIDATION FAILED";
    update();
    return;
  }
  await process(record, signal, { label: "PROCESSING", duration: 1300 });
  active(signal);
  applyEffect(model, record);
  commit(record);
  member(record.partition).dataset.activity = "success";
  $(".member-state", member(record.partition)).textContent = "PROCESSED";
}

async function schemaBaseline(signal) {
  while (true) {
    const payload = showJsonProposal(jsonSchemaV1);
    const record = await publish(0, signal, { format: "JSON", payload });
    await parseJsonRecord(record, signal);
    await wait(1200, signal);
  }
}

async function invalidPayload(signal) {
  const payload = showJsonProposal(incompatibleJsonSchema);
  const record = await publish(0, signal, { format: "JSON", payload });
  await parseJsonRecord(record, signal);
  update();
}

async function registration(signal, schema) {
  $("#registry-state").textContent = "REGISTERING";
  $("#lesson-registry").dataset.activity = "processing";
  $("#registry-details").textContent = schema.type === "object"
    ? `…_customer_info_disputes-value\nJSON SCHEMA · FULL\nV1 · dispute_id: integer\nPROPOSED · ${Object.hasOwn(schema.properties, "dispute_id") ? "dispute_id" : "order_dispute_id"}: integer`
    : `…_disputes_avro-value\nAVRO · FULL\nuser_id: ${schema.fields.find((field) => field.name === "user_id").type}${schema.fields.some((field) => field.name === "note") ? "\nnote: null | string · default null" : ""}`;
  await fly("registry", "REGISTER", signal);
  active(signal);
  const result = registerSchema(model, schema);
  $("#registry-state").textContent = result.status === 409 ? "409 CONFLICT" : `ID ${result.id} · V${result.version}`;
  $("#lesson-registry").dataset.activity = result.status === 409 ? "error" : "processing";
  await fly("registry", result.status === 409 ? "409 CONFLICT" : `SCHEMA ID ${result.id}`, signal, true);
  return result;
}

async function rejectedSchema(signal) {
  const payload = showJsonProposal(jsonSchemaV1);
  const baseline = await registration(signal, jsonSchemaV1);
  if (scene === 2) {
    for (let index = 0; index < 2; index += 1) {
      const record = await publish(0, signal, { format: "JSON_SCHEMA", payload, schemaId: baseline.id });
      await parseJsonRecord(record, signal);
      await wait(1200, signal);
    }
    return;
  }
  showJsonProposal(incompatibleJsonSchema);
  $("#producer-state").textContent = "SERIALIZING";
  await registration(signal, incompatibleJsonSchema);
  $("#producer-state").textContent = "SERIALIZER FAILED";
  $("#groups-producer").dataset.activity = "error";
}

async function decode(record, signal) {
  const cacheKey = `${record.partition}:${record.schemaId}`;
  const cached = model.cache.includes(cacheKey);
  if (!cached) {
    $(".member-state", member(record.partition)).textContent = "SCHEMA LOOKUP";
    member(record.partition).dataset.activity = "lookup";
    $("#lesson-registry").dataset.activity = "lookup";
    $("#registry-state").textContent = `GET ID ${record.schemaId}`;
    await fly(`schema-${record.partition}`, `GET SCHEMA ${record.schemaId}`, signal);
    active(signal);
    model.registryRequests += 1;
    await fly(`schema-${record.partition}`, `SCHEMA ${record.schemaId}`, signal, true);
    model.cache.push(cacheKey);
    $("#registry-state").textContent = "READY";
    $("#lesson-registry").dataset.activity = "idle";
  }
  $("#registry-details").textContent = `…_disputes_avro-value\nAVRO · FULL · ID ${record.schemaId}\nWRITER V2 · READER V1\nSCHEMA LOOKUPS ${model.registryRequests}`;
  await process(record, signal, { label: cached ? "DECODING · CACHE" : "DECODING", duration: 900 });
  await process(record, signal);
  active(signal);
  applyEffect(model, record);
  commit(record);
}

async function evolvedSchema(signal) {
  if (!model.schemas.length) await registration(signal, schemaV1);
  const result = await registration(signal, compatibleSchema);
  beginAvroTopic(model);
  document.querySelectorAll(".finance-member").forEach((card) => { card.dataset.activity = "idle"; $(".member-state", card).textContent = "WAITING"; });
  document.querySelectorAll(".member-record").forEach((label) => { label.textContent = "—"; });
  update();
  drawRoutes();
  $("#producer-note").textContent = `PREFIX · 0 | ID ${result.id} | AVRO`;
  let sequence = 0;
  while (true) {
    const record = await fresh(0, signal, { eventId: `avro-event-${sequence}`, format: "AVRO", userId: "customer-49328", note: null,
      schemaId: result.id, wirePrefix: [0, 0, 0, 0, result.id] });
    await receive(record, signal);
    await decode(record, signal);
    sequence += 1;
    await wait(1600, signal);
  }
}

async function run(signal) {
  await new Promise(requestAnimationFrame);
  active(signal);
  drawRoutes();
  if (lesson === "retries") return retryTraffic(signal);
  if (lesson === "offsets") return scene === 0 ? commitBefore(signal) : commitAfter(signal, scene === 2);
  if (lesson === "schemas") return scene === 0 ? schemaBaseline(signal) : scene === 1 ? invalidPayload(signal) : rejectedSchema(signal);
  if (scene === 0) return healthy(signal);
}

function enter(destination, restore = false) {
  cancel();
  if (lesson === "retries" || lesson === "schemas") {
    model = createModel();
    checkpoints[destination] = structuredClone(model);
  } else if (restore) model = structuredClone(checkpoints[destination] ?? checkpoints[1] ?? createModel());
  else checkpoints[destination] = structuredClone(model);
  for (const partition of [0, 1]) {
    const record = model.logs[partition][model.position[partition] - 1];
    $(".member-record", member(partition)).textContent = record ? `${identity(record)} · ${record.eventId}` : "—";
  }
  scene = destination;
  databaseRecord = null;
  running = true;
  render();
  const signal = controller.signal;
  run(signal).catch((error) => { if (error.name !== "AbortError") console.error(error); }).finally(() => {
    if (!signal.aborted) { running = false; playback(); }
  });
}

$("#next-button").addEventListener("click", () => {
  if (performance.now() - lastAdvance < 450 || scene >= definitions[lesson].length - 1) return;
  lastAdvance = performance.now();
  enter(scene + 1);
});
$("#previous-button").addEventListener("click", () => { if (scene > 0) enter(scene - 1, true); });
$("#reset-button").addEventListener("click", () => {
  cancel();
  model = createModel();
  checkpoints.length = 0;
  document.querySelectorAll(".member-record").forEach((label) => { label.textContent = "—"; });
  $("#database-details").textContent = "Business effects · 0";
  enter(0);
});
document.querySelectorAll("[data-replay]").forEach((button) => button.addEventListener("click", () => enter(Number(button.dataset.replay), true)));
$("#pause-button").addEventListener("click", () => {
  paused = !paused;
  animations.forEach((animation) => paused ? animation.pause() : animation.play());
  $("#pause-button").textContent = paused ? "▶ Resume" : "Ⅱ Pause";
  $("#pause-button").setAttribute("aria-pressed", String(paused));
  $("#flow-state span").textContent = paused ? "PAUSED" : running ? "PLAYING" : "LIVE";
  $("#flow-state").classList.toggle("is-paused", paused);
});
$("#speed-control").addEventListener("input", (event) => {
  speed = Number(event.target.value);
  animations.forEach((animation) => { animation.speed = speed; });
  $("#speed-output").textContent = `${speed.toFixed(2).replace(/0$/, "")}×`;
});
$("#scenario-select").addEventListener("change", (event) => location.assign(event.target.value));
window.addEventListener("resize", () => requestAnimationFrame(drawRoutes));
enter(0);

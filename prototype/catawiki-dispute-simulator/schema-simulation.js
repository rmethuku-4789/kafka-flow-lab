import { animate } from "motion";

const $ = (selector, root = document) => root.querySelector(selector);
const stage = $("#schema-stage");
const registryCard = $("#registry-card");
const schemaPacket = $("#schema-packet");
const eventPacket = $("#event-packet");
const consumers = ["orders", "finance", "message"];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const duration = reducedMotion ? 0.12 : 1.45;
const consumerSchemaCache = new Map(consumers.map((id) => [id, new Set()]));
const activeAnimations = new Set();
let routes = {};
let latestSchema = null;
let busy = false;
let paused = false;
let resumeWaiters = [];
let nextPartition = 0;
let recordCount = 0;
const nextOffsets = [0, 0, 0];
const partitionCounts = [0, 0, 0];

function explain(html) {
  $("#schema-explanation p").innerHTML = html;
}

function setBusy(value) {
  busy = value;
  $("#run-v1").disabled = value || Boolean(latestSchema);
  $("#publish-again").disabled = value || !latestSchema;
  $("#try-rename").disabled = value || !latestSchema || Boolean(latestSchema?.safeRename);
  $("#safe-rename").disabled = value || !latestSchema || Boolean(latestSchema?.safeRename);
  $("#add-field").disabled = value || !latestSchema || Boolean(latestSchema?.financeField);
  $("#pause-schema").disabled = !value;
  $("#reset-schema").disabled = value;
}

function setPaused(value) {
  paused = value;
  activeAnimations.forEach((animation) => value ? animation.pause() : animation.play());
  $("#pause-schema").textContent = value ? "▶ Resume" : "Ⅱ Pause";
  $("#pause-schema").setAttribute("aria-pressed", String(value));
  if (!value) resumeWaiters.splice(0).forEach((resume) => resume());
}

async function wait(ms) {
  let remaining = ms;
  while (remaining > 0) {
    if (paused) {
      await new Promise((resolve) => resumeWaiters.push(resolve));
      continue;
    }
    const slice = Math.min(50, remaining);
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, slice));
    if (!paused) remaining -= performance.now() - started;
  }
}

function center(element) {
  const origin = stage.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2 - origin.left, y: rect.top + rect.height / 2 - origin.top };
}

function fly(node, from, to, label, path = null) {
  const temporaryPath = !path;
  if (temporaryPath) {
    const start = center(from);
    const end = center(to);
    const direction = Math.sign(end.y - start.y) || 1;
    start.y += direction * from.getBoundingClientRect().height / 2;
    end.y -= direction * to.getBoundingClientRect().height / 2;
    const middleY = (start.y + end.y) / 2;
    path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${start.x} ${start.y} V ${middleY} H ${end.x} V ${end.y}`);
    path.setAttribute("class", "schema-path is-active");
    $("#schema-paths").append(path);
  }
  node.querySelector("b").textContent = label;
  node.dataset.kind = node.classList.contains("schema-packet") ? "schema" : "event";
  if (path) path.dataset.kind = node.dataset.kind;
  node.style.opacity = "1";
  const rect = node.getBoundingClientRect();
  const points = path
    ? Array.from({ length: 25 }, (_, index) => path.getPointAtLength(path.getTotalLength() * index / 24))
    : [center(from), center(to)];
  const animation = animate(node, {
    x: points.map(({ x }) => x - rect.width / 2),
    y: points.map(({ y }) => y - rect.height / 2),
    scale: [0.94, 1],
  }, { duration, ease: [0.22, 1, 0.36, 1] });
  activeAnimations.add(animation);
  if (paused) animation.pause();
  return animation.finished.catch(() => {}).then(() => {
    activeAnimations.delete(animation);
    node.style.opacity = "0";
    if (temporaryPath) path.remove();
  });
}

function drawConnections() {
  const svg = $("#schema-connections");
  const group = $("#schema-paths");
  const bounds = stage.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  group.replaceChildren();

  const connect = (from, to) => {
    const a = center(from);
    const b = center(to);
    const ar = from.getBoundingClientRect();
    const br = to.getBoundingClientRect();
    const direction = Math.sign(b.x - a.x) || 1;
    const startX = a.x + direction * ar.width / 2;
    const endX = b.x - direction * br.width / 2;
    const middleX = (startX + endX) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${startX} ${a.y} H ${middleX} V ${b.y} H ${endX}`);
    path.setAttribute("class", "schema-path event-path");
    path.setAttribute("marker-end", "url(#schema-arrow)");
    group.append(path);
    return path;
  };

  const record = $(`#schema-record-p${nextPartition}`);
  routes = {
    publish: connect($("#schema-producer"), record),
    consume: consumers.map((id) => connect(record, $(`#schema-${id}`))),
  };
}

function updateRegistry(status, className = "") {
  registryCard.classList.remove("is-accepted", "is-rejected");
  if (className) registryCard.classList.add(className);
  $("#registry-state").textContent = status;
}

function renderContract(schema) {
  const dualField = Boolean(schema.safeRename);
  const name = schema.renamed ? "dispute_status" : "status";
  const oldName = dualField
    ? '<div class="contract-field"><code>status</code><small>kept during migration</small></div>'
    : schema.renamed ? '<div class="contract-field is-removed"><code>status</code><small>removed in this version</small></div>' : "";
  const newName = dualField
    ? '<div class="contract-field is-new"><code>dispute_status</code><small>optional · default null</small></div>'
    : `<div class="contract-field ${schema.renamed ? "is-new" : ""}"><code>${name}</code><small>string · required</small></div>`;
  const extra = schema.financeField ? '<div class="contract-field is-new"><code>finance_note</code><small>nullable · default null</small></div>' : "";
  const id = schema.id ? `example schema ID ${schema.id}` : "Not registered";
  $(".contract-box").innerHTML = `<div class="contract-head"><b>WRITES · V${schema.version}</b><span>ILLUSTRATIVE</span></div>${oldName}${newName}${extra}<div class="contract-meta"><span>Avro serializer</span><span id="producer-schema-id">${id}</span></div>`;
}

async function contactRegistry(label) {
  updateRegistry("CHECKING COMPATIBILITY");
  await fly(schemaPacket, $("#schema-producer"), registryCard, label);
}

async function resolveWriterSchema(id, schema, index) {
  const cache = consumerSchemaCache.get(id);
  const consumer = $(`#schema-${id}`);
  if (cache.has(schema.id)) {
    $(`#${id}-state`).textContent = "CACHED";
    return;
  }

  $(`#${id}-state`).textContent = "LOOKUP";
  const packet = schemaPacket.cloneNode(true);
  packet.removeAttribute("id");
  packet.querySelector("b").textContent = `ID ${schema.id}`;
  stage.append(packet);
  await wait(index * 650);
  await fly(packet, consumer, registryCard, "ID lookup");
  await fly(packet, registryCard, consumer, `schema v${schema.version}`);
  packet.remove();
  cache.add(schema.id);
  $(`#${id}-state`).textContent = "CACHED";
}

async function deliverToConsumers(schema, record) {
  consumers.forEach((id) => {
    $(`#${id}-state`).textContent = "READING";
    $(`#schema-${id}`).classList.remove("is-decoded");
  });
  routes.consume.forEach((path) => path.classList.add("is-active"));
  await Promise.all(consumers.map((id, index) => {
    const token = eventPacket.cloneNode(true);
    token.removeAttribute("id");
    token.querySelector("i").textContent = `writer ID ${schema.id}`;
    stage.append(token);
    return fly(token, record, $(`#schema-${id}`), "event", routes.consume[index]).then(() => token.remove());
  }));

  const needsLookup = consumers.some((id) => !consumerSchemaCache.get(id).has(schema.id));
  explain(needsLookup
    ? `<strong>Each consumer got writer schema ID ${schema.id}.</strong> On first use, its deserializer sends that ID to Registry, receives the writer schema, and caches it. Then its own reader code decodes the event.`
    : `<strong>Each consumer got writer schema ID ${schema.id}.</strong> Their deserializers already have this schema cached, so they decode without another Registry lookup.`);
  await Promise.all(consumers.map((id, index) => resolveWriterSchema(id, schema, index)));

  consumers.forEach((id) => {
    $(`#${id}-state`).textContent = "DECODED";
    $(`#schema-${id}`).classList.add("is-decoded");
    const text = schema.safeRename
      ? "reads dispute_status; falls back to status"
      : schema.financeField
      ? (id === "finance" ? "reads finance_note" : "ignores finance_note")
      : "uses the fields its logic needs";
    $(`#${id}-read`).textContent = text;
    if (schema.safeRename) $(`#${id}-reader`).textContent = "READS AS V2";
  });
  await wait(reducedMotion ? 40 : 900);
  routes.consume.forEach((path) => path.classList.remove("is-active"));
}

async function publishRecord(schema) {
  const partition = nextPartition;
  const record = $(`#schema-record-p${partition}`);
  const row = $(`.partition-row[data-partition="P${partition}"]`);
  const offset = nextOffsets[partition];
  record.querySelector(".record-stamp").textContent = String(offset);
  record.querySelector("i").textContent = `writer v${schema.version} · example ID ${schema.id}`;
  eventPacket.querySelector("i").textContent = `writer v${schema.version} · example ID ${schema.id}`;
  row.classList.add("selected");
  $("#broker-state").textContent = `WRITING · P${partition}`;

  routes.publish.classList.add("is-active");
  await fly(eventPacket, $("#schema-producer"), record, `evt-${String(recordCount + 1).padStart(3, "0")}`, routes.publish);
  routes.publish.classList.remove("is-active");
  record.classList.add("has-record");
  row.classList.add("is-stored");
  partitionCounts[partition] += 1;
  $(`#schema-count-p${partition}`).textContent = `${partitionCounts[partition]} ${partitionCounts[partition] === 1 ? "record" : "records"}`;
  $("#schema-broker").classList.add("is-stored");
  $("#broker-state").textContent = `STORED · P${partition} · OFFSET ${offset}`;
  explain(`<strong>Kafka stored the serialized record with writer schema ID ${schema.id} (v${schema.version}).</strong> Consumers use that ID to resolve the schema. In this demo, the producer/serializer checks the event shape; Kafka itself does not validate it.`);
  await deliverToConsumers(schema, record);
  recordCount += 1;
  nextOffsets[partition] += 1;
  nextPartition = (nextPartition + 1) % 3;
  drawConnections();
}

async function registerAndPublishV1() {
  if (busy) return;
  setBusy(true);
  renderContract({ version: 1, renamed: false, financeField: false });
  $("#producer-state").textContent = "PROPOSING V1";
  $("#producer-note").textContent = "Submits v1 for a compatibility check";
  await contactRegistry("propose schema v1");

  latestSchema = { id: 101, version: 1, renamed: false, financeField: false };
  updateRegistry("ACCEPTED · V1", "is-accepted");
  $("#registry-id").textContent = "v1 · example ID 101";
  $("#producer-schema-id").textContent = "example schema ID 101";
  $("#producer-state").textContent = "SCHEMA READY";
  $("#producer-note").textContent = "Example ID 101 cached by producer serializer";
  explain(`<strong>First use of v1:</strong> the producer registers the schema and receives example ID 101. It serializes events against v1 and reuses the cached ID; the Registry is not called for every event.`);
  await publishRecord(latestSchema);
  $("#producer-state").textContent = "PUBLISHED";
  setBusy(false);
}

async function publishAgain() {
  if (!latestSchema || busy) return;
  setBusy(true);
  $("#producer-state").textContent = "SERIALIZING";
  $("#producer-note").textContent = `Reuses cached schema ID ${latestSchema.id}`;
  explain(`<strong>Producer still writes v${latestSchema.version}.</strong> It reuses writer schema ID ${latestSchema.id}; consumers use their own reader code to interpret the decoded event.`);
  await publishRecord(latestSchema);
  $("#producer-state").textContent = "PUBLISHED";
  setBusy(false);
}

async function tryRename() {
  if (!latestSchema || busy) return;
  setBusy(true);
  const proposed = { ...latestSchema, version: latestSchema.version + 1, id: null, renamed: true };
  renderContract(proposed);
  $("#producer-state").textContent = `PROPOSING V${proposed.version}`;
  $("#producer-note").textContent = "Registry checks before this version is used";
  await contactRegistry(`propose v${proposed.version} · rename`);
  updateRegistry("REJECTED · INCOMPATIBLE", "is-rejected");
  explain(`<strong>Rejected before publishing.</strong> Avro sees a rename as removing <code>status</code> and adding <code>dispute_status</code>. The new field is required and has no default, but old records do not contain it, so a new reader cannot read them. BACKWARD fails and this event never reaches Kafka.`);
  $("#producer-state").textContent = "NOT PUBLISHED";
  $("#producer-note").textContent = "The registered version stays unchanged";
  await wait(reducedMotion ? 40 : 900);
  renderContract(latestSchema);
  $("#producer-schema-id").textContent = `example schema ID ${latestSchema.id}`;
  setBusy(false);
}

async function safeRename() {
  if (!latestSchema || busy || latestSchema.safeRename) return;
  setBusy(true);
  updateRegistry(`ACCEPTED · V${latestSchema.version}`, "is-accepted");
  $("#registry-id").textContent = `v${latestSchema.version} · example ID ${latestSchema.id}`;

  consumers.forEach((id) => {
    $(`#${id}-reader`).textContent = "READS AS V2";
    $(`#${id}-read`).textContent = "supports new name; keeps old name";
  });
  $("#producer-state").textContent = `STILL WRITES V${latestSchema.version}`;
  explain("<strong>Step 1 · Update consumer code first.</strong> Every service now reads <code>dispute_status</code> when present and falls back to <code>status</code>. Keep the producer on v1 until all consumers are deployed. Schema Registry cannot verify which consumer code is deployed.");
  await wait(reducedMotion ? 40 : 1300);

  const proposed = { ...latestSchema, version: latestSchema.version + 1, id: null, renamed: false, safeRename: true };
  renderContract(proposed);
  $("#producer-state").textContent = `PROPOSING V${proposed.version}`;
  $("#producer-note").textContent = "Keeps old field; adds optional new field";
  await contactRegistry(`propose v${proposed.version} · safe rename`);
  latestSchema = { ...proposed, id: latestSchema.id + 1 };
  updateRegistry(`ACCEPTED · V${latestSchema.version}`, "is-accepted");
  $("#registry-id").textContent = `v${latestSchema.version} · example ID ${latestSchema.id}`;
  $("#producer-schema-id").textContent = `example schema ID ${latestSchema.id}`;
  $("#producer-state").textContent = `READY TO WRITE V${latestSchema.version}`;
  $("#producer-note").textContent = `New writer schema · example ID ${latestSchema.id}`;
  explain(`<strong>Step 2 · Register schema v${latestSchema.version}.</strong> It keeps <code>status</code> and adds nullable <code>dispute_status</code> with a null default. BACKWARD checks compatibility with the latest registered version (v${latestSchema.version - 1}), not every historical version. The Registry checks schemas; it cannot confirm consumer deployments. The displayed schema ID is an example assigned by the Registry.`);
  await wait(reducedMotion ? 40 : 1300);

  $("#producer-state").textContent = `WRITES V${latestSchema.version}`;
  explain(`<strong>Step 3 · Publish both fields.</strong> This record carries writer schema v${latestSchema.version}, example ID ${latestSchema.id}. All upgraded consumer code understands the new name and still accepts the old one.`);
  await publishRecord(latestSchema);
  explain("<strong>Safe rollout complete.</strong> Consumers use <code>dispute_status</code> while <code>status</code> is still present. Remove <code>status</code> only after every consumer is upgraded; use BACKWARD_TRANSITIVE if the new schema must be compatible with every earlier version, not just the latest one.");
  setBusy(false);
}

async function addFinanceField() {
  if (!latestSchema || busy || latestSchema.financeField) return;
  setBusy(true);
  const proposed = { ...latestSchema, version: latestSchema.version + 1, id: null, financeField: true };
  renderContract(proposed);
  $("#producer-state").textContent = `PROPOSING V${proposed.version}`;
  $("#producer-note").textContent = "Adds nullable field with default null";
  await contactRegistry(`propose v${proposed.version} · add field`);

  latestSchema = { ...proposed, id: 102 };
  updateRegistry(`ACCEPTED · V${latestSchema.version}`, "is-accepted");
  $("#registry-id").textContent = `v${latestSchema.version} · example ID ${latestSchema.id}`;
  $("#producer-schema-id").textContent = `example schema ID ${latestSchema.id}`;
  $("#producer-state").textContent = "SCHEMA READY";
  $("#producer-note").textContent = `Producer caches new ID ${latestSchema.id}`;
  explain(`<strong>Accepted under Avro BACKWARD.</strong> The optional <code>finance_note</code> has a null default, so the new schema can read older records. Kafka delivers the whole new record to every consumer.`);
  await wait(reducedMotion ? 40 : 900);
  await publishRecord(latestSchema);
  $("#producer-state").textContent = "PUBLISHED";
  setBusy(false);
}

function reset() {
  setPaused(false);
  latestSchema = null;
  busy = false;
  nextPartition = 0;
  recordCount = 0;
  nextOffsets.fill(0);
  partitionCounts.fill(0);
  consumerSchemaCache.forEach((cache) => cache.clear());
  updateRegistry("NO SCHEMA YET");
  $("#registry-id").textContent = "Awaiting v1";
  $("#producer-state").textContent = "READY";
  $("#producer-note").textContent = "Proposes a schema version first";
  $("#broker-state").textContent = "EMPTY";
  $("#schema-broker").classList.remove("is-stored");
  renderContract({ version: 1, renamed: false, financeField: false });
  consumers.forEach((id) => {
    $(`#${id}-state`).textContent = "WAITING";
    $(`#${id}-read`).textContent = "Waiting for a readable event";
    $(`#${id}-reader`).textContent = "READS AS V1";
    $(`#schema-${id}`).classList.remove("is-decoded");
  });
  document.querySelectorAll(".schema-record").forEach((record) => record.classList.remove("has-record"));
  document.querySelectorAll(".partition-row").forEach((row) => row.classList.remove("is-stored", "selected"));
  document.querySelectorAll(".partition-count").forEach((count) => { count.textContent = "EMPTY"; });
  explain("On first use, the producer serializer registers a schema and caches its ID. Each consumer deserializer looks up the record's ID, then caches that schema.");
  setBusy(false);
  drawConnections();
}

  $("#run-v1").addEventListener("click", registerAndPublishV1);
$("#publish-again").addEventListener("click", publishAgain);
$("#try-rename").addEventListener("click", tryRename);
$("#safe-rename").addEventListener("click", safeRename);
$("#add-field").addEventListener("click", addFinanceField);
$("#pause-schema").addEventListener("click", () => setPaused(!paused));
$("#reset-schema").addEventListener("click", reset);
window.addEventListener("resize", drawConnections);
requestAnimationFrame(drawConnections);

import { animate } from "motion";

const $ = (selector, root = document) => root.querySelector(selector);
const stage = $("#ordering-stage");
const packet = $("#ordering-packet");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const duration = reducedMotion ? 0.12 : 1.45;
const activeAnimations = new Set();
const offsets = [0, 0, 0];
let busy = false;
let paused = false;
let resumeWaiters = [];

function explain(html) {
  $("#ordering-explanation p").innerHTML = html;
}

function setBusy(value) {
  busy = value;
  $("#publish-keyed-order").disabled = value;
  $("#publish-unkeyed-order").disabled = value;
  $("#reset-ordering").disabled = value;
  $("#pause-ordering").disabled = !value;
}

function setPaused(value) {
  paused = value;
  activeAnimations.forEach((animation) => value ? animation.pause() : animation.play());
  $("#pause-ordering").textContent = value ? "▶ Resume" : "Ⅱ Pause";
  $("#pause-ordering").setAttribute("aria-pressed", String(value));
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

function connect(group, from, to) {
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
  path.setAttribute("class", "ordering-path");
  path.setAttribute("marker-end", "url(#ordering-arrow)");
  group.append(path);
  return path;
}

function drawConnections(partition = 1) {
  const svg = $("#ordering-connections");
  const group = $("#ordering-paths");
  const bounds = stage.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  group.replaceChildren();
  const row = $(`[data-order-partition="P${partition}"]`);
  return {
    publish: connect(group, $("#ordering-producer"), row),
    consume: connect(group, row, $("#ordering-consumer")),
    row,
  };
}

async function fly(from, to, label, details, path, returning = false) {
  packet.querySelector("b").textContent = label;
  packet.dataset.kind = label.includes("Resolved") ? "resolved" : "event";
  if (path) path.dataset.kind = packet.dataset.kind;
  packet.querySelector("small").textContent = details;
  packet.classList.toggle("is-returning", returning);
  packet.style.display = "flex";
  packet.style.opacity = "1";
  const rect = packet.getBoundingClientRect();
  const length = path.getTotalLength();
  const points = Array.from({ length: 25 }, (_, index) => path.getPointAtLength(length * index / 24));
  const animation = animate(packet, {
    x: points.map(({ x }) => x - rect.width / 2),
    y: points.map(({ y }) => y - rect.height / 2),
    scale: [0.94, 1],
  }, { duration, ease: [0.22, 1, 0.36, 1] });
  activeAnimations.add(animation);
  if (paused) {
    animation.pause();
  }
  await animation.finished.catch(() => {});
  activeAnimations.delete(animation);
  packet.style.opacity = "0";
  packet.style.display = "none";
  path.classList.remove("is-active");
}

async function storeEvent(name, partition, key) {
  const route = drawConnections(partition);
  const offset = offsets[partition];
  const eventId = name === "DisputeCreated" ? "created" : "resolved";
  const keyLabel = key ? `key ${key}` : "no key";
  route.row.classList.add("selected");
  $("#ordering-broker-state").textContent = `WRITING · P${partition}`;
  route.publish.classList.add("is-active");
  await fly($("#ordering-producer"), route.row, name, `${keyLabel} · schema ID 101`, route.publish);

  const record = document.createElement("span");
  record.className = "order-token";
  record.innerHTML = `<i>${offset}</i><b>${name.replace("Dispute", "")}</b><small>ID 101</small>`;
  const slot = $(`#order-record-p${partition}`);
  slot.append(record);
  slot.classList.add("has-record");
  route.row.classList.add("is-stored");
  offsets[partition] += 1;
  $(`#order-count-p${partition}`).textContent = `${offsets[partition]} ${offsets[partition] === 1 ? "record" : "records"}`;
  $("#ordering-broker").classList.add("is-stored");
  $("#ordering-broker-state").textContent = `STORED · P${partition} · OFFSET ${offset}`;
  $(`#order-event-${eventId}`).classList.add("is-sent");

  return { name, partition, keyLabel, offset, row: route.row };
}

async function readEvent(event, outOfOrder = false) {
  const route = drawConnections(event.partition);
  route.row.classList.add("selected", "is-stored");
  route.consume.classList.add("is-active");
  $("#ordering-consumer-state").textContent = `READING P${event.partition}`;
  await wait(reducedMotion ? 30 : 420);
  await fly(route.row, $("#ordering-consumer"), event.name, `schema ID 101 · ${event.keyLabel}`, route.consume, true);
  if (!$("#read-order .is-read")) $("#read-order").replaceChildren();
  const line = document.createElement("span");
  line.className = outOfOrder ? "is-read is-out-of-order" : "is-read";
  line.textContent = `P${event.partition} · ${event.offset} · ${event.name}`;
  $("#read-order").append(line);
  $("#ordering-consumer-state").textContent = "READING RECORDS";
}

async function publishKeyed() {
  if (busy) return;
  setBusy(true);
  reset(false);
  $("#ordering-producer-state").textContent = "PUBLISHING KEYED EVENTS";
  $("#ordering-key-value").textContent = "order-49328";
  $("#ordering-key-note").textContent = "Same key on both records";
  explain("<strong>Same key, same route.</strong> Both records use <code>order-49328</code>, so this demonstration's fixed partitioner sends them to P1. Each record carries schema ID 101. Kafka appends them at offsets 0 and 1, and the consumer reads P1 in that order.");
  await readEvent(await storeEvent("DisputeCreated", 1, "order-49328"));
  await readEvent(await storeEvent("DisputeResolved", 1, "order-49328"));
  $("#ordering-producer-state").textContent = "PUBLISHED";
  $("#ordering-consumer-state").textContent = "READ IN ORDER";
  explain("<strong>One partition, one log order.</strong> This consumer reads <code>DisputeCreated</code> before <code>DisputeResolved</code> because they were appended to P1 in that order. The serializer reuses schema ID 101; each record goes directly to Kafka.");
  setBusy(false);
}

async function publishUnkeyed() {
  if (busy) return;
  setBusy(true);
  reset(false);
  $("#ordering-producer-state").textContent = "PUBLISHING · NO KEY";
  $("#ordering-key-value").textContent = "(no key)";
  $("#ordering-key-note").textContent = "Producer selects the partition";
  $("#ordering-consequence").hidden = true;
  explain("<strong>Watch a possible out-of-order read.</strong> Both events will be stored on separate partitions first. Then the consumer will read <code>DisputeResolved</code> before <code>DisputeCreated</code>.");
  const created = await storeEvent("DisputeCreated", 0, null);
  const resolved = await storeEvent("DisputeResolved", 2, null);
  await readEvent(resolved, true);
  await readEvent(created);
  $("#ordering-producer-state").textContent = "PUBLISHED · UNKEYED";
  $("#ordering-consumer-state").textContent = "RESOLVED READ FIRST";
  $("#ordering-consequence").hidden = false;
  explain("<strong>This is one possible cross-partition interleaving.</strong> Kafka preserves order within P0 and P2, but it does not define one overall order between them. The consumer happened to read P2 first in this example.");
  setBusy(false);
}

function reset(restoreExplanation = true) {
  setPaused(false);
  offsets.fill(0);
  $("#ordering-broker").classList.remove("is-stored");
  $("#ordering-broker-state").textContent = "EMPTY";
  $("#ordering-producer-state").textContent = "READY";
  $("#ordering-consumer-state").textContent = "WAITING";
  $("#ordering-key-value").textContent = "order-49328";
  $("#ordering-key-note").textContent = "Same key on both records";
  $("#ordering-consequence").hidden = true;
  $("#read-order").replaceChildren(Object.assign(document.createElement("span"), { textContent: "Waiting for records" }));
  $("#ordering-paths").replaceChildren();
  packet.style.opacity = "0";
  packet.style.display = "none";
  packet.classList.remove("is-returning");
  stage.querySelectorAll(".partition-row").forEach((row) => row.classList.remove("is-stored", "selected"));
  stage.querySelectorAll(".partition-count").forEach((count) => { count.textContent = "EMPTY"; });
  stage.querySelectorAll(".order-record").forEach((record) => { record.replaceChildren(); record.classList.remove("has-record"); });
  stage.querySelectorAll(".order-event-list > div").forEach((event) => event.classList.remove("is-sent"));
  if (restoreExplanation) explain("Both events use the same schema ID. The key affects which partition gets them; Kafka preserves order within each partition.");
}

$("#publish-keyed-order").addEventListener("click", publishKeyed);
$("#publish-unkeyed-order").addEventListener("click", publishUnkeyed);
$("#pause-ordering").addEventListener("click", () => setPaused(!paused));
$("#reset-ordering").addEventListener("click", () => reset());
window.addEventListener("resize", () => requestAnimationFrame(() => drawConnections()));
requestAnimationFrame(() => drawConnections());

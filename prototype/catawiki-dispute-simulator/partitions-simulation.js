import { animate } from "motion";

const $ = (selector, root = document) => root.querySelector(selector);
const stage = $("#ordering-stage");
const packet = $("#ordering-packet");
const consumers = [...document.querySelectorAll("[data-partitions-consumer]")];
const rows = $("#partition-list");
const speedControl = $("#partition-speed");
const speedOutput = $("#partition-speed-value");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const activeAnimations = new Set();
const offsets = [0, 0];
const beats = ["PRESSURE", "PARTITIONS ADDED", "NO KEY · ORDER RISK", "SAME KEY · ORDERED"];
let speed = Number(speedControl.value);
let step = 0;
let busy = false;
let paused = false;
let partitionsAdded = false;
let resumeWaiters = [];

function explain(copy) {
  $("#ordering-explanation p").textContent = copy;
}

function updateControls() {
  const previous = $("#previous-partition-step");
  const next = $("#next-partition-step");
  previous.disabled = busy;
  previous.textContent = step === 0 ? "← Back to recap" : "← Previous";
  next.disabled = busy || step === 3;
  next.textContent = ["What would you try? →", "Follow the events →", "Replay with the same key →", "Scenario complete · choose another above"][step];
  $("#partition-step-label").textContent = `${beats[step]} · ${step + 1} OF 4`;
  $("#jump-unkeyed").disabled = busy;
  $("#jump-keyed").disabled = busy;
  $("#jump-unkeyed").setAttribute("aria-pressed", String(step === 2));
  $("#jump-keyed").setAttribute("aria-pressed", String(step === 3));
  $("#pause-ordering").disabled = !busy;
  $("#reset-ordering").disabled = busy;
}

function setBusy(value) {
  busy = value;
  updateControls();
}

function setPaused(value) {
  paused = value;
  activeAnimations.forEach((animation) => value ? animation.pause() : animation.play());
  $("#pause-ordering").textContent = value ? "▶ Resume" : "Ⅱ Pause";
  $("#pause-ordering").setAttribute("aria-pressed", String(value));
  $("#partition-playback-status").textContent = value ? "PAUSED · EXPLAIN" : busy ? "ANIMATION PLAYING" : "READY TO EXPLAIN";
  if (!value) resumeWaiters.splice(0).forEach((resume) => resume());
}

async function wait(duration) {
  let remaining = reducedMotion ? 20 : duration;
  while (remaining > 0) {
    if (paused) {
      await new Promise((resolve) => resumeWaiters.push(resolve));
      continue;
    }
    const slice = Math.min(50, remaining / speed);
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, slice));
    if (!paused) remaining -= (performance.now() - started) * speed;
  }
}

function center(element) {
  const origin = stage.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2 - origin.left, y: rect.top + rect.height / 2 - origin.top };
}

function connect(group, d, route, hidden = false) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("class", hidden ? "partition-motion-route" : "ordering-path is-static");
  path.dataset.flowPath = route;
  if (hidden) {
    path.style.fill = "none";
    path.style.stroke = "transparent";
    path.style.opacity = "0";
    path.style.pointerEvents = "none";
  }
  group.append(path);
  return path;
}

function drawConnections() {
  const svg = $("#ordering-connections");
  const group = $("#ordering-paths");
  const bounds = stage.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  group.replaceChildren();
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left - bounds.left, right: box.right - bounds.left, centerY: (box.top + box.bottom) / 2 - bounds.top };
  };
  const producer = rect($("#ordering-producer"));
  const broker = rect($("#ordering-broker"));
  const consumerBoxes = consumers.map((element) => ({ element, box: rect(element) }));
  const spineX = (broker.right + consumerBoxes[0].box.left) / 2;
  const producerRouteX = (producer.right + broker.left) / 2;
  connect(group, `M ${producer.right} ${producer.centerY} H ${producerRouteX} V ${broker.centerY} H ${broker.left}`, "publish");
  connect(group, `M ${broker.right} ${broker.centerY} H ${spineX}`, "broker-entry");
  connect(group, `M ${spineX} ${consumerBoxes[0].box.centerY} V ${consumerBoxes.at(-1).box.centerY}`, "consumer-spine");
  for (const { element, box } of consumerBoxes) {
    const consumer = element.dataset.partitionsConsumer;
    connect(group, `M ${spineX} ${box.centerY} H ${box.left}`, `branch-${consumer}`);
    connect(group, `M ${broker.right} ${broker.centerY} H ${spineX} V ${box.centerY} H ${box.left}`, `consume-${consumer}`, true);
  }
}

function routePath(name) {
  return $(`[data-flow-path="${name}"]`, $("#ordering-paths"));
}

async function fly(from, to, label, details, path, returning = false, movingPacket = packet) {
  if (movingPacket !== packet) {
    movingPacket.removeAttribute("id");
    movingPacket.style.cssText = "";
    stage.append(movingPacket);
  }
  movingPacket.querySelector("b").textContent = label;
  movingPacket.dataset.kind = label.includes("Resolved") ? "resolved" : label.includes("Timeout") ? "error" : "event";
  if (path) path.dataset.kind = movingPacket.dataset.kind;
  movingPacket.querySelector("small").textContent = details;
  movingPacket.classList.toggle("is-returning", returning);
  movingPacket.style.display = "flex";
  movingPacket.style.opacity = "1";
  const rect = movingPacket.getBoundingClientRect();
  const points = reducedMotion
    ? [center(from), center(to)]
    : Array.from({ length: 25 }, (_, index) => path.getPointAtLength(path.getTotalLength() * index / 24));
  if (returning && !reducedMotion) points.reverse();
  const animation = animate(movingPacket, {
    x: points.map((point) => point.x - rect.width / 2),
    y: points.map((point) => point.y - rect.height / 2),
    scale: [0.94, 1],
  }, { duration: reducedMotion ? 0.12 : 1.35, speed, ease: [0.22, 1, 0.36, 1] });
  activeAnimations.add(animation);
  if (paused) animation.pause();
  await animation.finished.catch(() => {});
  activeAnimations.delete(animation);
  movingPacket.style.opacity = "0";
  movingPacket.style.display = "none";
  if (movingPacket !== packet) movingPacket.remove();
  path.classList.remove("is-active");
}

async function sendRecord(name, partition, keyText) {
  const partitionName = `P${partition}`;
  const row = $(`[data-order-partition="${partitionName}"]`);
  const path = routePath("publish");
  const offset = offsets[partition];
  const isCreated = name === "DisputeCreated";
  const label = isCreated ? "Created" : "Resolved";
  row.classList.add("selected");
  $("#partition-playback-status").textContent = `PRODUCER → ${partitionName}`;
  $("#ordering-broker-state").textContent = `WRITING · ${partitionName}`;
  path.classList.add("is-active");
  await fly($("#ordering-producer"), $("#ordering-broker"), name, keyText, path);

  const record = document.createElement("span");
  record.className = "order-token";
  const offsetLabel = document.createElement("i");
  offsetLabel.textContent = String(offset);
  const eventLabel = document.createElement("b");
  eventLabel.textContent = label;
  eventLabel.title = name;
  record.append(offsetLabel, eventLabel);
  const track = $(`#order-record-p${partition}`);
  track.append(record);
  const visibleLimit = 2;
  while (track.children.length > visibleLimit) track.firstElementChild.remove();
  track.classList.add("has-record");
  row.classList.add("is-stored");
  offsets[partition] += 1;
  $(`#order-count-p${partition}`).textContent = `${offsets[partition]} ${offsets[partition] === 1 ? "record" : "records"}`;
  $("#ordering-broker").classList.add("is-stored");
  $("#ordering-broker-state").textContent = `STORED · ${partitionName} · OFFSET ${offset}`;
  $(`#order-event-${isCreated ? "created" : "resolved"}`).classList.add("is-sent");
  await fly($("#ordering-broker"), $("#ordering-producer"), "BROKER ACK", `${partitionName} · OFFSET ${offset}`, path, true);
  await wait(260);
  return { name, partition, offset, keyText, row };
}

async function readRecord(record, order, state, resultClass = "") {
  const partitionName = `P${record.partition}`;
  $("#partition-playback-status").textContent = `MESSAGE MOVING · ${partitionName} → 3 SERVICES`;
  consumers.forEach((consumer) => {
    $("[data-consumer-state]", consumer).textContent = `POLLING ${partitionName}`;
    consumer.classList.remove("is-done");
    consumer.classList.add("is-receiving");
  });
  await Promise.all(consumers.map((consumer) => {
    const path = routePath(`consume-${consumer.dataset.partitionsConsumer}`);
    path.classList.add("is-active");
    return fly($("#ordering-broker"), consumer, record.name, `${record.keyText} · ${partitionName}`, path, false, packet.cloneNode(true));
  }));
  const token = [...record.row.querySelectorAll(".order-token")].find((item) => item.querySelector("i").textContent === String(record.offset));
  const nextOffset = record.offset + 1;
  token?.classList.add("is-consumed", "is-committed");
  token?.setAttribute("aria-label", `Offset ${record.offset}, ${record.name}, read and independently committed by each consumer group; record remains in the Kafka log`);
  $("#partition-consumption-note").hidden = false;
  $("#partition-commit-status").textContent = `3 INDEPENDENT GROUP COMMITS · ${partitionName} NEXT OFFSET ${nextOffset} · RECORD RETAINED`;
  $("#partition-playback-status").textContent = `3 SERVICES READ · ${partitionName} OFFSET ${record.offset}`;
  consumers.forEach((consumer) => {
    const readOrder = $("[data-read-order]", consumer);
    const line = document.createElement("span");
    line.className = `is-read ${consumer.dataset.partitionsConsumer === "finance" ? resultClass : ""}`.trim();
    line.textContent = `${order} · ${partitionName}:${record.offset} → NEXT ${nextOffset}`;
    readOrder.replaceChildren(line);
    $("[data-consumer-state]", consumer).textContent = state;
    consumer.classList.remove("is-receiving");
    consumer.classList.add("is-done");
  });
  if (record.name === "DisputeCreated") $("#dispute-outcome b").textContent = "OPEN";
}

function addPartitionRow() {
  const row = document.createElement("div");
  row.className = "partition-row is-entering";
  row.dataset.orderPartition = "P1";
  row.innerHTML = '<span class="partition-name">P1</span><div class="partition-track"><span class="order-record" id="order-record-p1"></span></div><span class="partition-count" id="order-count-p1">EMPTY</span>';
  rows.append(row);
  const animation = animate(row, { opacity: [0, 1], y: [8, 0] }, { duration: reducedMotion ? 0.12 : 0.45, speed, ease: "easeOut" });
  activeAnimations.add(animation);
  if (paused) animation.pause();
  return animation.finished.catch(() => {}).finally(() => {
    activeAnimations.delete(animation);
    row.classList.remove("is-entering");
  });
}

async function addSecondPartition() {
  setBusy(true);
  $("#producer-send-outcome").hidden = true;
  $("#partition-playback-status").textContent = "ADDING P1";
  await addPartitionRow();
  partitionsAdded = true;
  drawConnections();
  $("#partition-count-state").textContent = "2 PARTITIONS";
  $("#partition-broker-note").textContent = "Two ordered logs · potential write lanes";
  $("#ordering-key-note").textContent = "Illustrative route · new writes to P0 + P1";
  $("#partition-load-state").textContent = "P1 ADDED · WRITE DISTRIBUTION NOT SHOWN YET";
  $("#partition-pressure").classList.remove("is-relieved");
  $(".pressure-meter i").style.width = "92%";
  $("#ordering-broker").classList.add("is-stored");
  $("#ordering-broker-state").textContent = "TOPIC EXPANDED";
  explain("P1 creates another possible write lane, but it does not split records already in P0. Whether pressure falls depends on where partition leaders run and whether producers distribute new writes across them.");
  $("#partition-playback-status").textContent = "NEW SENDS FLOWING TO BOTH PARTITIONS";
  const distributedRecords = [
    await sendRecord("DisputeCreated", 0, "no key · dispute-49330"),
    await sendRecord("DisputeCreated", 1, "no key · dispute-49331"),
  ];
  $("#partition-load-state").textContent = "NEW WRITES DISTRIBUTED ACROSS P0 + P1";
  $("#partition-pressure").classList.add("is-relieved");
  $(".pressure-meter i").style.width = "54%";
  explain("New writes now reach both partitions. Records already in P0 stay there.");
  await readRecord(distributedRecords[0], "NEXT", "READ FROM P0");
  await readRecord(distributedRecords[1], "NEXT", "READ FROM P1");
  step = 1;
  $("#partition-playback-status").textContent = "BOTH PARTITIONS FLOWING TO FINANCE";
  setBusy(false);
}

async function showInitialPressure() {
  setBusy(true);
  $("#producer-send-outcome").hidden = true;
  consumers.forEach((consumer) => {
    $("[data-consumer-state]", consumer).textContent = "WAITING";
    $("[data-read-order]", consumer).replaceChildren(Object.assign(document.createElement("span"), { textContent: "Waiting for dispute events" }));
  });
  $("#ordering-producer-state").textContent = "PUBLISHING · NO KEY";
  $("#ordering-key-note").textContent = "Illustrative load · records routed to P0";
  $("#partition-pressure").classList.add("is-balanced");
  $("#partition-pressure").classList.remove("is-relieved");
  $("#partition-load-state").textContent = "P0 KEEPING UP · NORMAL FLOW";
  $(".pressure-meter i").style.width = "30%";
  $("#partition-playback-status").textContent = "NORMAL FLOW · PRODUCER → P0 → SERVICES";
  const normalDisputes = ["dispute-49328", "dispute-49329"];
  for (let index = 0; index < normalDisputes.length; index += 1) {
    const record = await sendRecord("DisputeCreated", 0, `no key · ${normalDisputes[index]}`);
    await readRecord(record, `NORMAL ${index + 1}`, "READ · CONTINUOUS FLOW");
    await wait(650);
  }
  $("#partition-pressure").classList.remove("is-balanced");
  $("#ordering-producer-state").textContent = "PRODUCING FASTER THAN P0";
  $("#partition-playback-status").textContent = "PRODUCER CONTINUES · P0 FALLS BEHIND";
  for (let index = 0; index < 3; index += 1) {
    $("#partition-load-state").textContent = "P0 APPENDING MORE SLOWLY";
    $(".pressure-meter i").style.width = `${55 + index * 15}%`;
    const record = await sendRecord("DisputeCreated", 0, `no key · dispute-${49330 + index}`);
    await readRecord(record, `PRESSURE ${index + 1}`, "READ · P0 UNDER LOAD");
  }
  $("#ordering-producer-state").textContent = "PRODUCER KEEPS SENDING";
  $("#partition-load-state").textContent = "P0 LEADER IS THE BOTTLENECK";
  $(".pressure-meter i").style.width = "92%";
  $("#partition-playback-status").textContent = "NEXT SEND WAITING · PRODUCER STILL ACTIVE";
  await wait(500);
  const failedSend = $("#producer-send-outcome");
  failedSend.hidden = false;
  const failureAnimation = animate(failedSend, { opacity: [0, 1], x: [-8, 0], scale: [0.97, 1] }, { duration: reducedMotion ? 0.12 : 0.4, speed, ease: "easeOut" });
  activeAnimations.add(failureAnimation);
  if (paused) failureAnimation.pause();
  await failureAnimation.finished.catch(() => {});
  activeAnimations.delete(failureAnimation);
  $("#partition-playback-status").textContent = "PRODUCER SEND FAILED · PRODUCER ACTIVE";
  explain("This demo injects a producer-side send failure before append. A slow leader can cause delay and retries; it does not make a Kafka partition fill up or guarantee this exact failure.");
  setBusy(false);
}

async function showUnkeyedOrder() {
  setBusy(true);
  clearRun(false);
  await ensureTwoPartitions();
  setBusy(true);
  $("#order-event-resolved").hidden = false;
  $("#ordering-producer-state").textContent = "PUBLISHING · NO KEY";
  $("#ordering-key-value").textContent = "(no key)";
  $("#ordering-key-note").textContent = "Example partition placement";
  $("#partition-load-state").textContent = "TWO PARTITIONS · NO SHARED ORDER";
  explain("For this illustration, the producer places Created on P0 and Resolved on P1, letting Finance process P1 first. Kafka's default producer uses a sticky partition when there is no key; this explicit placement shows that records in different partitions have no shared order.");
  const created = await sendRecord("DisputeCreated", 0, "no key · example placement");
  const resolved = await sendRecord("DisputeResolved", 1, "no key · example placement");
  await readRecord(resolved, "1st", "RESOLVED ARRIVED FIRST", "is-blocked");
  $("#dispute-outcome").classList.add("is-invalid");
  $("#dispute-outcome b").textContent = "RESOLVED EVENT · DISPUTE NOT CREATED";
  await wait(500);
  await readRecord(created, "2nd", "CREATED PROCESSED", "is-warning");
  $("#dispute-outcome b").textContent = "OPEN · EXPECTED RESOLVED";
  $("#ordering-producer-state").textContent = "PUBLISHED · NO KEY";
  $("#partition-playback-status").textContent = "OUT-OF-ORDER APP RESULT";
  explain("Resolved arrived first, so this example handler leaves the dispute OPEN.");
  step = 2;
  setBusy(false);
}

async function showKeyedOrder() {
  setBusy(true);
  clearRun(false);
  await ensureTwoPartitions();
  setBusy(true);
  $("#order-event-resolved").hidden = false;
  $("#ordering-producer-state").textContent = "PUBLISHING · KEYED";
  $("#ordering-key-value").textContent = "dispute-49328";
  $("#ordering-key-note").textContent = "Same key on both records";
  $("#partition-load-state").textContent = "SAME KEY · SAME PARTITION";
  explain("Replay the same dispute with the same key. This demo places both records on P1, so they are appended and read there in order. In Kafka, adding partitions can change a key's hash-based mapping; old records are not moved, so plan partition expansion if existing per-key order must span that change.");
  const created = await sendRecord("DisputeCreated", 1, "key dispute-49328");
  const resolved = await sendRecord("DisputeResolved", 1, "key dispute-49328");
  await readRecord(created, "1st", "CREATED APPLIED");
  $("#dispute-outcome b").textContent = "OPEN";
  await wait(400);
  await readRecord(resolved, "2nd", "READ IN ORDER");
  $("#dispute-outcome").classList.remove("is-invalid");
  $("#dispute-outcome").classList.add("is-resolved");
  $("#dispute-outcome b").textContent = "RESOLVED · CORRECT ORDER";
  $("#ordering-producer-state").textContent = "PUBLISHED · SAME KEY";
  $("#partition-playback-status").textContent = "ORDER PRESERVED IN P1";
  explain("Same key, same partition: Finance reads Created before Resolved.");
  step = 3;
  setBusy(false);
}

async function ensureTwoPartitions() {
  if (partitionsAdded) return;
  await addPartitionRow();
  partitionsAdded = true;
  drawConnections();
  $("#partition-count-state").textContent = "2 PARTITIONS";
  $("#partition-broker-note").textContent = "Two ordered logs · parallel work";
  $("#ordering-broker-state").textContent = "TOPIC EXPANDED";
}

function clearRun(collapsePartitions) {
  offsets.fill(0);
  $("#ordering-broker").classList.remove("is-stored");
  $("#ordering-broker-state").textContent = partitionsAdded ? "TOPIC EXPANDED" : "CAPACITY PRESSURE";
  $("#ordering-producer-state").textContent = "READY";
  $("#producer-send-outcome").hidden = true;
  $("#dispute-outcome").classList.remove("is-invalid", "is-resolved");
  $("#dispute-outcome b").textContent = "NOT CREATED";
  $("#ordering-key-value").textContent = "(no key)";
  $("#ordering-key-note").textContent = "Two related events";
  $("#ordering-paths").replaceChildren();
  packet.style.opacity = "0";
  packet.style.display = "none";
  packet.classList.remove("is-returning");
  stage.querySelectorAll(".partition-row").forEach((row) => row.classList.remove("is-stored", "selected"));
  consumers.forEach((consumer) => consumer.classList.remove("is-receiving", "is-done", "is-blocked"));
  stage.querySelectorAll(".partition-count").forEach((count) => { count.textContent = "EMPTY"; });
  stage.querySelectorAll(".order-record").forEach((record) => { record.replaceChildren(); record.classList.remove("has-record"); });
  stage.querySelectorAll(".order-event-list > div").forEach((event) => event.classList.remove("is-sent"));
  $("#order-event-resolved").hidden = true;
  if (collapsePartitions) rows.querySelector('[data-order-partition="P1"]')?.remove();
  partitionsAdded = Boolean(rows.querySelector('[data-order-partition="P1"]'));
  $("#partition-count-state").textContent = partitionsAdded ? "2 PARTITIONS" : "1 PARTITION";
  $("#partition-broker-note").textContent = partitionsAdded ? "Two ordered logs · parallel work" : "One ordered log · P0";
  $("#partition-pressure").classList.remove("is-relieved");
  $("#partition-pressure").classList.toggle("is-balanced", partitionsAdded);
  $("#partition-consumption-note").hidden = true;
  $("#partition-load-state").textContent = partitionsAdded ? "MORE WRITE LANES AVAILABLE" : "ARRIVAL RATE > P0 LEADER THROUGHPUT";
  $(".pressure-meter i").style.width = partitionsAdded ? "30%" : "92%";
  consumers.forEach((consumer) => {
    $("[data-consumer-state]", consumer).textContent = "WAITING";
    $("[data-read-order]", consumer).replaceChildren(Object.assign(document.createElement("span"), { textContent: "Waiting for dispute events" }));
    consumer.classList.remove("is-blocked");
  });
  drawConnections();
}

async function next() {
  if (busy || step === 3) return;
  if (step === 0) {
    await addSecondPartition();
    return;
  }
  if (step === 1) {
    await showUnkeyedOrder();
    return;
  }
  await showKeyedOrder();
}

async function previous() {
  if (busy) return;
  if (step === 0) {
    window.location.href = "/recap";
    return;
  }
  const target = step - 1;
  clearRun(target === 0);
  step = target;
  $("#partition-playback-status").textContent = "READY TO EXPLAIN";
  if (target === 0) {
    explain("This illustrates incoming writes outpacing P0 leader throughput; the log is not full. In a real cluster, sustained pressure limits write throughput and can increase producer waiting or latency. What would you try?");
    await showInitialPressure();
  } else if (target === 1) {
    explain("P1 adds another log and gives the producer another write lane. The partitions have no shared order. Next, follow this dispute's two events.");
  } else {
    await showUnkeyedOrder();
  }
  updateControls();
}

async function reset() {
  if (busy) return;
  setPaused(false);
  clearRun(true);
  step = 0;
  $("#partition-playback-status").textContent = "READY TO EXPLAIN";
  explain("This illustrates incoming writes outpacing P0 leader throughput; the log is not full. In a real cluster, sustained pressure limits write throughput and can increase producer waiting or latency. What would you try?");
  updateControls();
  await showInitialPressure();
}

async function jumpToOrderingFlow(keyed) {
  if (busy) return;
  setPaused(false);
  clearRun(false);
  setBusy(true);
  await ensureTwoPartitions();
  setBusy(false);
  await (keyed ? showKeyedOrder() : showUnkeyedOrder());
}

$("#previous-partition-step").addEventListener("click", previous);
$("#next-partition-step").addEventListener("click", next);
$("#pause-ordering").addEventListener("click", () => setPaused(!paused));
$("#reset-ordering").addEventListener("click", reset);
$("#jump-unkeyed").addEventListener("click", () => jumpToOrderingFlow(false));
$("#jump-keyed").addEventListener("click", () => jumpToOrderingFlow(true));
speedControl.addEventListener("input", () => {
  speed = Number(speedControl.value);
  speedOutput.textContent = `${speed}×`;
  speedControl.setAttribute("aria-valuetext", `${speed} times speed`);
  activeAnimations.forEach((animation) => { animation.speed = speed; });
});
window.addEventListener("resize", () => requestAnimationFrame(drawConnections));
requestAnimationFrame(() => {
  packet.style.display = "none";
  drawConnections();
  updateControls();
  showInitialPressure();
});

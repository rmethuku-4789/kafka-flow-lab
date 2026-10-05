import { animate } from "motion";

const scenarioPath = "/recap";
if (window.location.pathname === "/") {
  window.history.replaceState(null, "", `${scenarioPath}${window.location.search}${window.location.hash}`);
}

const $ = (selector, root = document) => root.querySelector(selector);
const stage = $("#flow-stage");
const packet = $("#travel-packet");
const consumers = ["orders", "finance", "message"];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const flightDuration = reducedMotion ? 0.12 : 1.05;
const arrivalPause = flightDuration * 1000;
const speedControl = $("#recap-speed");
const speedOutput = $("#recap-speed-value");
let playbackRate = Number(speedControl.value);
document.documentElement.style.setProperty("--recap-processing-duration", `${arrivalPause / playbackRate}ms`);
let eventNumber = 1;
let nextOffset = 0;
let recordCount = 0;
let connectionRoutes = new Map();
let flowPaused = false;
const activeAnimations = new Set();
const activeDelays = new Set();

function animateFlow(...args) {
  const controls = animate(...args);
  controls.speed = playbackRate;
  activeAnimations.add(controls);
  controls.finished.then(
    () => activeAnimations.delete(controls),
    () => activeAnimations.delete(controls),
  );
  if (flowPaused) controls.pause();
  return controls;
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    let remaining = milliseconds;
    let startedAt = 0;
    let scheduledRate = playbackRate;
    let timer = null;
    let done = false;
    let delay;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== null) window.clearTimeout(timer);
      activeDelays.delete(delay);
      resolve();
    };
    const schedule = () => {
      if (done || flowPaused) return;
      if (remaining <= 0) return finish();
      scheduledRate = playbackRate;
      startedAt = performance.now();
      timer = window.setTimeout(() => {
        timer = null;
        remaining -= (performance.now() - startedAt) * scheduledRate;
        schedule();
      }, remaining / scheduledRate);
    };

    delay = {
      pause() {
        if (timer === null) return;
        window.clearTimeout(timer);
        timer = null;
        remaining -= (performance.now() - startedAt) * scheduledRate;
        if (remaining <= 0) finish();
      },
      setSpeed() {
        if (timer === null) return;
        window.clearTimeout(timer);
        timer = null;
        remaining -= (performance.now() - startedAt) * scheduledRate;
        schedule();
      },
      resume: schedule,
    };
    activeDelays.add(delay);
    schedule();
  });
}

function setFlowPaused(paused) {
  flowPaused = paused;
  document.body.classList.toggle("flow-paused", paused);
  if (paused) {
    activeAnimations.forEach((controls) => controls.pause());
    activeDelays.forEach((delay) => delay.pause());
  } else {
    activeAnimations.forEach((controls) => controls.play());
    activeDelays.forEach((delay) => delay.resume());
  }
  $("#flow-toggle").textContent = paused ? "Resume" : "Pause";
  $("#flow-toggle").setAttribute("aria-pressed", String(paused));
  $("#flow-status").textContent = paused ? "PAUSED" : "LIVE";
  $("#flow-indicator").classList.toggle("is-paused", paused);
}

function endpoint(element) {
  const stageRect = stage.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2 - stageRect.left, y: rect.top + rect.height / 2 - stageRect.top };
}

function fly(from, to, {
  delay = 0,
  clone = false,
  path = null,
  label = null,
  reverse = false,
  retainAtDestination = false,
  stopAtPathEnd = false,
} = {}) {
  const node = clone ? packet.cloneNode(true) : packet;
  if (clone) {
    node.removeAttribute("id");
    node.classList.add("flight-clone");
    stage.append(node);
  }
  if (label) {
    node.querySelector("b").textContent = label;
    node.classList.add("control-packet");
    node.dataset.kind = label === "ACK" || label === "COMMIT RESPONSE" ? "ack" : label === "FETCH" ? "fetch" : "commit";
  }
  const { width, height } = node.getBoundingClientRect();
  const start = endpoint(from);
  node.style.left = "0px";
  node.style.top = "0px";
  node.style.transform = `translateX(${start.x - width / 2}px) translateY(${start.y - height / 2}px)`;
  node.style.opacity = "1";
  const pathLength = path?.getTotalLength() ?? 0;
  const routeLength = Math.max(0, pathLength - (stopAtPathEnd ? 18 : 0));
  const routePoints = path
    ? Array.from({ length: 25 }, (_, index) => path.getPointAtLength(routeLength * index / 24))
    : [];
  if (reverse) routePoints.reverse();
  const points = path
    ? [start, ...routePoints, ...(stopAtPathEnd ? [] : [endpoint(to)])]
    : [start, endpoint(to)];
  const distances = points.map((point, index) => {
    if (index === 0) return 0;
    const previous = points[index - 1];
    return Math.hypot(point.x - previous.x, point.y - previous.y);
  });
  const totalDistance = distances.reduce((total, distance) => total + distance, 0);
  let traveledDistance = 0;
  const times = distances.map((distance, index) => {
    if (index > 0) traveledDistance += distance;
    return totalDistance > 0 ? traveledDistance / totalDistance : index / (distances.length - 1);
  });
  const movement = animateFlow(node, {
    x: points.map(({ x }) => x - width / 2),
    y: points.map(({ y }) => y - height / 2),
  }, { duration: flightDuration, delay, ease: "linear", times });
  return movement.finished.catch(() => {}).then(() => {
    if (retainAtDestination) return node;
    if (clone) node.remove();
    else node.style.opacity = "0";
    return null;
  });
}

async function commit(id, partition, offset) {
  const card = $(`#${id}-card`);
  const coordinator = $("#group-coordinator");
  const routes = connectionRoutes.get(partition);
  const flowPath = routes?.consumerFlows.get(id);
  $(`#${id}-delivery`).textContent = "COMMITTING";
  flowPath?.classList.add("is-active");
  const request = await fly(card, coordinator, { clone: true, path: flowPath, label: "COMMIT", reverse: true, retainAtDestination: true });
  await wait(arrivalPause);
  $("[data-offset-group=\"" + id + "\"]").textContent = "P" + partition + " · NEXT " + (offset + 1);
  request.remove();
  const response = await fly(coordinator, card, { clone: true, path: flowPath, label: "COMMIT RESPONSE", stopAtPathEnd: true, retainAtDestination: true });
  await wait(arrivalPause);
  response.remove();
  flowPath?.classList.remove("is-active");
  $(`#${id}-offset`).textContent = `P${partition} · NEXT ${offset + 1}`;
  $(`#${id}-delivery`).textContent = "COMMITTED";
  card.classList.remove("is-receiving");
  card.classList.add("is-committed");
  if (!reducedMotion) animateFlow(card, { scale: [1, 1.018, 1] }, { duration: 0.38, ease: "easeOut" });
}

async function deliverToConsumers(partition, offset, record) {
  $("#coordinator-status").textContent = "3 GROUPS FETCHING IN PARALLEL";
  activateConnections(partition, "consumers");
  const routes = connectionRoutes.get(partition)?.consumerFlows;
  const fetchPackets = await Promise.all(consumers.map(async (id) => {
    const card = $(`#${id}-card`);
    const consumerPath = routes?.get(id);
    $(`#${id}-delivery`).textContent = "FETCHING";
    return fly(card, record, { clone: true, path: consumerPath, label: "FETCH", reverse: true, retainAtDestination: true });
  }));
  $("#coordinator-status").textContent = "3 FETCH REQUESTS RECEIVED";
  fetchPackets.forEach((fetchPacket) => fetchPacket.remove());
  $("#coordinator-status").textContent = "3 GROUPS READING IN PARALLEL";
  consumers.forEach((id) => {
    $(`#${id}-delivery`).textContent = "READING";
  });
  const deliveredPackets = await Promise.all(consumers.map(async (id) => {
    const card = $(`#${id}-card`);
    const consumerPath = routes?.get(id);
    return fly(record, card, { clone: true, path: consumerPath, retainAtDestination: true, stopAtPathEnd: true });
  }));
  consumers.forEach((id) => {
    $(`#${id}-delivery`).textContent = "PROCESSING";
    $(`#${id}-card`).classList.add("is-receiving");
    $(`#${id}-card`).classList.add("is-processing");
  });
  $("#coordinator-status").textContent = "3 GROUPS PROCESSING IN PARALLEL";
  await wait(arrivalPause);
  consumers.forEach((id) => $(`#${id}-card`).classList.remove("is-processing"));
  deliveredPackets.forEach((deliveredPacket) => deliveredPacket.remove());
  routes?.forEach((consumerPath) => consumerPath.classList.remove("is-active"));
  $("#coordinator-status").textContent = "3 GROUPS COMMITTING IN PARALLEL";
  await Promise.all(consumers.map((id) => commit(id, partition, offset)));
  record.classList.add("is-committed");
  $("#coordinator-status").textContent = "3 COMMIT RESPONSES SENT";
}

async function appendRecord(track, offset, eventId) {
  const records = track.querySelectorAll(".log-record");
  if (records.length >= 5) {
    const oldest = records[0];
    const exit = animateFlow(oldest, { opacity: [1, 0], x: [0, -10], scale: [1, 0.75] }, { duration: 0.24, ease: "easeOut" });
    await exit.finished.catch(() => {});
    oldest.remove();
  }

  const record = document.createElement("span");
  record.className = "log-record";
  record.setAttribute("role", "listitem");
  record.setAttribute("aria-label", `Offset ${offset}, ${eventId}`);
  record.title = `Offset ${offset} · ${eventId}`;
  record.textContent = String(offset);
  track.append(record);

  const enter = animateFlow(record, { opacity: [0, 1], scale: [0.55, 1], y: [-5, 0] }, { duration: 0.3, ease: "easeOut" });
  await enter.finished.catch(() => {});
  return record;
}

async function publishNext() {
  const number = String(eventNumber).padStart(3, "0");
  const eventId = `evt-${number}`;
  const partition = 0;
  const partitionName = `P${partition}`;
  const offset = nextOffset;
  const recordTrack = $("#partition-track-p0");
  const routes = connectionRoutes.get(partition);

  document.querySelectorAll(".partition-row").forEach((row) => {
    row.classList.toggle("selected", row.dataset.partition === partitionName);
    row.classList.remove("is-stored");
  });
  $("#broker-card").classList.remove("is-stored");
  activateConnections(partition, "producer");

  $("#producer-status").textContent = "PUBLISHING";
  $("#coordinator-status").textContent = "WAITING FOR CONSUMERS";
  $("#travel-packet b").textContent = eventId;
  $("#broker-status").textContent = `ROUTING · ${partitionName}`;
  consumers.forEach((id) => {
    const card = $(`#${id}-card`);
    $(`#${id}-delivery`).textContent = "WAITING";
    card.classList.remove("is-receiving", "is-committed");
  });

  await fly($("#producer-card"), recordTrack, { path: routes?.producer });
  const record = await appendRecord(recordTrack, offset, eventId);
  recordCount += 1;
  $("#partition-count-p0").textContent = `${recordCount} ${recordCount === 1 ? "record" : "records"}`;
  $("#broker-status").textContent = `STORED · ${partitionName} · OFFSET ${offset}`;
  $("#producer-status").textContent = "PUBLISHED";
  $("#broker-card").classList.add("is-stored");
  $(`.partition-row[data-partition="${partitionName}"]`).classList.add("is-stored");
  activateConnections(partition, "stored");
  nextOffset = offset + 1;
  eventNumber += 1;
  if (!reducedMotion) animateFlow(record, { scale: [0.92, 1] }, { duration: 0.32, ease: "easeOut" });

  $("#producer-status").textContent = "WAITING FOR ACK";
  activateConnections(partition, "producer");
  const acknowledgement = await fly(record, $("#producer-card"), {
    clone: true,
    path: routes?.producer,
    label: "ACK",
    reverse: true,
    retainAtDestination: true,
  });
  acknowledgement.remove();
  $("#producer-status").textContent = "ACK RECEIVED";
  activateConnections(partition, "stored");

  await wait(arrivalPause);
  await deliverToConsumers(partition, offset, record);
  await wait(arrivalPause);
  void publishNext();
}

function drawConnections() {
  const svg = $("#connections");
  const group = $("#connection-paths");
  const bounds = stage.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  group.replaceChildren();
  const connect = (fromElement, toElement, className, targetPoint = null) => {
    const start = endpoint(fromElement);
    const end = targetPoint ?? endpoint(toElement);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const direction = horizontal ? Math.sign(dx) : Math.sign(dy);
    const fromRect = fromElement.getBoundingClientRect();
    const toRect = toElement.getBoundingClientRect();
    const from = horizontal
      ? { x: start.x + direction * fromRect.width / 2, y: start.y }
      : { x: start.x, y: start.y + direction * fromRect.height / 2 };
    const to = targetPoint ?? (horizontal
      ? { x: end.x - direction * toRect.width / 2, y: end.y }
      : { x: end.x, y: end.y - direction * toRect.height / 2 });
    const middle = horizontal ? (from.x + to.x) / 2 : (from.y + to.y) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", horizontal
      ? `M ${from.x} ${from.y} H ${middle} V ${to.y} H ${to.x}`
      : `M ${from.x} ${from.y} V ${middle} H ${to.x} V ${to.y}`);
    path.setAttribute("class", `connection-path ${className}`);
    path.setAttribute("marker-end", "url(#arrowhead)");
    group.append(path);
    return path;
  };

  const row = $(".partition-row[data-partition=\"P0\"]");
  const consumerFlows = new Map(consumers.map((id) => [
    id,
    connect(row, $(`#${id}-card`), `consumer-flow consumer-flow-${id}`),
  ]));
  const producerFlow = connect($(".producer-card .event-summary"), row, "producer-link");
  producerFlow.setAttribute("marker-start", "url(#arrowhead)");
  connectionRoutes = new Map([[0, { producer: producerFlow, consumerFlows }]]);
  consumerFlows.forEach((flowPath) => flowPath.setAttribute("marker-start", "url(#arrowhead)"));
}

function activateConnections(partition, direction, consumerId = null) {
  document.querySelectorAll(".connection-path.is-active").forEach((path) => path.classList.remove("is-active"));
  const routes = connectionRoutes.get(partition);
  const activePaths = direction === "producer"
    ? [routes?.producer]
    : direction === "consumers"
      ? consumerId ? [routes?.consumerFlows.get(consumerId)] : [...(routes?.consumerFlows.values() ?? [])]
      : [];
  activePaths.forEach((path) => path?.classList.add("is-active"));
}

window.addEventListener("resize", drawConnections);
$("#flow-toggle").addEventListener("click", () => setFlowPaused(!flowPaused));
$("#reset-recap").addEventListener("click", () => window.location.reload());
speedControl.addEventListener("input", () => {
  playbackRate = Number(speedControl.value);
  speedOutput.textContent = `${playbackRate}×`;
  document.documentElement.style.setProperty("--recap-processing-duration", `${arrivalPause / playbackRate}ms`);
  speedControl.setAttribute("aria-valuetext", `${playbackRate} times speed`);
  activeAnimations.forEach((controls) => { controls.speed = playbackRate; });
  activeDelays.forEach((delay) => delay.setSpeed());
});
requestAnimationFrame(() => {
  drawConnections();
  publishNext();
});

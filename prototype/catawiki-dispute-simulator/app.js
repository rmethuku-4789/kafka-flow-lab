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
let eventNumber = 1;
const partitionNextOffsets = [0, 0, 0];
const partitionRecordCounts = [0, 0, 0];
let connectionRoutes = new Map();
let flowPaused = false;
const activeAnimations = new Set();
const activeDelays = new Set();

function animateFlow(...args) {
  const controls = animate(...args);
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
      startedAt = performance.now();
      timer = window.setTimeout(() => {
        timer = null;
        remaining -= performance.now() - startedAt;
        schedule();
      }, remaining);
    };

    delay = {
      pause() {
        if (timer === null) return;
        window.clearTimeout(timer);
        timer = null;
        remaining -= performance.now() - startedAt;
        if (remaining <= 0) finish();
      },
      resume: schedule,
    };
    activeDelays.add(delay);
    schedule();
  });
}

function setFlowPaused(paused) {
  flowPaused = paused;
  if (paused) {
    activeAnimations.forEach((controls) => controls.pause());
    activeDelays.forEach((delay) => delay.pause());
  } else {
    activeAnimations.forEach((controls) => controls.play());
    activeDelays.forEach((delay) => delay.resume());
  }
  $("#flow-toggle").textContent = paused ? "Resume" : "Pause";
  $("#flow-toggle").setAttribute("aria-pressed", String(paused));
  $("#flow-status").textContent = paused ? "PAUSED FOR EXPLANATION" : "CONTINUOUS SIMULATION";
  $("#flow-indicator").classList.toggle("is-paused", paused);
}

function endpoint(element) {
  const stageRect = stage.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2 - stageRect.left, y: rect.top + rect.height / 2 - stageRect.top };
}

function fly(from, to, delay = 0, clone = false, path = null) {
  const node = clone ? packet.cloneNode(true) : packet;
  if (clone) {
    node.removeAttribute("id");
    node.classList.add("flight-clone");
    stage.append(node);
  }
  const { width, height } = node.getBoundingClientRect();
  node.style.left = "0px";
  node.style.top = "0px";
  node.style.opacity = "1";
  const points = path
    ? Array.from({ length: 25 }, (_, index) => path.getPointAtLength(path.getTotalLength() * index / 24))
    : [endpoint(from), endpoint(to)];
  const movement = animateFlow(node, {
    x: points.map(({ x }) => x - width / 2),
    y: points.map(({ y }) => y - height / 2),
    scale: [0.9, 1, 0.96],
  }, { duration: flightDuration, delay, ease: [0.22, 1, 0.36, 1] });
  return movement.finished.catch(() => {}).then(() => {
    if (clone) node.remove();
    else node.style.opacity = "0";
  });
}

async function commit(id, partition, offset, delay) {
  const card = $(`#${id}-card`);
  if (delay) await wait(delay);
  $(`#${id}-delivery`).textContent = "COMMITTING";
  await wait(reducedMotion ? 80 : 260);
  $(`#${id}-offset`).textContent = `P${partition} · NEXT ${offset + 1}`;
  $(`#${id}-delivery`).textContent = "COMMITTED";
  card.classList.remove("is-receiving");
  card.classList.add("is-committed");
  if (!reducedMotion) animateFlow(card, { scale: [1, 1.018, 1] }, { duration: 0.38, ease: "easeOut" });
}

async function deliverToConsumers(partition, offset, record, paths) {
  activateConnections(partition, "consumers");
  consumers.forEach((id) => $(`#${id}-delivery`).textContent = "READING");
  await Promise.all(consumers.map((id, index) => fly(record, $(`#${id}-card`), index * 0.18, true, paths[index])));
  consumers.forEach((id) => {
    $(`#${id}-delivery`).textContent = "READ";
    $(`#${id}-card`).classList.add("is-receiving");
  });
  await Promise.all(consumers.map((id, index) => commit(id, partition, offset, index * 180)));
}

async function publishNext() {
  const number = String(eventNumber).padStart(3, "0");
  const eventId = `evt-${number}`;
  const partition = (eventNumber - 1) % 3;
  const partitionName = `P${partition}`;
  const offset = partitionNextOffsets[partition];
  const record = $(`#record-slot-p${partition}`);
  const routes = connectionRoutes.get(partition);

  document.querySelectorAll(".partition-row").forEach((row) => {
    row.classList.toggle("selected", row.dataset.partition === partitionName);
    row.classList.remove("is-stored");
  });
  $("#broker-card").classList.remove("is-stored");
  activateConnections(partition, "producer");

  $("#producer-status").textContent = "PUBLISHING";
  $("#travel-packet b").textContent = eventId;
  $("#broker-status").textContent = `ROUTING · ${partitionName}`;
  consumers.forEach((id) => {
    const card = $(`#${id}-card`);
    $(`#${id}-delivery`).textContent = "WAITING";
    card.classList.remove("is-receiving", "is-committed");
  });

  await fly($("#producer-card"), record, 0, false, routes?.producer);
  $(".record-stamp", record).textContent = String(offset);
  $("i", record).textContent = eventId;
  record.classList.add("has-record");
  partitionRecordCounts[partition] += 1;
  $(`#partition-count-p${partition}`).textContent = `${partitionRecordCounts[partition]} ${partitionRecordCounts[partition] === 1 ? "record" : "records"}`;
  $("#broker-status").textContent = `STORED · ${partitionName} · OFFSET ${offset}`;
  $("#producer-status").textContent = "PUBLISHED";
  $("#broker-card").classList.add("is-stored");
  $(`.partition-row[data-partition="${partitionName}"]`).classList.add("is-stored");
  activateConnections(partition, "stored");
  partitionNextOffsets[partition] = offset + 1;
  eventNumber += 1;
  if (!reducedMotion) animateFlow(record, { scale: [0.92, 1] }, { duration: 0.32, ease: "easeOut" });

  await wait(reducedMotion ? 100 : 650);
  void deliverToConsumers(partition, offset, record, routes?.consumers ?? []);
  await wait(reducedMotion ? 900 : 2800);
  void publishNext();
}

function drawConnections() {
  const svg = $("#connections");
  const group = $("#connection-paths");
  const bounds = stage.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  group.replaceChildren();
  const connect = (fromElement, toElement, className) => {
    const start = endpoint(fromElement);
    const end = endpoint(toElement);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const direction = horizontal ? Math.sign(dx) : Math.sign(dy);
    const fromRect = fromElement.getBoundingClientRect();
    const toRect = toElement.getBoundingClientRect();
    const from = horizontal
      ? { x: start.x + direction * fromRect.width / 2, y: start.y }
      : { x: start.x, y: start.y + direction * fromRect.height / 2 };
    const to = horizontal
      ? { x: end.x - direction * toRect.width / 2, y: end.y }
      : { x: end.x, y: end.y - direction * toRect.height / 2 };
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

  connectionRoutes = new Map();
  for (let partition = 0; partition < 3; partition += 1) {
    const row = $(`.partition-row[data-partition="P${partition}"]`);
    connectionRoutes.set(partition, {
      producer: connect($("#producer-card"), row, "producer-link"),
      consumers: consumers.map((id) => connect(row, $(`#${id}-card`), "consumer-link")),
    });
  }
}

function activateConnections(partition, direction) {
  document.querySelectorAll(".connection-path.is-active").forEach((path) => path.classList.remove("is-active"));
  const routes = connectionRoutes.get(partition);
  const activePaths = direction === "producer" ? [routes?.producer] : direction === "consumers" ? routes?.consumers ?? [] : [];
  activePaths.forEach((path) => path?.classList.add("is-active"));
}

window.addEventListener("resize", drawConnections);
$("#flow-toggle").addEventListener("click", () => setFlowPaused(!flowPaused));
requestAnimationFrame(() => {
  drawConnections();
  publishNext();
});

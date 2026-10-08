import { displayRecordProgress } from "../../shared/scripts/record-progress.js";
import { createPlayback, PACKET_DURATION } from "../../shared/scripts/playback.js";
const $ = (selector, root = document) => root.querySelector(selector);
const field = $("#flow-field");
const routeLayer = $("#connection-paths");
const playbackControls = createPlayback();
const groups = [
  { id: "orders", card: $("#orders-card"), route: null, offset: 0 },
  { id: "finance", card: $("#finance-card"), route: null, offset: 0 },
  { id: "message", card: $("#message-card"), route: null, offset: 0 },
];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const flightDuration = playbackControls.duration(PACKET_DURATION);
const processingDuration = reduceMotion ? 120 : 1050;
let paused = document.hidden;
let nextOffset = 0;
let records = [];
let routes = { producer: null, consumers: [] };
const activeAnimations = new Set();
const activeFlights = new Set();
let packetLabelFrame = null;

function arrangePacketLabels() {
  const fieldRect = field.getBoundingClientRect();
  for (const { packet, key } of activeFlights) {
    const left = (key === "producer" ? $("#producer-card") : $("#cluster-card")).getBoundingClientRect().right - fieldRect.left;
    const right = (key === "producer" ? $("#cluster-card") : groups[0].card).getBoundingClientRect().left - fieldRect.left;
    const label = $("small", packet);
    label.style.maxWidth = `${right - left - 6}px`;
    const box = packet.getBoundingClientRect();
    const center = box.left + box.width / 2 - fieldRect.left;
    const half = label.getBoundingClientRect().width / 2;
    const desired = Math.max(left + half + 3, Math.min(right - half - 3, center));
    label.style.left = `${desired - center + packet.offsetWidth / 2}px`;
  }
  packetLabelFrame = activeFlights.size ? requestAnimationFrame(arrangePacketLabels) : null;
}

function addAnimation(animation) {
  playbackControls.track(animation, "playbackRate");
  activeAnimations.add(animation);
  animation.finished.then(
    () => activeAnimations.delete(animation),
    () => activeAnimations.delete(animation),
  );
  return animation;
}

const wait = milliseconds => playbackControls.wait(milliseconds);
playbackControls.subscribe(({paused: value}) => {
  paused = value;
  $("#flow-state").classList.toggle("is-paused", paused);
  $("#flow-state span").textContent = document.hidden ? "PAUSED · tab hidden" : paused ? "PAUSED" : "LIVE";
});

function position(element, edge, gap = 0, yOffset = 0) {
  const rect = element.getBoundingClientRect();
  const fieldRect = field.getBoundingClientRect();
  const x = rect.left - fieldRect.left;
  const y = rect.top - fieldRect.top;
  if (edge === "right") return { x: x + rect.width + gap, y: y + rect.height / 2 + yOffset };
  if (edge === "left") return { x: x - gap, y: y + rect.height / 2 + yOffset };
  if (edge === "top") return { x: x + rect.width / 2, y: y - gap };
  return { x: x + rect.width / 2, y: y + rect.height + gap };
}

function compactPoints(points) {
  return points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
}

function makeRoute(points, className) {
  points = compactPoints(points);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("class", `connection-path ${className}`);
  path.setAttribute("d", points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" "));
  routeLayer.append(path);
  return { path, points };
}

function drawRoutes() {
  const bounds = field.getBoundingClientRect();
  $("#connections").setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  routeLayer.replaceChildren();
  const brokerRect = $("#cluster-card").getBoundingClientRect();
  const coordinatorRect = $("#coordinator").getBoundingClientRect();
  const fieldRect = field.getBoundingClientRect();
  const brokerRight = brokerRect.right - fieldRect.left;
  const consumerLeft = groups[0].card.getBoundingClientRect().left - fieldRect.left;
  const spineX = (brokerRight + consumerLeft) / 2;
  const coordinatorCenterY = coordinatorRect.top - fieldRect.top + coordinatorRect.height / 2;
  routes.producer = makeRoute([
    position($("#producer-card"), "right", 8),
    position($("#cluster-card"), "left", 8),
  ], "producer-route");
  routes.producer.key = "producer";
  const consumerCenters = groups.map((group) => position(group.card, "left", 8));
  const brokerCenterY = position($("#cluster-card"), "right").y;
  const firstConsumerY = consumerCenters[0].y;
  const lastConsumerY = consumerCenters.at(-1).y;
  routes.brokerTrunk = makeRoute([
    position($("#cluster-card"), "right", 8),
    { x: spineX, y: brokerCenterY },
  ], "consumer-route");
  routes.coordinatorTrunk = makeRoute([
    position($("#coordinator"), "right", 8),
    { x: spineX, y: coordinatorCenterY },
  ], "commit-route");
  routes.consumerSpine = makeRoute([
    { x: spineX, y: firstConsumerY },
    { x: spineX, y: lastConsumerY },
  ], "consumer-spine");
  routes.consumerBranches = groups.map((group, index) => makeRoute([
    { x: spineX, y: consumerCenters[index].y },
    consumerCenters[index],
  ], `consumer-route consumer-route-${group.id}`));
  routes.consumers = groups.map((group, index) => {
    const y = consumerCenters[index].y;
    group.route = {
      key: group.id,
      points: [
        position($("#cluster-card"), "right", 8),
        { x: spineX, y: brokerCenterY },
        { x: spineX, y },
        consumerCenters[index],
      ],
      paths: [routes.brokerTrunk, routes.consumerSpine, routes.consumerBranches[index]],
    };
    group.commitRoute = {
      key: `${group.id}-commit`,
      points: [
        consumerCenters[index],
        { x: spineX, y },
        { x: spineX, y: coordinatorCenterY },
        position($("#coordinator"), "right", 8),
      ],
      paths: [routes.coordinatorTrunk, routes.consumerSpine, routes.consumerBranches[index]],
    };
    return group.route;
  });
  activeFlights.forEach(({ animation, packet, key, reverse }) => {
    const route = key === "producer" ? routes.producer : groups.find(group => key.startsWith(group.id))[key.endsWith("-commit") ? "commitRoute" : "route"];
    animation.effect.setKeyframes(packetFrames(route, packet, reverse));
  });
}

function activateRoutes(activeRoutes, type = "record") {
  document.querySelectorAll(".connection-path.is-active, .connection-path.is-control-active").forEach((path) => {
    path.classList.remove("is-active", "is-control-active");
  });
  activeRoutes.flatMap((route) => route?.paths ?? [route]).forEach((route) => {
    route?.path.classList.add(type === "control" ? "is-control-active" : "is-active");
  });
}

function addPacket(label, type) {
  const packet = document.createElement("span");
  packet.className = `packet packet--${type}`;
  packet.setAttribute("aria-hidden", "true");
  packet.innerHTML = `<i></i><small>${label}</small>`;
  field.append(packet);
  return packet;
}

function packetFrames(route, packet, reverse) {
  const points = reverse ? [...route.points].reverse() : route.points;
  const halfWidth = packet.offsetWidth / 2;
  const halfHeight = packet.offsetHeight / 2;
  return points.map((point, index) => ({
    transform: `translate(${point.x - halfWidth}px, ${point.y - halfHeight}px)`,
    offset: points.length > 1 ? index / (points.length - 1) : 1,
  }));
}

async function fly(route, label, reverse = false, type = "record") {
  const packet = addPacket(label, type);
  const animation = addAnimation(packet.animate(packetFrames(route, packet, reverse), { duration: flightDuration, easing: "linear", fill: "forwards" }));
  const flight = { animation, packet, key: route.key, reverse };
  activeFlights.add(flight);
  if (packetLabelFrame === null) packetLabelFrame = requestAnimationFrame(arrangePacketLabels);
  try {
    await animation.finished;
  } finally {
    activeFlights.delete(flight);
    packet.remove();
  }
}

function updateRecords(offset) {
  if (offset !== undefined) { records.push(offset); records = records.slice(-5); }
  const window = $("#record-window");
  window.replaceChildren(...records.map((record, index) => {
    const dot = document.createElement("span");
    dot.className = "record-dot";
    displayRecordProgress(dot, { partition: 0, offset: record }, { scope: window, playback: playbackControls, groups: groups.map(group => group.id), nextByGroup: Object.fromEntries(groups.map(group => [group.id, [group.acknowledged ?? 0]])) });
    dot.textContent = String(record);
    dot.setAttribute("aria-label", `Record offset ${record}`);
    return dot;
  }));
  $("#record-count").textContent = `${(records.at(-1) ?? -1) + 1} ${records.at(-1) === 0 ? "record" : "records"}`;
}

function setConsumerState(group, state) {
  $(`#${group.id}-status`).textContent = state;
  group.card.classList.toggle("is-receiving", ["POLLING", "READING", "PROCESSING"].includes(state));
  group.card.classList.toggle("is-processing", state === "PROCESSING");
  group.card.classList.toggle("is-committed", state === "COMMITTED");
}

function runProgress(group) {
  const fill = $(".progress-fill", group.card);
  const thumb = $(".progress-thumb", group.card);
  const fillAnimation = addAnimation(fill.animate(
    [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
    { duration: processingDuration, easing: "linear", fill: "forwards" },
  ));
  const thumbAnimation = addAnimation(thumb.animate(
    [{ left: "0px" }, { left: "calc(100% - 14px)" }],
    { duration: processingDuration, easing: "linear", fill: "forwards" },
  ));
  return [fillAnimation, thumbAnimation];
}

function clearProgress(animations) {
  animations.forEach((animation) => {
    activeAnimations.delete(animation);
    animation.cancel();
  });
  groups.forEach((group) => group.card.classList.remove("is-processing"));
}

async function publish(offset) {
  $("#producer-status").textContent = "SENDING";
  $("#broker-status").textContent = "RECEIVING RECORD";
  activateRoutes([routes.producer]);
  await fly(routes.producer, "RECORD", false, "record");
  updateRecords(offset);
  $("#broker-status").textContent = `STORED · P0 · OFFSET ${offset}`;
  $("#producer-status").textContent = "WAITING FOR ACK";
  activateRoutes([routes.producer], "control");
  await fly(routes.producer, "ACK · acks=all", true, "control");
  $("#producer-status").textContent = "ACK RECEIVED";
  await wait(300);
}

async function deliverAndProcess(offset) {
  $("#coordinator-status").textContent = "3 GROUPS POLLING IN PARALLEL";
  groups.forEach((group) => setConsumerState(group, "POLLING"));
  activateRoutes(routes.consumers, "control");
  await Promise.all(groups.map((group) => fly(group.route, "POLL", true, "control")));
  $("#coordinator-status").textContent = "3 POLL REQUESTS RECEIVED";
  groups.forEach((group) => setConsumerState(group, "READING"));
  activateRoutes(routes.consumers);
  await Promise.all(groups.map((group) => fly(group.route, "RECORD", false, "record")));
  groups.forEach((group) => setConsumerState(group, "PROCESSING"));
  $("#coordinator-status").textContent = "3 GROUPS PROCESSING IN PARALLEL";
  const progressAnimations = groups.flatMap(runProgress);
  await wait(processingDuration);
  clearProgress(progressAnimations);
  await commitOffsets(offset);
}

async function commitOffsets(offset) {
  $("#coordinator-status").textContent = "3 GROUPS COMMITTING IN PARALLEL";
  groups.forEach((group) => setConsumerState(group, "COMMITTING"));
  activateRoutes(groups.map((group) => group.commitRoute), "control");
  await Promise.all(groups.map(async (group) => {
    await fly(group.commitRoute, "COMMIT", false, "control");
    group.offset = offset + 1;
    $(`#${group.id}-group-offset`).textContent = `P0 · NEXT ${group.offset}`;
    $("#coordinator-status").textContent = "OFFSETS STORED · SENDING RESPONSES";
    await fly(group.commitRoute, "COMMIT ACK", true, "control");
    $(`#${group.id}-next`).textContent = `P0 · NEXT ${group.offset}`;
    group.acknowledged = group.offset;
    updateRecords();
    setConsumerState(group, "COMMITTED");
  }));
  $("#coordinator-status").textContent = "3 COMMIT RESPONSES SENT";
  $("#prompt-label").textContent = "THE KAFKA WAY";
  $("#scene-prompt").textContent = "Simplified: one poll and one commit per record. Real consumers poll batches and may commit less often.";
}

async function runFlow() {
  while (true) {
    const offset = nextOffset++;
    await publish(offset);
    await deliverAndProcess(offset);
    await wait(450);
  }
}

$("#reset-button").addEventListener("click", () => window.location.reload());
$("#scenario-select").addEventListener("change", (event) => { window.location.href = event.target.value; });
window.addEventListener("resize", drawRoutes);
new ResizeObserver(drawRoutes).observe(field);

requestAnimationFrame(() => {
  drawRoutes();
  runFlow().catch((error) => {
    console.error("Recap flow stopped", error);
    $("#coordinator-status").textContent = "FLOW ERROR · RESET TO RESTART";
  });
});

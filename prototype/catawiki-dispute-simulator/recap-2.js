const $ = (selector, root = document) => root.querySelector(selector);
const field = $("#flow-field");
const routeLayer = $("#connection-paths");
const speedControl = $("#speed-control");
const groups = [
  { id: "orders", card: $("#orders-card"), route: null, offset: 0 },
  { id: "finance", card: $("#finance-card"), route: null, offset: 0 },
  { id: "message", card: $("#message-card"), route: null, offset: 0 },
];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const flightDuration = reduceMotion ? 120 : 920;
const processingDuration = reduceMotion ? 120 : 1050;
let speed = Number(speedControl.value);
let paused = false;
let nextOffset = 0;
let records = [];
let routes = { producer: null, consumers: [] };
const activeAnimations = new Set();
const activeDelays = new Set();

function addAnimation(animation) {
  animation.playbackRate = speed;
  if (paused) animation.pause();
  activeAnimations.add(animation);
  animation.finished.then(
    () => activeAnimations.delete(animation),
    () => activeAnimations.delete(animation),
  );
  return animation;
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    let remaining = milliseconds;
    let startedAt = 0;
    let scheduledSpeed = speed;
    let timer = null;
    let done = false;
    let delay;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      activeDelays.delete(delay);
      resolve();
    };
    const schedule = () => {
      if (done || paused) return;
      if (remaining <= 0) return finish();
      scheduledSpeed = speed;
      startedAt = performance.now();
      timer = setTimeout(() => {
        timer = null;
        remaining -= (performance.now() - startedAt) * scheduledSpeed;
        schedule();
      }, remaining / scheduledSpeed);
    };

    delay = {
      pause() {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
        remaining -= (performance.now() - startedAt) * scheduledSpeed;
        if (remaining <= 0) finish();
      },
      setSpeed() {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
        remaining -= (performance.now() - startedAt) * scheduledSpeed;
        schedule();
      },
      resume: schedule,
    };
    activeDelays.add(delay);
    schedule();
  });
}

function setPaused(value) {
  paused = value;
  if (paused) {
    activeAnimations.forEach((animation) => animation.pause());
    activeDelays.forEach((delay) => delay.pause());
  } else {
    activeAnimations.forEach((animation) => animation.play());
    activeDelays.forEach((delay) => delay.resume());
  }
  $("#pause-button").textContent = paused ? "Resume" : "Ⅱ Pause";
  $("#pause-button").setAttribute("aria-pressed", String(paused));
  $("#flow-state").classList.toggle("is-paused", paused);
  $("#flow-state span").textContent = paused ? "PAUSED" : "LIVE";
}

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
      points: [
        position($("#cluster-card"), "right", 8),
        { x: spineX, y: brokerCenterY },
        { x: spineX, y },
        consumerCenters[index],
      ],
      paths: [routes.brokerTrunk, routes.consumerSpine, routes.consumerBranches[index]],
    };
    group.commitRoute = {
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

async function fly(route, label, reverse = false, type = "record") {
  const points = reverse ? [...route.points].reverse() : route.points;
  const packet = addPacket(label, type);
  const halfWidth = packet.offsetWidth / 2;
  const halfHeight = packet.offsetHeight / 2;
  const keyframes = points.map((point, index) => ({
    transform: `translate(${point.x - halfWidth}px, ${point.y - halfHeight}px)`,
    offset: points.length > 1 ? index / (points.length - 1) : 1,
  }));
  const animation = addAnimation(packet.animate(keyframes, { duration: flightDuration, easing: "linear", fill: "forwards" }));
  try {
    await animation.finished;
  } finally {
    packet.remove();
  }
}

function updateRecords(offset) {
  records.push(offset);
  records = records.slice(-5);
  const window = $("#record-window");
  window.replaceChildren(...records.map((record, index) => {
    const dot = document.createElement("span");
    dot.className = `record-dot${index === records.length - 1 ? " is-latest" : ""}`;
    dot.textContent = String(record);
    dot.setAttribute("aria-label", `Record offset ${record}`);
    return dot;
  }));
  $("#record-count").textContent = `${offset + 1} ${offset === 0 ? "record" : "records"}`;
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
  await fly(routes.producer, "PRODUCER ACK", true, "control");
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
    setConsumerState(group, "COMMITTED");
  }));
  $("#coordinator-status").textContent = "3 COMMIT RESPONSES SENT";
}

async function runFlow() {
  while (true) {
    const offset = nextOffset++;
    await publish(offset);
    await deliverAndProcess(offset);
    await wait(450);
  }
}

$("#pause-button").addEventListener("click", () => setPaused(!paused));
$("#reset-button").addEventListener("click", () => window.location.reload());
$("#scenario-select").addEventListener("change", (event) => { window.location.href = event.target.value; });
speedControl.addEventListener("input", () => {
  speed = Number(speedControl.value);
  $("#speed-output").value = `${speed.toFixed(2).replace(/0$/, "")}×`;
  speedControl.setAttribute("aria-valuetext", `${speed} times speed`);
  activeAnimations.forEach((animation) => { animation.playbackRate = speed; });
  activeDelays.forEach((delay) => delay.setSpeed());
});
window.addEventListener("resize", drawRoutes);
new ResizeObserver(drawRoutes).observe(field);

requestAnimationFrame(() => {
  drawRoutes();
  runFlow().catch((error) => {
    console.error("Recap 2 flow stopped", error);
    $("#coordinator-status").textContent = "FLOW ERROR · RESET TO RESTART";
  });
});

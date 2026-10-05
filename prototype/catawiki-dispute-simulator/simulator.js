import { animate } from "motion";

const stage = document.querySelector("#lesson-flow");
const paths = document.querySelector("#lesson-paths");
const packet = document.querySelector("#lesson-packet");
const producer = document.querySelector("#lesson-producer");
const broker = document.querySelector("#lesson-broker");
const partition = document.querySelector("#lesson-partition");
const record = document.querySelector("#lesson-record");
const consumers = [...document.querySelectorAll("[data-lesson-consumer]")];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const speedControl = document.querySelector("#animation-speed");
const speedOutput = document.querySelector("#animation-speed-value");
const pauseControl = document.querySelector("#lesson-pause");
const flowStatus = document.querySelector("#lesson-flow-status");
const flowIndicator = pauseControl.nextElementSibling;
const activeAnimations = new Set();
const pauseWaiters = new Set();
const visibleRecordLimit = 3;
let playbackRate = Number(speedControl.value);
let flowPaused = false;

function setFlowPaused(paused) {
  flowPaused = paused;
  activeAnimations.forEach((animation) => paused ? animation.pause() : animation.play());
  pauseControl.textContent = paused ? "▶ Resume" : "Ⅱ Pause";
  pauseControl.setAttribute("aria-pressed", String(paused));
  flowStatus.textContent = paused ? "PAUSED · EXPLAIN" : "CONTINUOUS FLOW";
  flowIndicator.classList.toggle("is-paused", paused);
  if (!paused) {
    pauseWaiters.forEach((resume) => resume());
    pauseWaiters.clear();
  }
}

pauseControl.addEventListener("click", () => setFlowPaused(!flowPaused));

speedControl.addEventListener("input", () => {
  playbackRate = Number(speedControl.value);
  speedOutput.textContent = `${playbackRate}×`;
  speedControl.setAttribute("aria-valuetext", `${playbackRate} times speed`);
  activeAnimations.forEach((animation) => { animation.speed = playbackRate; });
});

let eventNumber = 0;
let nextOffset = 0;

function center(element) {
  const box = element.getBoundingClientRect();
  const bounds = stage.getBoundingClientRect();
  return { x: box.left + box.width / 2 - bounds.left, y: box.top + box.height / 2 - bounds.top };
}

function drawConnections() {
  const from = center(producer);
  const to = center(broker);
  const fork = center(partition);
  const coordinator = center(document.querySelector("#lesson-offset-log"));
  from.x += producer.getBoundingClientRect().width / 2;
  to.x -= broker.getBoundingClientRect().width / 2;
  fork.x = broker.getBoundingClientRect().right - stage.getBoundingClientRect().left;
  coordinator.x = fork.x;
  paths.replaceChildren();
  const routes = [
    [from, to],
    ...consumers.map((consumer) => [fork, { ...center(consumer), x: consumer.getBoundingClientRect().left - stage.getBoundingClientRect().left }]),
    ...consumers.map((consumer) => [coordinator, { ...center(consumer), x: consumer.getBoundingClientRect().left - stage.getBoundingClientRect().left }]),
  ];
  routes.forEach(([start, end], index) => {
    const lane = index === 0 ? 0.5 : index >= 4 ? 0.35 + (index - 4) * 0.2 : 0.25 + (index - 1) * 0.2;
    const middle = start.x + (end.x - start.x) * lane;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${start.x} ${start.y} H ${middle} V ${end.y} H ${end.x}`);
    if (index >= 4) path.classList.add("is-commit-route");
    path.dataset.route = String(index);
    paths.append(path);
  });
}

function routePath(index) {
  return paths.querySelector(`[data-route="${index}"]`);
}

function animateRecord(node, keyframes, duration) {
  const animation = animate(node, keyframes, { duration, ease: "easeOut" });
  animation.speed = playbackRate;
  activeAnimations.add(animation);
  if (flowPaused) animation.pause();
  return animation.finished.finally(() => activeAnimations.delete(animation));
}

function flight(from, to, index, title, detail, reverse = false, duration = 2.4) {
  const node = packet.cloneNode(true);
  node.removeAttribute("id");
  node.querySelector("b").textContent = title;
  node.dataset.kind = title === "OffsetCommit" ? "commit" : title.includes("ACK") ? "ack" : "event";
  node.querySelector("small").textContent = detail;
  stage.append(node);
  const path = routePath(index);
  const start = center(from);
  const end = center(to);
  const points = path && !reducedMotion
    ? Array.from({ length: 30 }, (_, point) => path.getPointAtLength(path.getTotalLength() * point / 29))
    : [start, end];
  if (reverse && path && !reducedMotion) points.reverse();
  node.style.opacity = "1";
  path?.classList.add("is-active");
  if (path) {
    path.dataset.direction = reverse ? "reverse" : "forward";
    path.dataset.kind = node.dataset.kind;
  }
  const animation = animate(node, {
    x: points.map(({ x }) => x - node.offsetWidth / 2),
    y: points.map(({ y }) => y - node.offsetHeight / 2),
  }, { duration: reducedMotion ? 0.01 : duration, ease: "linear" });
  animation.speed = playbackRate;
  activeAnimations.add(animation);
  if (flowPaused) animation.pause();
  return animation.finished.finally(() => {
    activeAnimations.delete(animation);
    node.remove();
    path?.classList.remove("is-active");
    if (path) {
      delete path.dataset.direction;
      delete path.dataset.kind;
    }
  });
}

function wait(duration) {
  return new Promise((resolve) => {
    const targetDuration = reducedMotion ? 80 : duration;
    let elapsed = 0;
    let previousTime;
    const advance = (time) => {
      if (flowPaused) {
        pauseWaiters.add(() => {
          previousTime = undefined;
          requestAnimationFrame(advance);
        });
        return;
      }
      if (previousTime !== undefined) elapsed += (time - previousTime) * playbackRate;
      previousTime = time;
      if (elapsed >= targetDuration) resolve();
      else requestAnimationFrame(advance);
    };
    requestAnimationFrame(advance);
  });
}

async function publish() {
  eventNumber += 1;
  const eventId = `evt-${String(eventNumber).padStart(3, "0")}`;
  const offset = nextOffset++;
  producer.classList.add("is-publishing");
  document.querySelector("#lesson-producer-status").textContent = "PUBLISHING";
  document.querySelector("#lesson-broker-status").textContent = "ROUTING · P0";
  partition.classList.remove("is-stored");
  broker.classList.remove("is-stored");
  consumers.forEach((consumer) => {
    consumer.classList.remove("is-receiving", "is-done");
    consumer.querySelector(".delivery-indicator").textContent = "WAITING";
    consumer.querySelector("[data-lesson-result]").textContent = "Ready for event";
  });

  await flight(producer, broker, 0, "DisputeCreated", eventId);
  document.querySelector("#lesson-producer-status").textContent = "PUBLISHED";
  document.querySelector("#lesson-broker-status").textContent = `STORED · P0 · OFFSET ${offset}`;
  document.querySelector("#lesson-record-count").textContent = `${offset + 1} ${offset ? "records" : "record"}`;
  if (record.children.length >= visibleRecordLimit) {
    const oldestRecord = record.firstElementChild;
    await animateRecord(oldestRecord, { opacity: [1, 0], x: [0, -8], scale: [1, 0.9] }, 0.3);
    oldestRecord.remove();
  }
  const message = document.createElement("span");
  message.className = "lesson-record-message";
  const stamp = document.createElement("span");
  stamp.className = "record-stamp";
  stamp.textContent = String(offset);
  const label = document.createElement("b");
  label.textContent = eventId;
  message.append(stamp, label);
  record.append(message);
  await animateRecord(message, { opacity: [0, 1], x: [8, 0], scale: [0.9, 1] }, 0.35);
  producer.classList.remove("is-publishing");
  partition.classList.add("is-stored");
  broker.classList.add("is-stored");
  await wait(1200);

  await Promise.all(consumers.map(async (consumer, index) => {
    consumer.classList.add("is-receiving");
    consumer.querySelector(".delivery-indicator").textContent = "RECEIVING";
    await flight(partition, consumer, index + 1, "DisputeCreated", eventId);
    consumer.classList.remove("is-receiving");
    consumer.classList.add("is-done");
    consumer.querySelector(".delivery-indicator").textContent = "PROCESSED";
    consumer.querySelector("[data-lesson-result]").textContent = `Processed ${eventId}`;
    await wait(900);
  }));

  for (const [index, consumer] of consumers.entries()) {
    consumer.querySelector(".delivery-indicator").textContent = "COMMITTING";
    document.querySelector("#lesson-coordinator-status").textContent = "OFFSET COMMIT REQUEST";
    const offsetLog = document.querySelector("#lesson-offset-log");
    offsetLog.classList.add("is-writing");
    const nextOffset = offset + 1;
    const commitRoute = index + 4;
    await flight(consumer, offsetLog, commitRoute, "OffsetCommit", `${consumer.dataset.lessonConsumer} · P0:${nextOffset}`, true, 1.8);
    const storedOffset = document.querySelector(`[data-commit-group="${consumer.dataset.lessonConsumer}"] b`);
    storedOffset.textContent = `P0:${nextOffset}`;
    storedOffset.closest("[data-commit-group]").classList.add("is-written");
    document.querySelector("#lesson-coordinator-status").textContent = "OFFSET STORED";
    await flight(offsetLog, consumer, commitRoute, "Commit ACK", `next ${nextOffset}`, false, 1.8);
    offsetLog.classList.remove("is-writing");
    consumer.querySelector(".delivery-indicator").textContent = "COMMITTED";
    consumer.querySelector("[data-lesson-offset]").textContent = String(nextOffset);
  }
  document.querySelector("#lesson-coordinator-status").textContent = "READY · 3 GROUPS";
  await wait(4500);
}

async function run() {
  drawConnections();
  while (true) {
    await publish();
  }
}

new ResizeObserver(drawConnections).observe(stage);
run();

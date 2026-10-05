import { animate } from "motion";

const $ = (selector, root = document) => root.querySelector(selector);
const stage = $("#durability-stage");
const packet = $("#durability-packet");
const paths = $("#durability-paths");
const brokers = [0, 1, 2].map((index) => ({ up: true, inISR: true, records: 0, element: $(`#durability-broker-${index}`) }));
const minISR = 2;
const activeAnimations = new Set();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let speed = 1;
let leader = 0;
let nextOffset = 0;
let running = false;
let paused = false;
let writing = false;
let electionPending = false;
let failoverCompleted = false;
let epoch = 0;
let resumeWaiters = [];

function explain(html) {
  $("#durability-explanation p").innerHTML = html;
}

function currentISR() {
  return brokers.filter((broker) => broker.inISR && broker.up).length;
}

function setConsumers(state) {
  document.querySelectorAll("[data-durability-consumer]").forEach((card) => {
    const group = card.dataset.durabilityConsumer;
    card.classList.toggle("is-reading", state === "READING P0");
    card.classList.toggle("is-waiting", state === "WAITING FOR LEADER");
    $(`[data-durability-state="${group}"]`).textContent = state;
  });
}

function setPaused(value) {
  paused = value;
  activeAnimations.forEach((animation) => value ? animation.pause() : animation.play());
  $("#pause-durability").textContent = value ? "▶ Resume" : "Ⅱ Pause";
  $("#pause-durability").setAttribute("aria-pressed", String(value));
  if (!value) resumeWaiters.splice(0).forEach((resume) => resume());
}

async function wait(milliseconds, run) {
  let remaining = milliseconds;
  while (remaining > 0 && running && run === epoch) {
    if (paused) {
      await new Promise((resume) => resumeWaiters.push(resume));
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

function connect(from, to, style = "") {
  const a = center(from);
  const b = center(to);
  const fromRect = from.getBoundingClientRect();
  const toRect = to.getBoundingClientRect();
  const dir = Math.sign(b.x - a.x) || 1;
  const startX = a.x + dir * fromRect.width / 2;
  const endX = b.x - dir * toRect.width / 2;
  const bendX = (startX + endX) / 2;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M ${startX} ${a.y} H ${bendX} V ${b.y} H ${endX}`);
  path.setAttribute("class", `durability-path is-active ${style}`.trim());
  path.setAttribute("marker-end", "url(#durability-arrow)");
  paths.append(path);
  return path;
}

async function fly(from, to, label, detail, run, style = "") {
  if (!running || run !== epoch) return;
  const path = connect(from, to, style);
  const moving = packet.cloneNode(true);
  moving.removeAttribute("id");
  moving.style.display = "flex";
  moving.style.opacity = "1";
  moving.querySelector("b").textContent = label;
  moving.dataset.kind = label.includes("ACK") ? "ack" : label.includes("fail") ? "error" : "event";
  path.dataset.kind = moving.dataset.kind;
  moving.querySelector("small").textContent = detail;
  stage.append(moving);
  const rect = moving.getBoundingClientRect();
  const length = path.getTotalLength();
  const points = Array.from({ length: 20 }, (_, index) => path.getPointAtLength(length * index / 19));
  const animation = animate(moving, {
    x: points.map(({ x }) => x - rect.width / 2),
    y: points.map(({ y }) => y - rect.height / 2),
    scale: [0.94, 1],
  }, { duration: (reducedMotion ? 0.16 : 0.82) / speed, ease: [0.22, 1, 0.36, 1] });
  activeAnimations.add(animation);
  if (paused) animation.pause();
  await animation.finished.catch(() => {});
  activeAnimations.delete(animation);
  moving.remove();
  path.remove();
}

function setWriteState(state, text) {
  const node = $("#durability-write-state");
  node.classList.remove("is-writing", "is-acked", "is-rejected");
  if (state) node.classList.add(`is-${state}`);
  $("#durability-write-state b").textContent = text;
}

function appendRecord(brokerIndex, offset) {
  const node = document.createElement("span");
  node.className = `replica-record${offset === nextOffset ? " is-latest" : ""}`;
  node.textContent = String(offset + 1);
  node.title = `Offset ${offset}`;
  const strip = $(".replica-records", brokers[brokerIndex].element);
  strip.append(node);
  while (strip.children.length > 8) strip.firstElementChild.remove();
  brokers[brokerIndex].records += 1;
}

function renderBrokers(promoted = -1) {
  brokers.forEach((broker, index) => {
    const card = broker.element;
    card.classList.toggle("is-leader", broker.up && index === leader);
    card.classList.toggle("is-down", !broker.up);
    card.classList.toggle("is-promoting", index === promoted);
    const role = $(".broker-role", card);
    const health = $(".broker-health span", card);
    if (!broker.up) {
      role.textContent = "OFFLINE";
      health.textContent = "BROKER DOWN";
    } else if (index === leader) {
      role.textContent = "LEADER";
      health.textContent = "IN SYNC · LEADER";
    } else {
      role.textContent = "FOLLOWER";
      health.textContent = broker.inISR ? "IN SYNC" : "CATCHING UP";
    }
    card.setAttribute("aria-label", `Broker ${index + 1}, partition 0 ${!broker.up ? "offline" : index === leader ? "leader" : "follower"}`);
  });
  const isr = currentISR();
  $("#durability-isr").textContent = `ISR · ${isr} / 3`;
  $("#durability-isr").classList.toggle("is-waiting", isr < minISR);
  $("#durability-broker-state").textContent = electionPending ? "ELECTING LEADER" : isr < minISR ? "WRITES BLOCKED" : `LEADER · B${leader + 1}`;
  $("#durability-cluster-note").textContent = electionPending ? "P0 briefly unavailable during election" : isr < minISR ? "ISR below minimum · writes rejected" : `Leader B${leader + 1} appends · followers replicate`;
  $("#fail-leader").disabled = !running || writing || electionPending || nextOffset === 0 || leader < 0 || !brokers[leader].up;
  $("#fail-follower").disabled = !running || writing || electionPending || !failoverCompleted || nextOffset === 0 || currentISR() < minISR;
}

function setAck(state, text) {
  const node = $("#durability-ack");
  node.classList.remove("is-acked", "is-rejected", "is-waiting");
  if (state) node.classList.add(`is-${state}`);
  node.textContent = text;
}

async function publish(run) {
  if (!running || run !== epoch || electionPending) return;
  const isrAtStart = currentISR();
  if (isrAtStart < minISR) {
    setAck("rejected", `REJECTED · ISR ${isrAtStart} < MIN 2`);
    setWriteState("rejected", "Write rejected: too few in-sync replicas");
    $("#durability-producer-state").textContent = "WRITE REJECTED";
    $("#durability-broker-state").textContent = "MIN ISR NOT MET";
    explain("<strong>Kafka rejects this write.</strong> Only one replica remains in the ISR, below <code>min.insync.replicas=2</code>. With <code>acks=all</code>, the producer does not receive a successful acknowledgment.");
    return;
  }

  writing = true;
  renderBrokers();
  setAck("waiting", `WAITING · ISR ${isrAtStart} / ${isrAtStart}`);
  setWriteState("writing", "Appending to partition leader…");
  $("#durability-producer-state").textContent = "PUBLISHING";
  const offset = nextOffset;
  const leaderCard = brokers[leader].element;
  await fly($("#durability-producer"), leaderCard, "created", `P0 · offset ${offset}`, run);
  if (!running || run !== epoch) return;
  appendRecord(leader, offset);
  $("#durability-broker-state").textContent = `APPENDED · OFFSET ${offset}`;

  const followers = brokers.map((broker, index) => ({ broker, index }))
    .filter(({ broker, index }) => index !== leader && broker.up && broker.inISR);
  const replicated = await Promise.all(followers.map(async ({ broker, index }) => {
    await fly(leaderCard, broker.element, "Replica copy", `P0 · offset ${offset}`, run, "is-copy");
    if (!running || run !== epoch) return false;
    appendRecord(index, offset);
    return true;
  }));
  if (!running || run !== epoch || replicated.some((value) => !value)) return;

  nextOffset += 1;
  writing = false;
  setAck("acked", `ACKED · ALL ${isrAtStart} ISR`);
  setWriteState("acked", `Record ${offset} replicated to ${isrAtStart} in-sync replicas`);
  $("#durability-producer-state").textContent = "ACK RECEIVED";
  renderBrokers();
  if (leader === 0 && currentISR() === 3) {
    explain("<strong>Write acknowledged.</strong> Broker 1 appended offset " + offset + "; both followers copied it. <code>acks=all</code> is satisfied by all three replicas currently in the ISR.");
  }
}

async function runWrites(run) {
  while (running && run === epoch) {
    await wait(500 / speed, run);
    if (!running || run !== epoch) break;
    if (electionPending) continue;
    await publish(run);
    if (!running || run !== epoch) break;
    await wait(900 / speed, run);
  }
}

function updateControls() {
  $("#start-durability").disabled = running;
  $("#pause-durability").disabled = !running;
  $("#reset-durability").disabled = false;
  renderBrokers();
}

function start() {
  if (running) return;
  running = true;
  const run = ++epoch;
  updateControls();
  setConsumers("READING P0");
  explain("<strong>Follow one record.</strong> The producer sends it to the P0 leader. Followers copy that same partition, and <code>acks=all</code> succeeds after the current ISR has acknowledged.");
  runWrites(run);
}

async function failLeader() {
  if (!running || writing || electionPending) return;
  const failed = leader;
  brokers[failed].up = false;
  brokers[failed].inISR = false;
  const promoted = brokers.findIndex((broker, index) => index !== failed && broker.up && broker.inISR);
  if (promoted < 0) return;
  leader = -1;
  electionPending = true;
  setConsumers("WAITING FOR LEADER");
  setAck("waiting", "PARTITION UNAVAILABLE · ELECTING LEADER");
  setWriteState("writing", "Waiting for Kafka to elect an in-sync replica…");
  $("#durability-producer-state").textContent = "WAITING FOR LEADER";
  renderBrokers();
  updateControls();
  explain(`<strong>Broker ${failed + 1} failed.</strong> Writes pause briefly while Kafka elects an in-sync replica. The other consumer groups may also wait for the new leader before continuing from P0.`);
  const run = epoch;
  await wait(1100 / speed, run);
  if (!running || run !== epoch) return;
  leader = promoted;
  electionPending = false;
  failoverCompleted = true;
  renderBrokers(promoted);
  setConsumers("READING P0");
  setAck("acked", `NEW LEADER · B${leader + 1}`);
  setWriteState("acked", `Broker ${leader + 1} elected from the in-sync replicas`);
  $("#durability-producer-state").textContent = "NEW LEADER";
  explain(`<strong>Broker ${leader + 1} is the new leader.</strong> It already had the committed records as an in-sync replica. Two replicas remain in the ISR, so writes can resume with the demo's minimum of two.`);
}

function failFollower() {
  if (!running || writing || currentISR() < minISR) return;
  const failed = brokers.findIndex((broker, index) => index !== leader && broker.up && broker.inISR);
  if (failed < 0) return;
  brokers[failed].up = false;
  brokers[failed].inISR = false;
  renderBrokers();
  setConsumers("READING P0");
  setAck("rejected", `REJECTED · ISR ${currentISR()} < MIN 2`);
  setWriteState("rejected", "Only one in-sync replica remains");
  $("#durability-producer-state").textContent = "WRITE REJECTED";
  explain("<strong>Kafka refuses new writes.</strong> Only the leader remains in the ISR. The demo's <code>min.insync.replicas=2</code> requires at least two in-sync replicas; keeping <code>acks=all</code> does not bypass that minimum.");
}

function reset() {
  setPaused(false);
  running = false;
  writing = false;
  electionPending = false;
  failoverCompleted = false;
  epoch += 1;
  activeAnimations.forEach((animation) => animation.stop());
  activeAnimations.clear();
  paths.replaceChildren();
  stage.querySelectorAll(".durability-packet:not(#durability-packet)").forEach((node) => node.remove());
  brokers.forEach((broker, index) => {
    broker.up = true;
    broker.inISR = true;
    broker.records = 0;
    $(".replica-records", broker.element).replaceChildren();
  });
  leader = 0;
  nextOffset = 0;
  $("#durability-producer-state").textContent = "READY";
  $("#durability-broker-state").textContent = "READY";
  $("#durability-cluster-note").textContent = "Leader appends · followers replicate";
  setAck("", "WAITING FOR WRITE");
  setWriteState("", "Ready to publish");
  setConsumers("WAITING");
  updateControls();
  explain("Start the writes. Each record is appended to the leader, copied to its in-sync followers, then acknowledged.");
}

$("#start-durability").addEventListener("click", start);
$("#fail-leader").addEventListener("click", failLeader);
$("#fail-follower").addEventListener("click", failFollower);
$("#pause-durability").addEventListener("click", () => setPaused(!paused));
$("#reset-durability").addEventListener("click", reset);
$("#durability-speed").addEventListener("input", (event) => {
  speed = Number(event.target.value);
  $("#durability-speed-value").textContent = `${speed}×`;
});
window.addEventListener("resize", () => paths.replaceChildren());
updateControls();

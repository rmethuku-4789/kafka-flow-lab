export function createState(replicated = false) {
  return { replicated, logs: [[], [], []], alive: [true, true, true], isr: replicated ? [0, 1, 2] : [0], leader: 0, producerLeader: 0, consumerLeader: 0, next: 0, position: 0, highWatermark: 0, effects: [], pending: null };
}

export function refreshMetadata(state, client, metadataBroker) {
  if (client !== "producer" && client !== "consumer") throw new Error("Unknown client");
  if (!state.alive[metadataBroker]) throw new Error("Metadata broker unavailable");
  if (state.leader === null || !state.alive[state.leader]) throw new Error("No available leader");
  state[`${client}Leader`] = state.leader;
  return state.leader;
}

export function appendLeader(state, record) {
  if (state.leader === null || !state.alive[state.leader]) throw new Error("No available leader");
  if (state.replicated && state.isr.filter((replica) => state.alive[replica]).length < 2) throw new Error("Insufficient in-sync replicas");
  const log = state.logs[state.leader];
  const existing = log.find((entry) => entry.id === record.id);
  if (existing) return existing;
  const stored = { ...record, offset: log.length };
  log.push(stored);
  return stored;
}

export function replicateRecord(state, follower, record) {
  if (!state.alive[follower] || !state.isr.includes(follower)) throw new Error("Unavailable replica");
  const log = state.logs[follower];
  if (log.length !== record.offset) throw new Error("Replica offset gap");
  log.push({ ...record });
}

export function acknowledgeRecord(state, record) {
  if (state.replicated && state.isr.length < 2) throw new Error("Insufficient in-sync replicas");
  if (!state.isr.every((replica) => state.alive[replica] && state.logs[replica][record.offset]?.id === record.id)) throw new Error("Replication incomplete");
  state.highWatermark = record.offset + 1;
}

export function electLeader(state, failed) {
  state.alive[failed] = false;
  state.isr = state.isr.filter((replica) => state.alive[replica]);
  const candidate = state.isr.find((replica) => state.logs[replica].length >= state.highWatermark);
  if (candidate === undefined) throw new Error("No eligible in-sync replica");
  state.leader = candidate;
  return candidate;
}

export function completeProcessing(state, record) {
  if (record.offset !== state.next || record.offset >= state.highWatermark) throw new Error("Invalid consumer offset");
  state.effects.push(record.id);
  state.next = record.offset + 1;
}

if (typeof document !== "undefined") startSimulator();

function startSimulator() {
  const select = (selector) => document.querySelector(selector);
  const stage = select("#failure-stage");
  const broker = (index) => select(`[data-broker="${index}"]`);
  for (const index of [0, 1, 2]) {
    const heading = broker(index).querySelector("h2");
    heading.firstChild.textContent = "Kafka ";
    heading.querySelector("span").textContent = `broker ${index + 1}`;
  }
  const paths = new Map();
  const headings = ["ONE BROKER", "THREE REPLICAS · NEW RUN", "LEADER FAILURE · LAST COMPLETED CYCLE"];
  const questions = ["What would you do?", "What if the leader disappears during a send?", "What changed after the retry?"];
  let state = createState();
  let stable = null;
  let failoverStart = null;
  let scene = 0;
  let paused = false;
  let playing = false;
  let speed = Number(select("#speed").value);
  let controller = new AbortController();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function active(signal) {
    if (signal.aborted) throw new DOMException("Scene changed", "AbortError");
  }

  async function interval(duration, signal, progress = () => {}) {
    let elapsed = 0;
    let previous = performance.now();
    const total = reduced ? Math.min(duration, 200) : duration;
    active(signal);
    progress(0);
    while (elapsed < total) {
      await new Promise(requestAnimationFrame);
      active(signal);
      const now = performance.now();
      if (!paused) elapsed += Math.min(now - previous, 100) * speed;
      previous = now;
      progress(Math.min(1, elapsed / total));
    }
  }

  function anchor(element, side) {
    const bounds = stage.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return { x: (side === "left" ? rect.left : side === "right" ? rect.right : rect.left + rect.width / 2) - bounds.left,
      y: rect.top + rect.height / 2 - bounds.top };
  }

  function addPath(name, description, control = false) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
    element.setAttribute("d", description);
    element.setAttribute("class", `connection-path${control ? " is-control" : ""}`);
    select("#paths").append(element);
    paths.set(name, element);
  }

  function drawRoutes() {
    select("#paths").replaceChildren();
    paths.clear();
    const rect = stage.getBoundingClientRect();
    select(".connections").setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    select(".connections").setAttribute("preserveAspectRatio", "none");
    const leader = state.leader ?? 0;
    const producer = anchor(select("#producer"), "right");
    const destination = anchor(broker(state.producerLeader ?? 0), "left");
    const clusterLeft = anchor(select("#cluster"), "left").x;
    if (!state.replicated) destination.x = clusterLeft;
    const middle = (producer.x + clusterLeft) / 2;
    addPath("produce", `M ${producer.x} ${producer.y} H ${middle} V ${destination.y} H ${destination.x}`);
    const source = anchor(broker(state.consumerLeader ?? 0), "right");
    if (!state.replicated) source.x = anchor(select("#cluster"), "right").x;
    const finance = anchor(select("#finance"), "left");
    const spine = (anchor(select("#cluster"), "right").x + finance.x) / 2;
    addPath("finance", `M ${source.x} ${source.y} H ${spine} V ${finance.y} H ${finance.x}`);
    for (const service of ["orders", "message-center"]) {
      const target = anchor(select(`#${service}`), "left");
      addPath(service, `M ${spine} ${finance.y} V ${target.y} H ${target.x}`);
    }
    if (state.replicated) {
      const lane = clusterLeft + 30;
      const replicationSource = anchor(broker(leader), "left");
      for (const replica of state.isr.filter((index) => index !== leader)) {
        const follower = anchor(broker(replica), "left");
        addPath(`replica-${replica}`, `M ${replicationSource.x} ${replicationSource.y} H ${lane} V ${follower.y} H ${follower.x}`);
      }
      if (scene === 2) {
        const metadataLeft = anchor(broker(2), "left");
        const metadataRight = anchor(broker(2), "right");
        addPath("producer-metadata", `M ${producer.x} ${producer.y} H ${middle} V ${metadataLeft.y} H ${metadataLeft.x}`, true);
        addPath("consumer-metadata", `M ${metadataRight.x} ${metadataRight.y} H ${spine} V ${finance.y} H ${finance.x}`, true);
      }
    }
  }

  async function fly(name, label, signal, reverse = false, end = 1) {
    const token = document.createElement("div");
    token.className = `packet${name.includes("metadata") || label.includes("ACK") ? " is-control" : ""}`;
    token.dataset.route = name;
    const dot = document.createElement("i");
    const text = document.createElement("small");
    text.textContent = label;
    token.append(dot, text);
    stage.append(token);
    try {
      await interval(1800, signal, (fraction) => {
        const route = paths.get(name);
        if (!route) throw new Error(`Missing route ${name}`);
        const point = route.getPointAtLength(route.getTotalLength() * (reverse ? 1 - fraction * end : fraction * end));
        token.style.transform = `translate(${point.x - 6.5}px,${point.y - 6.5}px)`;
        const cluster = select("#cluster");
        const labelLane = name.startsWith("replica-") ? anchor(cluster, "left").x + 30 : name === "produce" || name === "producer-metadata"
          ? (anchor(select("#producer"), "right").x + anchor(cluster, "left").x) / 2
          : (anchor(cluster, "right").x + anchor(select("#finance"), "left").x) / 2;
        text.style.left = `${labelLane - point.x + 6.5}px`;
        text.style.transform = "translateX(-50%)";
        route.classList.toggle("is-control", token.classList.contains("is-control"));
        route.classList.add("is-active");
      });
    } finally {
      token.remove();
      if (!signal.aborted) {
        paths.get(name)?.classList.remove("is-active");
        paths.get(name)?.classList.toggle("is-control", name.includes("metadata"));
      }
    }
  }

  function renderLogs() {
    for (const index of [0, 1, 2]) {
      const card = broker(index);
      card.hidden = !state.replicated && index > 0;
      card.classList.toggle("is-leader", state.leader === index && state.alive[index]);
      card.classList.toggle("is-down", !state.alive[index]);
      card.querySelector(".broker-role").textContent = !state.alive[index] ? "DOWN" : state.leader === index ? "LEADER" : "IN-SYNC REPLICA";
      card.querySelector(".replica-state").textContent = !state.alive[index] ? "OFFLINE" : state.isr.includes(index) ? "IN SYNC" : "CATCHING UP";
      card.querySelector(".log-end").textContent = `LOG END ${state.logs[index].length}`;
      card.querySelector(".record-count").textContent = state.replicated ? `LOG ${state.logs[index].length}` : String(state.logs[index].length);
      const window = card.querySelector(".record-window");
      window.replaceChildren();
      for (const record of state.logs[index].slice(state.replicated ? -3 : -4)) {
        const entry = document.createElement("span");
        entry.className = `stored-record${record.offset < state.next ? " is-finance-committed" : ""}`;
        entry.dataset.recordId = record.id;
        entry.dataset.offset = String(record.offset);
        entry.title = `P0:${record.offset} · ${record.id} · DisputeCreated`;
        const dot = document.createElement("span");
        dot.className = `record-dot${record.offset === state.logs[index].length - 1 && record.offset >= state.next ? " is-latest" : ""}`;
        dot.textContent = String(record.offset);
        const event = document.createElement("small");
        event.textContent = "CREATED";
        entry.append(dot, event);
        window.append(entry);
      }
    }
    select("#finance-next").textContent = `P0 · NEXT ${state.next}`;
    select("#producer").dataset.leader = state.producerLeader === null ? "unknown" : String(state.producerLeader + 1);
    select("#finance").dataset.leader = state.consumerLeader === null ? "unknown" : String(state.consumerLeader + 1);
    select("#cluster-offset").textContent = `P0 · NEXT ${state.next} · HW ${state.highWatermark}`;
    select(".coordinator-heading span").textContent = !state.replicated && !state.alive[0] ? "OFFLINE · RETAINED OFFSETS" : "OFFSETS READY";
    select("#controller-state").textContent = state.leader === null ? "P0 · NO LEADER" : `P0 · LEADER: BROKER ${state.leader + 1}`;
  }

  function playback() {
    select("#pause").textContent = paused ? "▶ Resume" : "Ⅱ Pause";
    select("#pause").setAttribute("aria-pressed", String(paused));
    select("#live span").textContent = paused ? "PAUSED" : playing ? "PLAYING" : "WAITING";
    select("#live").classList.toggle("is-paused", paused);
  }

  async function deliver(record, signal, retry = false) {
    if (state.producerLeader !== state.leader || state.consumerLeader !== state.leader) throw new Error("Client metadata is stale");
    state.pending = record.id;
    select("#event-identity").textContent = `${record.id} · CREATED`;
    select("#producer-state").textContent = retry ? "RETRYING" : "PUBLISHING";
    select("#producer").dataset.activity = retry ? "retry" : "idle";
    select("#event-card").classList.add("is-active");
    await fly("produce", `${retry ? "RETRY" : "SEND"} · E${record.id.split("-").at(-1)}`, signal);
    active(signal);
    const stored = appendLeader(state, record);
    renderLogs();
    select("#producer-state").textContent = "AWAITING ACK";
    for (const follower of state.isr.filter((index) => index !== state.leader)) {
      await fly(`replica-${follower}`, "FETCH P0", signal, true);
      await fly(`replica-${follower}`, `P0:${stored.offset}`, signal);
      active(signal);
      replicateRecord(state, follower, stored);
      renderLogs();
    }
    acknowledgeRecord(state, stored);
    renderLogs();
    await fly("produce", `ACK P0:${stored.offset}`, signal, true);
    select("#producer-state").textContent = "ACKNOWLEDGED";
    select("#producer").dataset.activity = "idle";
    select("#event-card").classList.remove("is-active");
    select("#finance-state").textContent = "POLLING";
    select("#member-state").textContent = "POLLING";
    await fly("finance", "POLL P0", signal, true);
    await fly("finance", `P0:${stored.offset}`, signal);
    state.position = stored.offset + 1;
    select("#finance-record").textContent = `P0:${stored.offset} · ${stored.id}`;
    select("#finance").dataset.activity = "processing";
    select("#finance-state").textContent = "PROCESSING";
    select("#member-state").textContent = "PROCESSING";
    await interval(2600, signal, (fraction) => { select("#processing-fill").style.width = `${fraction * 100}%`; });
    active(signal);
    completeProcessing(state, stored);
    state.pending = null;
    renderLogs();
    select("#finance-state").textContent = "PROCESSED";
    select("#member-state").textContent = "PROCESSED";
    stable = structuredClone(state);
    await interval(1200, signal);
    select("#processing-fill").style.width = "0%";
    select("#finance").dataset.activity = "idle";
  }

  async function failedSend(record, signal) {
    select("#event-identity").textContent = `${record.id} · CREATED`;
    select("#producer-state").textContent = "PUBLISHING";
    await fly("produce", `SEND E${record.id.split("-").at(-1)}`, signal, false, 0.55);
    const failed = state.leader;
    state.alive[failed] = false;
    state.producerLeader = null;
    state.pending = record.id;
    select("#producer").dataset.activity = "error";
    select("#producer-state").textContent = "CONNECTION FAILED";
    select("#finance-state").textContent = "WAITING";
    select("#member-state").textContent = "WAITING";
    renderLogs();
    await interval(1600, signal);
    return failed;
  }

  async function run(signal) {
    if (scene === 0) {
      await deliver({ id: "dispute-event-0" }, signal);
      await failedSend({ id: "dispute-event-1" }, signal);
      return;
    }
    if (scene === 1) {
      for (const index of [1, 2]) await interval(600, signal, (fraction) => { broker(index).style.opacity = String(fraction); });
      while (true) {
        await deliver({ id: `dispute-event-${state.logs[state.leader].length}` }, signal);
        await interval(800, signal);
      }
    }
    const pending = { id: `dispute-event-${state.logs[state.leader].length}` };
    const failed = await failedSend(pending, signal);
    select("#finance-state").textContent = "POLLING";
    select("#member-state").textContent = "POLLING";
    await fly("finance", "POLL P0", signal, true, 0.55);
    state.consumerLeader = null;
    select("#finance").dataset.activity = "error";
    select("#finance-state").textContent = "CONNECTION FAILED";
    select("#member-state").textContent = "CONNECTION FAILED";
    renderLogs();
    await interval(1200, signal);
    select("#finance").dataset.activity = "idle";
    select("#finance-state").textContent = "RECONNECTING";
    select("#member-state").textContent = "RECONNECTING";
    state.leader = null;
    renderLogs();
    select("#controller").classList.add("is-electing");
    await interval(2400, signal);
    electLeader(state, failed);
    renderLogs();
    drawRoutes();
    await interval(1800, signal);
    select("#controller").classList.remove("is-electing");
    select("#producer").dataset.activity = "retry";
    select("#producer-state").textContent = "REFRESHING METADATA";
    await fly("producer-metadata", "METADATA", signal);
    await fly("producer-metadata", `LEADER B${state.leader + 1}`, signal, true);
    refreshMetadata(state, "producer", 2);
    renderLogs();
    drawRoutes();
    select("#producer-state").textContent = "LEADER FOUND";
    select("#finance-state").textContent = "REFRESHING METADATA";
    select("#member-state").textContent = "REFRESHING METADATA";
    await fly("consumer-metadata", "METADATA", signal, true);
    await fly("consumer-metadata", `LEADER B${state.leader + 1}`, signal);
    refreshMetadata(state, "consumer", 2);
    renderLogs();
    drawRoutes();
    select("#finance-state").textContent = "LEADER FOUND";
    select("#member-state").textContent = "LEADER FOUND";
    await deliver(pending, signal, true);
    while (true) {
      await interval(800, signal);
      await deliver({ id: `dispute-event-${state.logs[state.leader].length}` }, signal);
    }
  }

  function enter(destination, replay = false) {
    controller.abort();
    controller = new AbortController();
    stage.querySelectorAll(".packet").forEach((token) => token.remove());
    if (destination === 2) {
      if (!replay || !failoverStart) failoverStart = stable?.replicated && stable.alive.every(Boolean) ? structuredClone(stable) : createState(true);
      state = structuredClone(failoverStart);
    } else {
      state = createState(destination === 1);
      stable = null;
    }
    scene = destination;
    paused = false;
    playing = true;
    select("#scene-heading").textContent = headings[scene];
    select("#scene-counter").textContent = `${scene + 1} / 3`;
    select("#scene-prompt").textContent = questions[scene];
    select("#previous").disabled = scene === 0;
    select("#next").disabled = scene === 2;
    select("#next").textContent = scene === 0 ? "What would you do? →" : scene === 2 ? "Complete" : "Next →";
    select("#cluster").classList.toggle("is-replicated", state.replicated);
    select("#cluster-caption").hidden = !state.replicated;
    select("#controller").hidden = !state.replicated;
    select("#controller").classList.remove("is-electing");
    select("#producer-config").textContent = state.replicated ? "acks=all · idempotence=true" : "RF 1 · MIN ISR 1 · acks=all";
    select("#producer").dataset.activity = "idle";
    select("#producer-state").textContent = "READY";
    select("#event-identity").textContent = "—";
    select("#event-card").classList.remove("is-active");
    select("#finance").dataset.activity = "idle";
    select("#finance-state").textContent = "WAITING";
    select("#member-state").textContent = "WAITING";
    select("#finance-record").textContent = state.next ? `P0:${state.next - 1} · EXISTING RECORD` : "—";
    select("#processing-fill").style.width = "0%";
    for (const index of [0, 1, 2]) broker(index).style.opacity = scene === 1 && index > 0 ? "0" : "1";
    renderLogs();
    drawRoutes();
    playback();
    const signal = controller.signal;
    run(signal).catch((error) => { if (error.name !== "AbortError") console.error(error); }).finally(() => {
      if (!signal.aborted) { playing = false; playback(); }
    });
  }

  select("#next").addEventListener("click", () => { if (scene < 2) enter(scene + 1); });
  select("#previous").addEventListener("click", () => { if (scene > 0) enter(scene - 1); });
  select("#reset").addEventListener("click", () => enter(scene, true));
  document.querySelectorAll("[data-replay]").forEach((button) => button.addEventListener("click", () => enter(Number(button.dataset.replay), true)));
  select("#pause").addEventListener("click", () => { paused = !paused; playback(); });
  select("#speed").addEventListener("input", (event) => { speed = Number(event.target.value); select("#speed-output").textContent = `${speed.toFixed(2).replace(/0$/, "")}×`; });
  select("#scenario-select").addEventListener("change", (event) => { window.location.href = event.target.value; });
  new ResizeObserver(drawRoutes).observe(stage);
  enter(0);
}

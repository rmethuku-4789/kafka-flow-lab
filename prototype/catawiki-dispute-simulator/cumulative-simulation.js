import { animate } from "motion";

const $ = (selector, root = document) => root.querySelector(selector);
const levels = { progress: 1, retry: 2, dlq: 3, idempotency: 4, history: 5 };
const intro = {
  progress: "Publish the dispute, then compare a checkpoint saved before and after Finance's payout hold.",
  retry: "Publish the dispute. Message Center's temporary database failure will keep its P0 checkpoint at 7.",
  dlq: "Publish the dispute. A permanent, record-specific failure can be copied to a configured review topic.",
  idempotency: "Publish the dispute. Finance will save a payout hold, crash, and read the same record again.",
  history: "Publish the dispute, then append a later closure event for the same dispute.",
};

export function runScenario(scene) {
  const level = levels[scene];
  const stage = $("#durability-stage");
  const paths = $("#durability-paths");
  const packet = $("#durability-packet");
  const sourceLog = $("#cumulative-log");
  const brokerCards = [0, 1, 2].map((n) => $(`#durability-broker-${n}`));
  const groups = ["orders", "finance", "message-center"];
  const liveAnimations = new Set();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let speed = 1;
  let paused = false;
  let busy = false;
  let generation = 0;
  let resumeWaiters = [];
  let state;

  function resetState() {
    state = {
      brokerUp: [true, true, true], leader: 0, electing: false, failedLeader: false,
      records: [], brokerRecords: [[], [], []], nextOffset: 7, financeOffset: 7, messageOffset: 7,
      payout: "ALLOWED", notice: "PENDING", attempts: 0, dlqCopy: false,
      dedupSaved: false, closedDedupSaved: false, financeWrites: 0, historyReplay: false,
      offsetBranch: "", flow: "", held: false, failureKind: "",
    };
  }

  function message(html) { $("#durability-explanation p").innerHTML = html; }
  function isr() { return state.brokerUp.filter(Boolean).length; }
  function hasCreated() { return state.records.some((record) => record.type === "DisputeCreated"); }
  function eventName(type) { return type === "DisputeCreated" ? "created" : "closed"; }
  function groupCard(group) { return $(`[data-durability-consumer="${group}"]`); }

  function setGroup(group, text, tone = "") {
    const card = groupCard(group);
    card.classList.remove("is-focus", "is-error", "is-done", "is-reading", "is-waiting");
    if (tone) card.classList.add(`is-${tone}`);
    $(`[data-durability-state="${group}"]`).textContent = text;
  }

  function setPaused(value) {
    paused = value;
    liveAnimations.forEach((animation) => value ? animation.pause() : animation.play());
    $("#cumulative-pause").textContent = value ? "▶ Resume" : "Ⅱ Pause";
    $("#cumulative-pause").setAttribute("aria-pressed", String(value));
    if (!value) resumeWaiters.splice(0).forEach((resume) => resume());
  }

  async function delay(ms, run) {
    let remaining = reducedMotion ? Math.min(ms, 100) : ms / speed;
    while (remaining > 0 && run === generation) {
      if (paused) { await new Promise((resolve) => resumeWaiters.push(resolve)); continue; }
      const slice = Math.min(40, remaining);
      const started = performance.now();
      await new Promise((resolve) => setTimeout(resolve, slice));
      if (!paused) remaining -= performance.now() - started;
    }
  }

  function center(node) {
    const stageBox = stage.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2 - stageBox.left, y: box.top + box.height / 2 - stageBox.top, width: box.width };
  }

  async function fly(from, to, label, detail, run, copy = false) {
    if (run !== generation) return;
    const a = center(from), b = center(to);
    const direction = Math.sign(b.x - a.x) || 1;
    const x1 = a.x + a.width * direction / 2;
    const x2 = b.x - b.width * direction / 2;
    const bend = (x1 + x2) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", copy && to === brokerCards[2]
      ? `M ${x1} ${a.y} V ${a.y - 75} H ${x2 - 12} V ${b.y} H ${x2}`
      : `M ${x1} ${a.y} H ${bend} V ${b.y} H ${x2}`);
    path.setAttribute("class", `durability-path is-active${copy ? " is-copy" : ""}`);
    path.setAttribute("marker-end", "url(#durability-arrow)");
    paths.append(path);
    const moving = packet.cloneNode(true);
    moving.removeAttribute("id");
    moving.style.display = "flex";
    moving.style.opacity = "1";
    moving.querySelector("b").textContent = label;
    moving.dataset.kind = /commit/i.test(label) ? "commit" : /ack/i.test(label) ? "ack" : /resolved/i.test(label) ? "resolved" : /fail/i.test(label) ? "error" : "event";
    path.dataset.kind = moving.dataset.kind;
    moving.querySelector("small").textContent = detail;
    stage.append(moving);
    const bounds = moving.getBoundingClientRect();
    const length = path.getTotalLength();
    const points = Array.from({ length: 20 }, (_, n) => path.getPointAtLength(length * n / 19));
    const animation = animate(moving, {
      x: points.map((point) => point.x - bounds.width / 2),
      y: points.map((point) => point.y - bounds.height / 2),
    }, { duration: (reducedMotion ? .12 : .9) / speed, ease: [0.22, 1, 0.36, 1] });
    liveAnimations.add(animation);
    if (paused) animation.pause();
    await animation.finished.catch(() => {});
    liveAnimations.delete(animation);
    moving.remove();
    path.remove();
  }

  function render() {
    const count = isr();
    $("#durability-isr").textContent = `ISR · ${count} / 3`;
    $("#durability-broker-state").textContent = state.electing ? "ELECTING LEADER" : count < 2 ? "WRITES BLOCKED" : `LEADER · B${state.leader + 1}`;
    $("#durability-cluster-note").textContent = state.electing ? "P0 briefly unavailable" : count < 2 ? "ISR below minimum · writes rejected" : `Leader B${state.leader + 1} appends · followers replicate`;
    brokerCards.forEach((card, n) => {
      card.classList.toggle("is-leader", state.brokerUp[n] && n === state.leader);
      card.classList.toggle("is-down", !state.brokerUp[n]);
      $(".broker-role", card).textContent = !state.brokerUp[n] ? "OFFLINE" : n === state.leader ? "LEADER" : "FOLLOWER";
      $(".broker-health span", card).textContent = !state.brokerUp[n] ? "BROKER DOWN" : n === state.leader ? "IN SYNC · LEADER" : "IN SYNC";
      $(".replica-records", card).replaceChildren();
      for (const offset of state.brokerRecords[n].slice(-5)) {
        const item = document.createElement("span");
        item.className = "replica-record";
        item.textContent = String(offset);
        item.title = `P0 offset ${offset}`;
        $(".replica-records", card).append(item);
      }
    });
    sourceLog.replaceChildren();
    for (const record of state.records) {
      const item = document.createElement("span");
      const waiting = (state.flow === "retry" || state.flow === "dlq")
        && record.offset > 7 && state.messageOffset < record.offset;
      item.className = `cumulative-record${record.type === "DisputeClosed" ? " is-closed" : ""}${waiting ? " is-waiting" : ""}`;
      item.textContent = `P0:${record.offset} · ${eventName(record.type)}${waiting ? " · waits" : ""}`;
      sourceLog.append(item);
    }
    $("#finance-offset").textContent = state.financeOffset;
    $("#message-offset").textContent = state.messageOffset;
    $("#finance-effect").textContent = `Payout: ${state.payout.toLowerCase()}${level >= 4 ? ` · DB writes: ${state.financeWrites}` : ""}`;
    if ($("#cumulative-dedup")) $("#cumulative-dedup").textContent = scene === "history"
      ? `Processed event IDs · ${state.dedupSaved ? "created" : "none"}${state.closedDedupSaved ? ", closed" : ""}`
      : `Event ID dispute-49328-created · ${state.dedupSaved ? "already saved" : "unseen"}`;
    $("#message-effect").textContent = `Notice: ${state.notice.toLowerCase()}${level >= 2 ? ` · attempts: ${state.attempts}` : ""}`;
    if ($("#cumulative-failure-reason")) $("#cumulative-failure-reason").textContent =
      state.failureKind === "transient" && state.notice === "CREATED"
        ? "Notice database recovered"
        : state.failureKind === "transient" || (!state.failureKind && scene === "retry")
        ? "Failure example: notice database unavailable"
        : state.failureKind === "permanent" || (!state.failureKind && scene === "dlq")
          ? "Failure example: missing notice template ID"
          : "No failure selected";
    $("#finance-detail").classList.toggle("is-success", state.payout !== "ALLOWED");
    $("#message-detail").classList.toggle("is-alert", state.notice === "FAILED");
    $("#message-detail").classList.toggle("is-success", state.notice === "CREATED");
    $("#cumulative-dlq").hidden = level < 3;
    $("#cumulative-dlq-state").textContent = state.dlqCopy ? "Failed P0:7 copy acknowledged · review required" : "Separate topic · own partitions and replica settings · no copy yet";
    $("#cumulative-fail-leader").disabled = busy || state.electing || state.failedLeader || !hasCreated() || !state.brokerUp[state.leader];
    $("#cumulative-fail-follower").disabled = busy || !state.failedLeader || count < 2;
    $("#cumulative-publish").disabled = busy || hasCreated();
    document.querySelectorAll("[data-action]").forEach((button) => {
      const action = button.dataset.action;
      const owner = action.startsWith("offset-") ? "offsets"
        : action.startsWith("retry-") ? "retry"
          : action.startsWith("dlq-") ? "dlq"
            : action.startsWith("idempotent-") ? "idempotency" : "history";
      button.disabled = busy || !hasCreated()
        || (state.flow && state.flow !== owner)
        || ((action === "offset-early" || action === "offset-late") && !!state.offsetBranch)
        || (action === "offset-commit" && (state.offsetBranch !== "late" || state.financeOffset >= 8))
        || (action === "closed" && (state.payout !== "BLOCKED" || state.records.some((r) => r.type === "DisputeClosed")))
        || (action === "replay" && !state.records.some((r) => r.type === "DisputeClosed"))
        || (action === "history-block" && state.dedupSaved)
        || ((action === "retry-fail" || action === "dlq-fail") && state.attempts > 0)
        || (action === "retry-recover" && (state.attempts < 3 || state.notice !== "FAILED"))
        || (action === "dlq-hold" && (state.failureKind !== "permanent" || state.held || state.dlqCopy))
        || (action === "dlq-copy" && (state.failureKind !== "permanent" || state.dlqCopy))
        || (action === "dlq-commit" && (!state.dlqCopy || state.messageOffset >= 8))
        || (action === "idempotent-first" && state.dedupSaved)
        || (action === "idempotent-again" && (!state.dedupSaved || state.financeOffset >= 8));
    });
  }

  async function perform(action) {
    if (busy) return;
    busy = true;
    render();
    const run = generation;
    try { await action(run); }
    finally { busy = false; if (run === generation) render(); }
  }

  async function publish(type, run, deliverTo = groups) {
    if (isr() < 2 || state.electing) {
      $("#durability-ack").textContent = "WRITE REJECTED · ISR BELOW 2";
      $("#durability-ack").className = "control-kind durability-ack is-rejected";
      message("<strong>Write rejected.</strong> The demo has <code>acks=all</code> and <code>min.insync.replicas=2</code>; only one replica is in sync.");
      return false;
    }
    const offset = state.nextOffset;
    $("#durability-producer-state").textContent = "PUBLISHING";
    $("#durability-ack").textContent = "WAITING FOR ISR";
    $("#durability-ack").className = "control-kind durability-ack is-waiting";
    await fly($("#durability-producer"), brokerCards[state.leader], eventName(type), `P0 · offset ${offset}`, run);
    if (run !== generation) return false;
    state.brokerRecords[state.leader].push(offset);
    $("#durability-producer-state").textContent = "WAITING FOR REPLICAS";
    $("#durability-write-state b").textContent = `Leader appended P0:${offset} · copying to followers`;
    $("#durability-write-state").className = "durability-write-state is-writing";
    render();
    await Promise.all(brokerCards.map((card, n) => n !== state.leader && state.brokerUp[n]
      ? (async () => {
        await fly(brokerCards[state.leader], card, "Replica copy", `P0 · offset ${offset}`, run, true);
        if (run === generation) {
          state.brokerRecords[n].push(offset);
          render();
        }
      })() : null));
    if (run !== generation) return false;
    state.records.push({ offset, type });
    state.nextOffset++;
    $("#durability-ack").textContent = `ACKED · ${isr()} ISR`;
    $("#durability-ack").className = "control-kind durability-ack is-acked";
    $("#durability-producer-state").textContent = "ACK RECEIVED";
    $("#durability-write-state b").textContent = offset === 8 && type === "DisputeCreated"
      ? "Next record stored at P0:8"
      : `${eventName(type)} stored at P0:${offset}`;
    $("#durability-write-state").className = "durability-write-state is-acked";
    render();
    await Promise.all(deliverTo.map((group) => fly(brokerCards[state.leader], groupCard(group), eventName(type), `P0 · offset ${offset}`, run)));
    if (run !== generation) return false;
    deliverTo.forEach((group) => setGroup(group, `READ P0:${offset}`, group === (scene === "retry" || scene === "dlq" ? "message-center" : "finance") ? "focus" : ""));
    if (type === "DisputeClosed") setGroup("message-center", "IGNORES CLOSED");
    message(`<strong>Record ${offset} is in the P0 log.</strong> Its replicas are on ${isr()} brokers. Each consumer group has its own reading position; the next action focuses on one group.`);
    return true;
  }

  async function failLeader(run) {
    const old = state.leader;
    state.brokerUp[old] = false;
    state.leader = -1;
    state.electing = true;
    groups.forEach((group) => setGroup(group, "WAITING FOR LEADER", "waiting"));
    render();
    message(`<strong>Broker ${old + 1} failed.</strong> The P0 leader is unavailable while Kafka elects an in-sync replica.`);
    await delay(900, run);
    if (run !== generation) return;
    state.leader = state.brokerUp.findIndex(Boolean);
    state.electing = false;
    state.failedLeader = true;
    groups.forEach((group) => setGroup(group, "READING P0"));
    message(`<strong>Broker ${state.leader + 1} now leads P0.</strong> The same log remains available. Consumer checkpoints do not change because a broker changed.`);
  }

  function failFollower() {
    const n = state.brokerUp.findIndex((up, index) => up && index !== state.leader);
    if (n < 0) return;
    state.brokerUp[n] = false;
    $("#durability-ack").textContent = "FUTURE WRITES REJECTED · ISR 1";
    $("#durability-ack").className = "control-kind durability-ack is-rejected";
    message("<strong>One replica remains.</strong> With <code>min.insync.replicas=2</code> and <code>acks=all</code>, new writes are rejected until ISR recovers.");
  }

  async function financeRead(run) {
    await fly(brokerCards[state.leader], groupCard("finance"), "created", "P0 · offset 7", run);
    if (run !== generation) return;
    setGroup("finance", "PROCESSING 7", "focus");
  }
  function financeEffect() {
    state.payout = "BLOCKED";
    state.financeWrites++;
    setGroup("finance", "PAYOUT HELD", "done");
  }
  async function earlyCrash(run) {
    state.offsetBranch = "early";
    await financeRead(run);
    if (run !== generation) return;
    state.financeOffset = 8;
    render();
    await delay(400, run);
    if (run !== generation) return;
    setGroup("finance", "RESTARTED AT 8", "error");
    message("<strong>Checkpoint moved before the payout hold.</strong> Finance crashes, then resumes at P0:8. It skips record 7's effect, so the payout stays allowed. Reset to compare the other commit order.");
  }
  async function lateCrash(run) {
    state.offsetBranch = "late";
    await financeRead(run);
    if (run !== generation) return;
    financeEffect();
    render();
    await delay(400, run);
    if (run !== generation) return;
    setGroup("finance", "CRASHED · OFFSET 7", "error");
    await delay(400, run);
    if (run !== generation) return;
    await financeRead(run);
    if (run !== generation) return;
    setGroup("finance", "REDELIVERED 7", "focus");
    message("<strong>The hold was saved, but offset 8 was not committed.</strong> Restart reads P0:7 again. Kafka can redeliver; the Finance database effect needs its own duplicate guard. Commit 8, or reset to compare.");
  }
  async function commitFinance(run) {
    await delay(250, run);
    if (run !== generation) return;
    state.financeOffset = 8;
    setGroup("finance", "COMMITTED 8", "done");
    message("<strong>Finance committed 8.</strong> This group's next read from P0 starts at offset 8. Orders and Message Center keep separate checkpoints. Reset to compare the commit-first path.");
  }

  async function retries(run, kind) {
    state.attempts = 0;
    state.notice = "FAILED";
    state.failureKind = kind;
    if (state.nextOffset === 8) {
      state.financeOffset = 8;
      financeEffect();
      setGroup("orders", "BANNER SHOWN", "done");
      await publish("DisputeCreated", run, ["orders", "finance"]);
      if (run !== generation) return;
      setGroup("message-center", "P0:8 WAITING", "waiting");
    }
    const limit = kind === "permanent" ? 1 : 3;
    for (let n = 1; n <= limit; n++) {
      await fly(brokerCards[state.leader], groupCard("message-center"), "created", "P0 · offset 7", run);
      if (run !== generation) return;
      state.attempts = n;
      setGroup("message-center", kind === "permanent" ? "NON-RETRYABLE" : `FAILED · ${n}/3`, "error");
      render();
      await delay(350, run);
      if (run !== generation) return;
    }
    message(kind === "permanent"
      ? "<strong>This record cannot be processed as written.</strong> The missing template ID is a record-specific error. Message Center holds P0:7; it can alert and wait, or send a copy to the configured review topic before advancing."
      : "<strong>Three attempts failed.</strong> This example's consumer policy holds Message Center's P0 checkpoint at 7. Later P0 records wait for this group; other groups can continue.");
  }
  async function restoreNotice(run) {
    await fly(brokerCards[state.leader], groupCard("message-center"), "created", "P0 · offset 7", run);
    if (run !== generation) return;
    state.attempts++;
    state.notice = "CREATED";
    state.messageOffset = 8;
    setGroup("message-center", "NOTICE SENT · 8", "done");
    message("<strong>The dependency recovered.</strong> Message Center created the notice, then committed next offset 8. Its retry policy belongs to the application or framework.");
  }
  async function sendDlq(run) {
    await fly(groupCard("message-center"), $("#cumulative-dlq"), "Failed event", "copy of P0:7", run);
    if (run !== generation) return;
    state.dlqCopy = true;
    state.notice = "FAILED";
    setGroup("message-center", "REVIEW COPY SAVED", "error");
    message("<strong>A copy was acknowledged in the review topic.</strong> The buyer notice still failed. Message Center's source checkpoint remains 7 until it explicitly commits 8.");
  }
  function commitSource() {
    if (!state.dlqCopy) {
      message("<strong>Publish the failed-event copy first.</strong> Advancing the source checkpoint before a confirmed copy could lose this failure from the normal path.");
      return;
    }
    state.messageOffset = 8;
    setGroup("message-center", "P0 CAN CONTINUE", "done");
    render();
    message("<strong>Source offset 8 committed.</strong> Later P0 records may now be handled by Message Center. A crash after the review-topic write and before this commit can create another review copy.");
  }
  async function guardedEffect(run) {
    await financeRead(run);
    if (run !== generation) return;
    if (!state.dedupSaved) {
      state.dedupSaved = true;
      financeEffect();
      message("<strong>First delivery:</strong> Finance saves the event ID and payout hold in one database transaction. It crashes before committing offset 8.");
    } else {
      setGroup("finance", "DUPLICATE SKIPPED", "done");
      message("<strong>Redelivery:</strong> Finance finds the same event ID, skips another payout write, then can commit offset 8. The effect ran once even though the record was read twice.");
      state.financeOffset = 8;
    }
  }
  async function closeDispute(run) {
    const offset = state.nextOffset;
    if (!await publish("DisputeClosed", run)) return;
    state.payout = "RELEASED";
    state.closedDedupSaved = true;
    state.financeWrites++;
    state.financeOffset = offset + 1;
    state.messageOffset = offset + 1;
    setGroup("finance", `CLOSED · OFFSET ${offset + 1}`, "done");
    message(`<strong>The closed event was appended at P0:${offset}.</strong> The earlier created event remains in the log. In this illustrative business flow, Finance updates its current view. Message Center ignores the closed event and can still advance its position.`);
  }
  async function replay(run) {
    for (const record of state.records) {
      await fly(brokerCards[state.leader], $("#cumulative-replay"), eventName(record.type), `P0 · offset ${record.offset}`, run);
      if (run !== generation) return;
    }
    state.historyReplay = true;
    $("#cumulative-replay").classList.add("is-done");
    $("#cumulative-replay span").textContent = `Read ${state.records.map((r) => `P0:${r.offset}`).join(" → ")} · no payout writes`;
    message("<strong>A separate replay reader saw both retained records in P0 order.</strong> It reconstructs state without re-running the live payout action. Kafka can only replay records still retained by the topic.");
  }

  const actions = {
    progress: [
      ["offset-early", "Commit first → crash", () => perform(earlyCrash)],
      ["offset-late", "Save hold → crash", () => perform(lateCrash)],
      ["offset-commit", "Commit next offset 8", () => perform(commitFinance)],
    ],
    retry: [
      ["retry-fail", "Try 3 times · DB unavailable", () => perform((run) => retries(run, "transient"))],
      ["retry-recover", "Restore DB → retry", () => perform(restoreNotice)],
    ],
    dlq: [
      ["dlq-fail", "Process bad record", () => perform((run) => retries(run, "permanent"))],
      ["dlq-hold", "Hold P0 + alert", () => {
        state.held = true;
        setGroup("message-center", "P0 HELD · ALERT", "error");
        message("<strong>Message Center holds P0:7 and alerts an operator.</strong> Its later P0 records wait. Orders and Finance continue in their independent groups.");
        render();
      }],
      ["dlq-copy", "Publish review copy", () => perform(sendDlq)],
      ["dlq-commit", "Commit source offset 8", commitSource],
    ],
    idempotency: [
      ["idempotent-first", "Save hold → crash", () => perform(guardedEffect)],
      ["idempotent-again", "Restart → redeliver", () => perform(guardedEffect)],
    ],
    history: [
      ["history-block", "Process created", () => perform(async (run) => {
        await financeRead(run);
        if (run !== generation) return;
        financeEffect();
        state.dedupSaved = true;
        state.financeOffset = 8;
        state.notice = "CREATED";
        state.messageOffset = 8;
        setGroup("orders", "BANNER SHOWN", "done");
        setGroup("message-center", "NOTICE SENT · 8", "done");
        setGroup("finance", "HELD · OFFSET 8", "done");
        message("<strong>All three groups processed P0:7.</strong> Orders shows the banner, Finance holds the payout, and Message Center sends a notice. Each group now reads after offset 7.");
      })],
      ["closed", "Publish closed", () => perform(closeDispute)],
      ["replay", "Replay retained P0 log", () => perform(replay)],
    ],
  };
  if (level >= 4) {
    const dedup = document.createElement("small");
    dedup.id = "cumulative-dedup";
    dedup.textContent = "Event ID dispute-49328-created · unseen";
    $("#finance-detail").append(dedup);
  }
  if (scene === "retry" || scene === "dlq") {
    const reason = document.createElement("small");
    reason.id = "cumulative-failure-reason";
    $("#message-detail").append(reason);
  }
  if (level >= 5) {
    const routeNote = document.createElement("small");
    routeNote.textContent = "Demo: both events are routed to P0.";
    $(".durability-setting").append(routeNote);
    const replayCard = document.createElement("div");
    replayCard.className = "cumulative-replay";
    replayCard.id = "cumulative-replay";
    replayCard.innerHTML = "<b>Separate replay reader</b><span>Ready · no payout writes</span>";
    $(".durability-consumers").append(replayCard);
  }
  for (const [name, list] of Object.entries(actions)) {
    if (levels[name] > level) continue;
    const target = name === scene ? $("#cumulative-actions") : $("#cumulative-prior-actions");
    for (const [key, label, handler] of list) {
      const button = document.createElement("button");
      button.className = "scenario-button";
      button.type = "button";
      button.dataset.action = key;
      button.textContent = label;
      button.addEventListener("click", () => {
        state.flow ||= name === "progress" ? "offsets" : name;
        handler();
        render();
      });
      target.append(button);
    }
  }
  if (!$("#cumulative-prior-actions").children.length) $(".cumulative-prior").hidden = true;

  $("#cumulative-publish").addEventListener("click", () => perform((run) => publish("DisputeCreated", run)));
  $("#cumulative-fail-leader").addEventListener("click", () => perform(failLeader));
  $("#cumulative-fail-follower").addEventListener("click", () => { failFollower(); render(); });
  $("#cumulative-pause").addEventListener("click", () => setPaused(!paused));
  $("#cumulative-speed").addEventListener("input", (event) => {
    speed = Number(event.target.value);
    $("#cumulative-speed-value").textContent = `${speed}×`;
  });
  $("#cumulative-reset").addEventListener("click", () => {
    generation++;
    setPaused(false);
    liveAnimations.forEach((animation) => animation.stop());
    liveAnimations.clear();
    stage.querySelectorAll(".durability-packet:not(#durability-packet)").forEach((node) => node.remove());
    paths.replaceChildren();
    busy = false;
    resetState();
    $("#cumulative-replay")?.classList.remove("is-done");
    if ($("#cumulative-replay span")) $("#cumulative-replay span").textContent = "Ready · no payout writes";
    groups.forEach((group) => setGroup(group, "WAITING"));
    $("#durability-ack").textContent = "WAITING FOR WRITE";
    $("#durability-ack").className = "control-kind durability-ack";
    $("#durability-producer-state").textContent = "READY";
    $("#durability-write-state b").textContent = "Ready to publish";
    $("#durability-write-state").className = "durability-write-state";
    message(intro[scene]);
    render();
  });
  window.addEventListener("resize", () => paths.replaceChildren());
  resetState();
  $(".durability-cluster h2").innerHTML = "Source partition <span>· P0</span>";
  $(".durability-cluster-foot span:first-child").textContent = "Earlier P0 offsets 0–6 omitted from this demo.";
  render();
  message(intro[scene]);
}

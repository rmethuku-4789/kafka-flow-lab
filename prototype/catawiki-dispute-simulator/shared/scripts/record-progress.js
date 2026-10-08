const displayedStates = new WeakMap();
// Display-only teaching state. A commit never deletes a Kafka record.
export function recordProgress(record, { groups, nextByGroup, failed = false, processed = true }) {
  const pending = groups.filter(group => !Number.isInteger(nextByGroup[group]?.[record.partition]) || nextByGroup[group][record.partition] <= record.offset);
  const status = failed ? "failed" : groups.length && !pending.length && processed ? "committed" : "pending";
  return { status, pending };
}

export function displayRecordProgress(dot, record, options) {
  const progress = recordProgress(record, options);
  if (options.scope) {
    let previous = displayedStates.get(options.scope);
    if (!previous) displayedStates.set(options.scope, previous = new Map());
    const key = `${record.partition}:${record.offset}:${record.eventId ?? ""}`;
    const before = previous.get(key);
    previous.set(key, progress.status);
    if (progress.status === "committed" && before && before !== "committed" && options.playback) {
      const animation = dot.animate([
        { backgroundColor: before === "failed" ? "#fdeaea" : "#eaf1ff", color: before === "failed" ? "#a63636" : "#2260d9", borderColor: before === "failed" ? "#e4a1a1" : "#8eb2ff" },
        { backgroundColor: "#eef2f7", color: "#5c6b80", borderColor: "#d8e0ea" }
      ], { duration: options.playback.duration(350), easing: "linear" });
      options.playback.track(animation, "playbackRate");
    }
    // Keep only the visible log window, including records absent after Reset.
    while (previous.size > 32) previous.delete(previous.keys().next().value);
  }
  dot.dataset.progress = progress.status;
  dot.classList.add("record-dot");
  dot.classList.remove("is-latest");
  dot.title += progress.status === "failed" ? " · Processing failed" : progress.status === "committed" ? ` · Completed for ${options.groups.join(", ")}` : ` · Pending for ${progress.pending.length ? progress.pending.join(", ") : "application processing"}`;
  return progress;
}

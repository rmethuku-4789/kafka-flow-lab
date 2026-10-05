import "./scenario-navigation.css";

const scenarios = [
  ["01", "Recap", "/recap"],
  ["02", "Partitions", "/partitions"],
  ["03", "Consumer groups", "/groups"],
  ["04", "Broker failure", "/durability"],
  ["05", "Offsets", "/progress"],
  ["06", "Retries", "/retry"],
  ["07", "Dead-letter queue", "/dlq"],
  ["08", "Idempotency", "/idempotency"],
  ["09", "Event history", "/history"],
  ["10", "Ordering", "/ordering"],
  ["11", "Schemas", "/schemas"],
];

const presentationRoutes = new Set(["/recap", "/partitions", "/groups"]);
const currentPath = location.pathname.replace(/\/$/, "") || "/";
const route = currentPath === "/" || currentPath === "/index.html" ? "/recap" : currentPath.replace(/\.html$/, "");

if (presentationRoutes.has(route)) {
  document.body.classList.add("presentation-mode");
  document.querySelector(".topbar")?.setAttribute("hidden", "");
  document.querySelector(".lesson-footer, .page-footer")?.setAttribute("hidden", "");
  document.querySelectorAll(".connections").forEach((svg) => {
    const marker = svg.querySelector("marker");
    if (!marker) return;
    marker.setAttribute("orient", "auto-start-reverse");
    marker.querySelector("path")?.setAttribute("fill", "context-stroke");
    svg.style.setProperty("--flow-arrow", `url(#${marker.id})`);
  });
  const selector = document.createElement("select");
  selector.className = "scenario-picker";
  selector.setAttribute("aria-label", "Choose a Kafka scenario");

  for (const [number, label, href] of scenarios) {
    const option = document.createElement("option");
    option.value = href;
    option.textContent = `${number} · ${label}`;
    option.selected = route === href;
    selector.append(option);
  }
  selector.addEventListener("change", () => location.assign(selector.value));
  document.querySelector(".intro")?.append(selector);
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}

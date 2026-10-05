import { renameSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const simulatorRoot = fileURLToPath(new URL("./prototype/catawiki-dispute-simulator/", import.meta.url));
const scenarioPages = new Map([
  ["/recap", "scenarios/recap/index.html"],
  ["/groups", "scenarios/groups/index.html"],
  ["/retries-dlq", "scenarios/retries-dlq/index.html"],
  ["/offsets-idempotency", "scenarios/offsets-idempotency/index.html"],
  ["/schema-evolution", "scenarios/schema-evolution/index.html"],
  ["/broker-failure", "scenarios/broker-failure/index.html"],
]);
const scenarioOutputPages = new Map([
  ["scenarios/recap/index.html", "recap.html"],
  ["scenarios/groups/index.html", "groups.html"],
  ["scenarios/retries-dlq/index.html", "retries-dlq.html"],
  ["scenarios/offsets-idempotency/index.html", "offsets-idempotency.html"],
  ["scenarios/schema-evolution/index.html", "schema-evolution.html"],
  ["scenarios/broker-failure/index.html", "broker-failure.html"],
]);

function scenarioRoutes() {
  const install = (server, isPreview = false) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] === "/") {
        const query = req.url.includes("?") ? `?${req.url.split("?")[1]}` : "";
        req.url = `/recap${query}`;
      }
      if (req.url) {
        const [pathname, query] = req.url.split("?");
        const page = scenarioPages.get(pathname.replace(/\/+$/, ""));
        if (page) {
          const target = isPreview ? scenarioOutputPages.get(page) : page;
          req.url = `/${target}${query ? `?${query}` : ""}`;
        }
      }
      next();
    });
  };

  return {
    name: "scenario-routes",
    configureServer: (server) => install(server),
    configurePreviewServer: (server) => install(server, true),
  };
}

function flattenScenarioPages() {
  return {
    name: "flatten-scenario-pages",
    enforce: "post",
    writeBundle(outputOptions) {
      const outputDir = outputOptions.dir ?? resolve(simulatorRoot, "dist");
      for (const [source, target] of scenarioOutputPages) {
        renameSync(resolve(outputDir, source), resolve(outputDir, target));
      }
    },
  };
}

export default defineConfig({
  plugins: [scenarioRoutes(), flattenScenarioPages()],
  build: {
    rollupOptions: {
      input: {
        recap: resolve(simulatorRoot, "scenarios/recap/index.html"),
        groups: resolve(simulatorRoot, "scenarios/groups/index.html"),
        retriesDlq: resolve(simulatorRoot, "scenarios/retries-dlq/index.html"),
        offsetsIdempotency: resolve(simulatorRoot, "scenarios/offsets-idempotency/index.html"),
        schemaEvolution: resolve(simulatorRoot, "scenarios/schema-evolution/index.html"),
        brokerFailure: resolve(simulatorRoot, "scenarios/broker-failure/index.html"),
      },
    },
  },
});

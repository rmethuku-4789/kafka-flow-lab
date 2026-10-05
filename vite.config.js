import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const simulatorRoot = fileURLToPath(new URL("./prototype/catawiki-dispute-simulator/", import.meta.url));
const scenarioPages = new Map([
  ["/recap", "recap-2.html"],
  ["/recap-2", "recap-2.html"],
  ["/schemas", "schemas.html"],
  ["/ordering", "ordering.html"],
  ["/partitions", "partitions.html"],
  ["/groups", "groups.html"],
  ["/durability", "durability.html"],
  ["/progress", "progress.html"],
  ["/retry", "retry.html"],
  ["/dlq", "dlq.html"],
  ["/idempotency", "idempotency.html"],
  ["/history", "history.html"],
  ["/retries-dlq", "retries-dlq.html"],
  ["/offsets-idempotency", "offsets-idempotency.html"],
  ["/schema-evolution", "schema-evolution.html"],
  ["/broker-failure", "broker-failure.html"],
]);

function scenarioRoutes() {
  const rewrite = (req) => {
    if (!req.url) return;
    const [pathname, query] = req.url.split("?");
    const page = scenarioPages.get(pathname.replace(/\/+$/, ""));
    if (page) req.url = `/${page}${query ? `?${query}` : ""}`;
  };
  const install = (server) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] === "/") {
        const query = req.url.includes("?") ? `?${req.url.split("?")[1]}` : "";
        req.url = `/recap${query}`;
      }
      if (req.url?.split("?")[0].replace(/\/+$/, "") === "/simulator") {
        res.statusCode = 308;
        res.setHeader("Location", "/recap");
        res.end();
        return;
      }
      rewrite(req);
      next();
    });
  };

  return {
    name: "scenario-routes",
    configureServer: install,
    configurePreviewServer: install,
  };
}

export default defineConfig({
  plugins: [scenarioRoutes()],
  build: {
    rollupOptions: {
      input: {
        recap: resolve(simulatorRoot, "recap-2.html"),
        recap2: resolve(simulatorRoot, "recap-2.html"),
        schemas: resolve(simulatorRoot, "schemas.html"),
        ordering: resolve(simulatorRoot, "ordering.html"),
        partitions: resolve(simulatorRoot, "partitions.html"),
        groups: resolve(simulatorRoot, "groups.html"),
        durability: resolve(simulatorRoot, "durability.html"),
        progress: resolve(simulatorRoot, "progress.html"),
        retry: resolve(simulatorRoot, "retry.html"),
        dlq: resolve(simulatorRoot, "dlq.html"),
        idempotency: resolve(simulatorRoot, "idempotency.html"),
        history: resolve(simulatorRoot, "history.html"),
        retriesDlq: resolve(simulatorRoot, "retries-dlq.html"),
        offsetsIdempotency: resolve(simulatorRoot, "offsets-idempotency.html"),
        schemaEvolution: resolve(simulatorRoot, "schema-evolution.html"),
        brokerFailure: resolve(simulatorRoot, "broker-failure.html"),
      },
    },
  },
});

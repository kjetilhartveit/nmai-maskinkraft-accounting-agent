import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "./lib/config.js";
import { solveRouter } from "./routes/solve.js";

const app = new Hono();

// Global error handler
app.onError((err, c) => {
  console.error("[Server] Unhandled error:", err);
  return c.json({
    status: "completed",
    success: false,
    apiCallStats: { total: 0, errors: 0, details: [] },
    elapsedMs: 0,
    error: err instanceof Error ? err.message : String(err),
  }, 200);
});

app.use("*", async (c, next) => {
  const start = performance.now();
  const method = c.req.method;
  const path = c.req.path;
  const ua = c.req.header("User-Agent") ?? "-";
  console.log(`[HTTP] → ${method} ${path} (UA: ${ua})`);
  await next();
  const ms = Math.round(performance.now() - start);
  console.log(`[HTTP] ← ${method} ${path} ${c.res.status} (${ms}ms)`);
});

app.get("/", (c) => {
  return c.json({
    name: "nmai-maskinkraft-accounting-agent",
    status: "running",
    version: "1.0.0",
  });
});

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

app.route("/", solveRouter);

// Also handle POST / directly (competition platform may POST to the endpoint URL root)
app.post("/", async (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/solve";
  const newReq = new Request(url.toString(), c.req.raw);
  return app.fetch(newReq);
});

console.log(`Starting server on port ${config.port}...`);

serve({
  fetch: app.fetch,
  port: config.port,
});

console.log(`Server running at http://localhost:${config.port}`);

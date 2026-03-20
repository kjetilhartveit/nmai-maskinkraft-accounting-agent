import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "./lib/config.js";
import { solveRouter } from "./routes/solve.js";

const app = new Hono();

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

console.log(`Starting server on port ${config.port}...`);

serve({
  fetch: app.fetch,
  port: config.port,
});

console.log(`Server running at http://localhost:${config.port}`);

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Store } from "./store.mjs";
import { createApp } from "./app.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dataDir = resolve(
  process.env.RESEARCH_DATA_DIR || resolve(root, ".data"),
);
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORT must be between 1024 and 65535.");
const store = new Store(resolve(dataDir, "research.sqlite"));
const app = await createApp({
  store,
  dataDir,
  port,
  vaultRoot: process.env.RESEARCH_VAULT || "",
  ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  ...(process.env.ZOTERO_DATA_DIR
    ? { zoteroDir: process.env.ZOTERO_DATA_DIR }
    : {}),
  apiKey: process.env.OPENAI_API_KEY || "",
  model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
});
const server = createServer(app);
let vite;
if (process.argv.includes("--dev")) {
  const { createServer } = await import("vite");
  vite = await createServer({
    root,
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const { default: express } = await import("express");
  if (!existsSync(resolve(root, "dist/index.html")))
    throw new Error("Run npm run build before npm start.");
  app.use(express.static(resolve(root, "dist")));
  app.get("/{*path}", (req, res) =>
    res.sendFile(resolve(root, "dist/index.html")),
  );
}
server.listen(port, "127.0.0.1", () =>
  console.log(`Margin is ready at http://127.0.0.1:${port}`),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  await app.locals.agentHarness?.stop();
  await app.locals.closeIntake?.();
  await vite?.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const source = readFileSync(
  new URL("../obsidian-bridge/main.js", import.meta.url),
  "utf8",
);

function bridge({ buffer = "base", file = "base", open = true } = {}) {
  const acknowledgements = [];
  let editorText = buffer,
    fileText = file,
    saved = 0;
  class MarkdownView {}
  const view = new MarkdownView();
  view.file = { path: "Paper.md" };
  view.editor = {
    getValue: () => editorText,
    replaceRange: (value) => (editorText = value),
    offsetToPos: (offset) => ({ line: 0, ch: offset }),
  };
  view.save = async () => {
    fileText = editorText;
    saved++;
  };
  const module = { exports: {} };
  const job = {
    id: "write-1",
    path: "Paper.md",
    before: "base",
    after: "accepted edit",
    expiresAt: Date.now() + 5000,
    vaultId: "/vault",
  };
  const obsidian = {
    ItemView: class {},
    SuggestModal: class {},
    Plugin: class {},
    PluginSettingTab: class {},
    MarkdownView,
    normalizePath: (path) => path,
    requestUrl: async ({ url, body }) => {
      if (url.endsWith("/bootstrap"))
        return { status: 200, json: { token: "test-token" } };
      if (url.endsWith("/poll")) return { status: 200, json: { jobs: [job] } };
      acknowledgements.push(JSON.parse(body));
      return { status: 200, json: {} };
    },
  };
  vm.runInNewContext(source, {
    module,
    require: (name) =>
      name === "obsidian"
        ? obsidian
        : name === "node:fs"
          ? { realpathSync: () => "/vault" }
          : require(name),
    URL,
    window: {},
    Date,
  });
  const plugin = new module.exports();
  plugin.settings = { url: "http://127.0.0.1:4318" };
  plugin.bridgeClientId = "bridge-client";
  plugin.app = {
    vault: {
      adapter: { getBasePath: () => "/vault" },
      getAbstractFileByPath: () => ({ path: "Paper.md", extension: "md" }),
      read: async () => fileText,
      process: async (_, fn) => (fileText = fn(fileText)),
    },
    workspace: { getLeavesOfType: () => (open ? [{ view }] : []) },
  };
  return {
    plugin,
    acknowledgements,
    get state() {
      return { editorText, fileText, saved };
    },
  };
}
test("bridge never replaces unsaved Obsidian wording", async () => {
  const f = bridge({ buffer: "unsaved researcher text" });
  await f.plugin.coordinateWrites();
  assert.equal(f.acknowledgements[0].ok, false);
  assert.match(f.acknowledgements[0].error, /unsaved/);
  assert.equal(f.state.editorText, "unsaved researcher text");
  assert.equal(f.state.fileText, "base");
});
test("bridge coordinates a clean editor and version-checks unopened files", async () => {
  const f = bridge();
  await f.plugin.coordinateWrites();
  assert.equal(f.acknowledgements[0].ok, true);
  assert.equal(f.state.editorText, "accepted edit");
  assert.equal(f.state.fileText, "accepted edit");
  assert.equal(f.state.saved, 1);
  const closed = bridge({ open: false });
  await closed.plugin.coordinateWrites();
  assert.equal(closed.state.fileText, "accepted edit");
  const changed = bridge({ open: false, file: "new external file" });
  await changed.plugin.coordinateWrites();
  assert.equal(changed.acknowledgements[0].ok, false);
  assert.equal(changed.state.fileText, "new external file");
});

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
class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.children = [];
    this.value = options.value || "";
    this.text = options.text || "";
    this.attrs = options.attr || {};
    this.events = {};
  }
  createEl(tag, options) {
    const child = new Element(tag, options);
    this.children.push(child);
    return child;
  }
  createDiv(options) {
    return this.createEl("div", options);
  }
  empty() {
    this.children = [];
    this.text = "";
  }
  setText(text) {
    this.text = text;
  }
  addClass() {}
  addEventListener(name, fn) {
    this.events[name] = fn;
  }
  hasAttribute(name) {
    return Object.hasOwn(this.attrs, name);
  }
  focus() {
    this.focused = true;
  }
  get options() {
    return this.children.filter((item) => item.tag === "option");
  }
  get selectedOptions() {
    return this.options.filter((item) => item.value === this.value);
  }
}
function fixture({ vault = "/vault", attachments = null } = {}) {
  const requests = [],
    rendered = [],
    leaves = [],
    notices = [];
  const boot = {
    token: "local-token",
    config: {
      vault: { root: vault },
      provider: "ollama",
      model: "local-test",
      chatModels: [{ provider: "ollama", name: "local-test" }],
    },
    sources: [],
    workspaces: [{ id: "workspace", title: "Research" }],
    sessions: [
      {
        id: "session",
        sourceId: "paper",
        workspaceId: "workspace",
        page: 2,
        createdAt: "2026-10-30",
      },
    ],
  };
  const paper = {
    id: "paper",
    kind: "pdf",
    notePath: "Paper.md",
    attachmentId: "pdf-one",
    pageCount: 8,
  };
  const artifacts = [
    {
      id: "old-question",
      runId: "old-run",
      origin: "user",
      text: "Earlier question",
    },
  ];
  let selected;
  class MarkdownView {}
  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.app = leaf.app;
      this.contentEl = new Element();
      this.children = [];
    }
    async setState() {}
    addChild(child) {
      this.children.push(child);
    }
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
    }
  }
  class SuggestModal {
    setPlaceholder() {}
    open() {
      selected = this;
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(`${source}\nmodule.exports.ChatView = MarginChatView;`, {
    module,
    URL,
    Date,
    queueMicrotask,
    window: { setTimeout, clearTimeout, open: () => {} },
    require: (name) =>
      name === "obsidian"
        ? {
            Plugin: class {},
            PluginSettingTab: class {},
            ItemView,
            MarkdownView,
            SuggestModal,
            Notice: class {
              constructor(message) {
                notices.push(message);
              }
            },
            Component: class {},
            normalizePath: (value) => value,
            MarkdownRenderer: {
              render: async (_, text, body) => {
                rendered.push(text);
                body.setText(text);
              },
            },
            requestUrl: async (request) => {
              const path = new URL(request.url).pathname.replace(/^\/api/, "");
              const body = request.body && JSON.parse(request.body);
              requests.push({ ...request, path, body });
              if (path === "/bootstrap") return { status: 200, json: boot };
              if (request.headers["X-Margin-Token"] !== boot.token)
                throw new Error("Missing authentication");
              if (path === "/sources/from-note") {
                if (attachments && !body.attachmentId && !body.noteOnly)
                  return {
                    status: 400,
                    json: { error: "Choose PDF attachment" },
                  };
                return {
                  status: 200,
                  json: body.noteOnly
                    ? { ...paper, kind: "reading-note", pageCount: 1 }
                    : paper,
                };
              }
              if (path === "/zotero/attachments")
                return { status: 200, json: attachments || [] };
              if (path === "/sessions/session")
                return {
                  status: 200,
                  json: { ...boot.sessions[0], artifacts },
                };
              if (path === "/sessions/session/runs" && !body)
                return { status: 200, json: [] };
              if (path === "/sessions/session/runs") {
                artifacts.push({
                  id: "question",
                  runId: "run",
                  origin: "user",
                  text: body.text,
                });
                return { status: 200, json: { id: "run", state: "queued" } };
              }
              if (path === "/runs/run/progress") {
                artifacts.push({
                  id: "answer",
                  runId: "run",
                  origin: "ai",
                  text: "Paper answer {{cite:ev_pdf}}",
                  evidence: [{ id: "ev_pdf", title: "Paper", page: 2 }],
                });
                return {
                  status: 200,
                  json: {
                    run: { id: "run", status: "completed" },
                    events: [
                      { seq: 1, type: "tool.started", name: "source.read" },
                    ],
                    cursor: 1,
                    more: false,
                  },
                };
              }
              throw new Error(`Unexpected request: ${path}`);
            },
          }
        : name === "node:fs"
          ? { realpathSync: (value) => value }
          : require(name),
  });
  const plugin = new module.exports();
  plugin.settings = { url: "http://127.0.0.1:4318" };
  const app = {
    vault: {
      adapter: { getBasePath: () => "/vault" },
      getName: () => "My vault",
      getAbstractFileByPath: (path) => ({ path, extension: "md" }),
    },
    workspace: {
      getLeavesOfType: () => leaves,
      requestSaveLayout() {},
      revealLeaf: async () => {},
    },
  };
  plugin.app = app;
  const view = new module.exports.ChatView({ app }, plugin);
  const editor = new MarkdownView();
  editor.file = { path: "Paper.md" };
  editor.editor = { getValue: () => "Current unsaved interpretation" };
  editor.save = async () => {
    requests.push({ saved: true });
  };
  return {
    plugin,
    view,
    app,
    leaves,
    editor,
    requests,
    rendered,
    boot,
    get picker() {
      return selected;
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("native chat restores a paper session, saves live note buffers per turn, and displays a cited answer", async () => {
  const f = fixture();
  await f.view.onOpen();
  await f.view.setState({ notePath: "Paper.md", sessionId: "session" });
  assert.equal(f.view.session.id, "session");
  assert.match(f.view.contextEl.text, /PDF \(8 pages\)/);
  assert.equal(f.view.pageEl.value, "2");
  assert.ok(f.rendered.includes("Earlier question"));
  f.leaves.push({ view: f.editor });
  f.view.input.value = "Explain my interpretation";
  await f.view.send();
  await flush();
  const sent = f.requests.find(
    (item) => item.body?.text === "Explain my interpretation",
  );
  assert.ok(f.requests.some((item) => item.saved));
  assert.equal(sent.body.anchor.page, 2);
  assert.equal(sent.body.selection.model, "local-test");
  assert.equal(f.view.input.value, "");
  assert.equal(f.view.busy, false);
  assert.match(
    f.rendered.at(-1),
    /\[Paper · p\. 2\]\(http:\/\/127\.0\.0\.1:4318/,
  );
  assert.equal(f.view.getState().notePath, "Paper.md");
  await f.view.onClose();
});

test("chat rejects a mismatched vault before sending its note path or question", async () => {
  const f = fixture({ vault: "/other-vault" });
  await f.view.onOpen();
  await f.view.setState({ notePath: "Paper.md" });
  assert.match(f.view.statusEl.text, /different vault/);
  assert.equal(f.view.sendEl.disabled, true);
  assert.ok(!f.requests.some((item) => item.body));
});

test("ambiguous PDFs require selection and note-only mode is explicitly labelled", async () => {
  const f = fixture({
    attachments: [
      { id: "one", title: "Main paper", available: true },
      { id: "two", title: "Supplement", available: true },
    ],
  });
  await f.view.onOpen();
  const connecting = f.view.setState({ notePath: "Paper.md" });
  await flush();
  assert.equal(f.picker.choices.length, 3);
  f.picker.onChooseSuggestion(f.picker.choices[2]);
  await connecting;
  assert.match(f.view.contextEl.text, /note only · no PDF/);
  assert.ok(f.requests.some((item) => item.body?.noteOnly === true));
  assert.equal(f.view.pageEl.disabled, true);
});

test("sending preserves the draft when saving the note fails", async () => {
  const f = fixture();
  await f.view.onOpen();
  await f.view.setState({ notePath: "Paper.md" });
  f.leaves.push({ view: f.editor });
  f.editor.save = async () => {
    throw new Error("Save failed");
  };
  f.view.input.value = "Keep this question";
  await f.view.send();
  assert.equal(f.view.input.value, "Keep this question");
  assert.match(f.view.statusEl.text, /Save failed/);
  assert.ok(!f.requests.some((item) => item.body?.text));
});

test("note-only chat resumes history after the note import changes", async () => {
  const f = fixture();
  const original = {
    id: "old-note",
    notePath: "Paper.md",
    kind: "reading-note",
    pageCount: 1,
  };
  f.boot.sources.push(original);
  f.boot.sessions[0].sourceId = original.id;
  f.view.source = original;
  await f.view.onOpen();
  await f.view.setState({ notePath: "Paper.md", sessionId: "session" });
  assert.equal(f.view.session.id, "session");
  assert.equal(f.view.source.id, "old-note");
  assert.ok(f.rendered.includes("Earlier question"));
  assert.equal(f.view.pageEl.value, "1");
});

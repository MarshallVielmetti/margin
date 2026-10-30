const {
  Plugin,
  MarkdownView,
  Notice,
  normalizePath,
  PluginSettingTab,
  Setting,
  requestUrl,
  ItemView,
  SuggestModal,
  MarkdownRenderer,
  Component,
} = require("obsidian");

const CHAT_VIEW = "margin-agent-chat";
const terminalRun = (run) =>
  ["completed", "partial", "failed", "cancelled", "awaiting_user"].includes(
    run.state || run.status,
  );

function marginOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("Set a local Margin URL in plugin settings.");
  return url.origin;
}

class PdfChoice extends SuggestModal {
  constructor(app, choices, resolve) {
    super(app);
    this.choices = choices;
    this.resolve = resolve;
    this.setPlaceholder("Choose PDF context for Margin");
  }
  getSuggestions(query) {
    return this.choices.filter((item) =>
      item.label.toLowerCase().includes(query.toLowerCase()),
    );
  }
  renderSuggestion(item, el) {
    el.setText(item.label);
  }
  onChooseSuggestion(item) {
    this.chosen = true;
    this.resolve(item);
  }
  onClose() {
    // SuggestModal closes before invoking onChooseSuggestion.
    queueMicrotask(() => {
      if (!this.chosen) this.resolve(null);
    });
  }
}

function readHeadingPath(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length &&
      parsed.every((part) => typeof part === "string")
    )
      return parsed;
  } catch {
    // Older callers may send a single heading name.
  }
  return [String(value)];
}

function headingPathAt(headings, targetIndex) {
  const stack = [];
  for (let i = 0; i <= targetIndex; i++) {
    const heading = headings[i];
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
    stack.push({ title: heading.heading, level: heading.level });
  }
  return stack.map((entry) => entry.title);
}

function matchingHeadingLine(cache, params) {
  const headings = cache?.headings || [];
  const requestedPath = readHeadingPath(params.headingPath);
  const matches = headings
    .map((heading, index) => ({ heading, index }))
    .filter(({ heading, index }) => {
      if (requestedPath) {
        return (
          JSON.stringify(headingPathAt(headings, index)) ===
          JSON.stringify(requestedPath)
        );
      }
      return (
        params.heading &&
        heading.heading.toLocaleLowerCase() ===
          String(params.heading).toLocaleLowerCase()
      );
    });
  if (!matches.length) return null;
  const lineHint = Math.max(0, (Number(params.line) || 1) - 1);
  const selected = matches.reduce((best, candidate) => {
    const candidateLine = candidate.heading.position.start.line;
    const bestLine = best.heading.position.start.line;
    return Math.abs(candidateLine - lineHint) < Math.abs(bestLine - lineHint)
      ? candidate
      : best;
  });
  return selected.heading.position.start.line + 1;
}

function blockLine(cache, params, content = "") {
  const blockId = params.blockId || params.block || "";
  if (!blockId) return null;
  const key = blockId.startsWith("^") ? blockId : `^${blockId}`;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = String(content)
    .split(/\r?\n/)
    .flatMap((line, index) =>
      new RegExp(`(?:^|\\s)${escaped}\\s*$`, "u").test(line) ? [index + 1] : [],
    );
  if (matches.length) {
    const lineHint = Math.max(1, Number(params.line) || 1);
    return matches.reduce((best, line) =>
      Math.abs(line - lineHint) < Math.abs(best - lineHint) ? line : best,
    );
  }
  const block = cache?.blocks?.[key];
  return Number.isInteger(block?.position?.start?.line)
    ? block.position.start.line + 1
    : null;
}

module.exports = class MarginBridge extends Plugin {
  async onload() {
    this.settings = {
      url: "http://127.0.0.1:4317",
      ...(await this.loadData()),
    };
    this.addSettingTab(new MarginSettings(this.app, this));
    this.registerView(CHAT_VIEW, (leaf) => new MarginChatView(leaf, this));
    this.addCommand({
      id: "chat-with-margin",
      name: "Chat with Margin",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking)
          void this.openChat(view).catch(
            (error) => new Notice(`Margin: ${error.message}`),
          );
        return true;
      },
    });
    this.bridgeClientId = require("node:crypto").randomUUID();
    this.writePolling = false;
    this.registerInterval(
      window.setInterval(() => void this.coordinateWrites(), 1500),
    );
    void this.coordinateWrites();
    this.addCommand({
      id: "open-literature-note-in-margin",
      name: "Open literature note in Margin",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking) {
          void (async () => {
            await view.save();
            const url = new URL(this.settings.url);
            if (
              url.protocol !== "http:" ||
              !["127.0.0.1", "localhost"].includes(url.hostname)
            )
              throw new Error("Set a local Margin URL in plugin settings.");
            url.search = "";
            url.searchParams.set("note", view.file.path);
            window.open(url.href);
          })().catch((e) => new Notice(`Margin: ${e.message}`));
        }
        return true;
      },
    });
    this.registerObsidianProtocolHandler("margin", async (params) => {
      if (params.vault && params.vault !== this.app.vault.getName()) return;
      const path = normalizePath(params.file || "");
      if (
        !path ||
        path.split("/").some((part) => part.startsWith(".")) ||
        !path.endsWith(".md")
      ) {
        new Notice("Margin: choose an existing Markdown note.");
        return;
      }
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file || !("extension" in file)) {
        new Notice("Margin: note not found.");
        return;
      }
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file, { active: true });
      await this.app.workspace.revealLeaf(leaf);
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      await view.setState({ ...view.getState(), mode: "source" });
      const cache = this.app.metadataCache.getFileCache(file);
      const headingLine = matchingHeadingLine(cache, params);
      const requested =
        blockLine(cache, params, view.editor.getValue()) ??
        headingLine ??
        Math.max(1, Number(params.line) || 1);
      const line = Math.min(
        Math.max(0, requested - 1),
        view.editor.lineCount() - 1,
      );
      view.editor.setCursor({ line, ch: 0 });
      view.editor.scrollIntoView(
        { from: { line, ch: 0 }, to: { line, ch: 0 } },
        true,
      );
      view.editor.focus();
    });
    this.addCommand({
      id: "return-to-margin-session",
      name: "Return to this note’s latest research session",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        const urls = [
          ...view.editor
            .getValue()
            .matchAll(
              /\[Return to this session\]\((http:\/\/127\.0\.0\.1:\d+\/\?session=[a-zA-Z0-9%-]+)\)/g,
            ),
        ];
        if (!urls.length) return false;
        if (!checking) window.open(urls.at(-1)[1]);
        return true;
      },
    });
  }

  async openChat(view) {
    await view.save();
    const path = view.file.path;
    const existing = this.app.workspace
      .getLeavesOfType(CHAT_VIEW)
      .find((leaf) => leaf.view.notePath === path);
    const leaf = existing || this.app.workspace.getLeaf("split");
    if (!existing)
      await leaf.setViewState({
        type: CHAT_VIEW,
        active: true,
        state: { notePath: path },
      });
    await this.app.workspace.revealLeaf(leaf);
    leaf.view.input?.focus();
  }

  async chatClient() {
    const origin = marginOrigin(this.settings.url);
    const response = await requestUrl({
      url: `${origin}/api/bootstrap`,
      throw: false,
    });
    if (response.status !== 200)
      throw new Error("Start Margin, then reconnect.");
    const boot = response.json;
    const root = this.app.vault.adapter.getBasePath?.();
    const fs = require("node:fs");
    if (
      !root ||
      !boot.config.vault.root ||
      fs.realpathSync(root) !== fs.realpathSync(boot.config.vault.root)
    )
      throw new Error(
        "Margin is connected to a different vault. Choose this vault in Margin Settings, then reconnect.",
      );
    const call = async (path, body) => {
      const result = await requestUrl({
        url: `${origin}/api${path}`,
        method: body === undefined ? "GET" : "POST",
        headers: {
          "X-Margin-Token": boot.token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        throw: false,
      });
      if (result.status !== 200)
        throw new Error(
          result.json?.error || `Margin request failed (${result.status}).`,
        );
      return result.json;
    };
    return { boot, call, origin };
  }

  async saveChatNote(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || file.extension !== "md")
      throw new Error(
        "This note was renamed or deleted. Open Chat with Margin from its current note.",
      );
    const views = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter(
        (view) => view instanceof MarkdownView && view.file?.path === path,
      );
    if (new Set(views.map((view) => view.editor.getValue())).size > 1)
      throw new Error(
        "Open editors disagree about this note. Save the intended version before chatting.",
      );
    for (const view of views) await view.save();
  }

  async coordinateWrites() {
    if (this.writePolling) return;
    this.writePolling = true;
    try {
      const url = new URL(this.settings.url);
      if (
        url.protocol !== "http:" ||
        !["127.0.0.1", "localhost"].includes(url.hostname)
      )
        return;
      const root = this.app.vault.adapter.getBasePath?.();
      if (!root) return;
      const vaultId = require("node:fs").realpathSync(root);
      const bootstrap = await requestUrl({
        url: `${url.origin}/api/bootstrap`,
        throw: false,
      });
      if (bootstrap.status !== 200) return;
      const token = bootstrap.json.token;
      const post = async (path, body) =>
        requestUrl({
          url: `${url.origin}/api${path}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Margin-Token": token,
          },
          body: JSON.stringify(body),
          throw: false,
        });
      const poll = await post("/bridge/poll", {
        clientId: this.bridgeClientId,
        vaultId,
      });
      if (poll.status !== 200) return;
      for (const job of poll.json.jobs) {
        let ok = false,
          error = "";
        try {
          if (Date.now() >= job.expiresAt || job.vaultId !== vaultId) continue;
          const path = normalizePath(job.path);
          if (
            !path.endsWith(".md") ||
            path.split("/").some((p) => p.startsWith("."))
          )
            throw new Error("Invalid note path.");
          const file = this.app.vault.getAbstractFileByPath(path);
          const views = this.app.workspace
            .getLeavesOfType("markdown")
            .map((leaf) => leaf.view)
            .filter(
              (view) =>
                view instanceof MarkdownView && view.file?.path === path,
            );
          // A dirty editor is never replaced. The user can save it, then Margin
          // will merge its file revision before requesting another write.
          if (views.some((view) => view.editor.getValue() !== job.before))
            throw new Error(
              "This note has an unsaved Obsidian buffer. Save it in Obsidian and retry sync in Margin.",
            );
          if (job.create) {
            if (file) throw new Error("The destination already exists.");
            await this.app.vault.create(path, job.after);
          } else if (!file || !("extension" in file))
            throw new Error(
              "The note was renamed or deleted. Relink it in Margin.",
            );
          else if (views.length) {
            // All checks and editor transactions run without an asynchronous gap.
            if ((await this.app.vault.read(file)) !== job.before)
              throw new Error(
                "The vault file changed. Retry sync to merge it.",
              );
            if (views.some((view) => view.editor.getValue() !== job.before))
              throw new Error(
                "The Obsidian buffer changed. Save it and retry sync.",
              );
            if (Date.now() >= job.expiresAt)
              throw new Error("This coordinated write expired. Retry sync.");
            for (const view of views) {
              if (view.editor.getValue() === job.after) continue;
              if (view.editor.getValue() !== job.before)
                throw new Error(
                  "An Obsidian buffer changed during coordination. Save it and retry sync.",
                );
              view.editor.replaceRange(
                job.after,
                { line: 0, ch: 0 },
                view.editor.offsetToPos(job.before.length),
              );
            }
            await views[0].save();
          } else
            await this.app.vault.process(file, (current) => {
              if (current !== job.before)
                throw new Error(
                  "The vault file changed. Retry sync to merge it.",
                );
              if (Date.now() >= job.expiresAt)
                throw new Error("This coordinated write expired. Retry sync.");
              return job.after;
            });
          ok = true;
        } catch (failure) {
          error = failure.message;
        }
        await post(`/bridge/writes/${job.id}/ack`, {
          clientId: this.bridgeClientId,
          ok,
          error,
        });
      }
    } catch {
      /* Margin may be stopped; the local note remains fully editable. */
    } finally {
      this.writePolling = false;
    }
  }
};

class MarginChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.notePath = "";
    this.cursor = 0;
    this.renderers = [];
  }
  getViewType() {
    return CHAT_VIEW;
  }
  getDisplayText() {
    return `Margin · ${this.notePath.split("/").pop() || "Chat"}`;
  }
  getIcon() {
    return "terminal";
  }
  getState() {
    return {
      notePath: this.notePath,
      sessionId: this.session?.id || this.restoredSessionId,
    };
  }
  async setState(state, result) {
    this.notePath = state.notePath || "";
    this.restoredSessionId = state.sessionId;
    await super.setState(state, result);
    if (this.statusEl && this.notePath) await this.connect();
  }
  async onOpen() {
    this.closed = false;
    const root = this.contentEl;
    root.empty();
    root.addClass("margin-chat");
    const header = root.createDiv({ cls: "margin-chat-header" });
    header.createEl("strong", { text: ">_ Margin" });
    this.contextEl = header.createDiv({ cls: "margin-chat-context" });
    const controls = root.createDiv({ cls: "margin-chat-controls" });
    this.modelEl = controls.createEl("select", {
      attr: { "aria-label": "Margin model" },
    });
    const pageLabel = controls.createEl("label", { text: "PDF page " });
    this.pageEl = pageLabel.createEl("input", {
      type: "number",
      attr: { min: "1", "aria-label": "PDF context page" },
    });
    this.pageEl.value = "1";
    const open = controls.createEl("button", { text: "Open in Margin" });
    open.addEventListener("click", () => {
      if (this.client && this.session)
        window.open(
          `${this.client.origin}/?session=${encodeURIComponent(this.session.id)}`,
        );
    });
    this.reconnectEl = controls.createEl("button", { text: "Reconnect" });
    this.reconnectEl.addEventListener("click", () => void this.connect());
    this.statusEl = root.createDiv({
      cls: "margin-chat-status",
      attr: { role: "status" },
    });
    this.transcriptEl = root.createDiv({
      cls: "margin-chat-transcript",
      attr: { role: "log", "aria-label": "Margin conversation" },
    });
    this.activityEl = root.createDiv({
      cls: "margin-chat-activity",
      attr: { role: "status" },
    });
    this.draftEl = root.createEl("pre", { cls: "margin-chat-stream" });
    const composer = root.createDiv({ cls: "margin-chat-composer" });
    this.input = composer.createEl("textarea", {
      attr: {
        placeholder: "Ask about this paper or your literature note…",
        "aria-label": "Message Margin",
        rows: "3",
      },
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send();
      }
    });
    const buttons = composer.createDiv({ cls: "margin-chat-controls" });
    this.sendEl = buttons.createEl("button", { text: "Send", cls: "mod-cta" });
    this.sendEl.addEventListener("click", () => void this.send());
    this.stopEl = buttons.createEl("button", { text: "Stop" });
    this.stopEl.addEventListener("click", () => void this.stop());
    buttons.createEl("small", {
      text: "Enter to send · Shift+Enter for a new line",
    });
    this.setBusy(false);
    this.sendEl.disabled = true;
    this.statusEl.setText("Open a literature note and run Chat with Margin.");
    if (this.notePath) await this.connect();
  }
  setBusy(busy) {
    this.busy = busy;
    this.sendEl.disabled = busy || !this.session;
    this.modelEl.disabled = busy;
    this.pageEl.disabled = busy || this.source?.kind !== "pdf";
    this.reconnectEl.disabled = busy;
    this.stopEl.disabled = !this.activeRun;
  }
  async connect() {
    if (this.busy || this.closed || !this.notePath) return;
    this.setBusy(true);
    this.statusEl.setText("Connecting to Margin and resolving paper context…");
    try {
      await this.plugin.saveChatNote(this.notePath);
      this.client = await this.plugin.chatClient();
      const { boot, call } = this.client;
      let choice =
        this.source?.kind === "reading-note"
          ? { noteOnly: true }
          : this.source?.attachmentId
            ? { attachmentId: this.source.attachmentId }
            : {};
      // Resolve ambiguous attachments explicitly; never substitute note text for
      // an unavailable PDF without the reader choosing that mode.
      try {
        this.source = await call("/sources/from-note", {
          path: this.notePath,
          ...choice,
        });
      } catch (initialError) {
        if (this.source) throw initialError;
        {
          let attachments = [],
            problem = "";
          try {
            attachments = await call(
              `/zotero/attachments?path=${encodeURIComponent(this.notePath)}`,
            );
          } catch (error) {
            problem = error.message;
          }
          const available = attachments.filter((item) => item.available);
          if (available.length === 1)
            choice = { attachmentId: available[0].id };
          else {
            this.statusEl.setText(
              problem ||
                (available.length
                  ? "Choose the paper to discuss."
                  : "No available Zotero PDF. Attach the PDF in Zotero and reconnect, or choose note-only chat."),
            );
            const choices = [
              ...available.map((item) => ({
                label: item.title || item.filename || item.id,
                attachmentId: item.id,
              })),
              {
                label: "Chat with literature note only (no PDF)",
                noteOnly: true,
              },
            ];
            const picked = await new Promise((resolve) =>
              new PdfChoice(this.app, choices, resolve).open(),
            );
            if (!picked)
              throw new Error("PDF selection cancelled. Reconnect when ready.");
            choice = picked.noteOnly
              ? { noteOnly: true }
              : { attachmentId: picked.attachmentId };
          }
        }
        this.source = await call("/sources/from-note", {
          path: this.notePath,
          ...choice,
        });
      }
      if (this.closed) return;
      const sourceIds = new Set(
        this.source.kind === "reading-note"
          ? boot.sources
              .filter(
                (item) =>
                  item.kind === "reading-note" &&
                  item.notePath === this.notePath,
              )
              .map((item) => item.id)
          : [this.source.id],
      );
      sourceIds.add(this.source.id);
      const candidates = boot.sessions.filter((item) =>
        sourceIds.has(item.sourceId),
      );
      this.session =
        candidates.find(
          (item) => item.id === (this.session?.id || this.restoredSessionId),
        ) ||
        candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!this.session) {
        if (!boot.workspaces.length)
          throw new Error("Create a workspace in Margin first.");
        this.session = await call("/sessions", {
          sourceId: this.source.id,
          workspaceId: boot.workspaces[0].id,
        });
      }
      if (this.session.sourceId !== this.source.id)
        this.source =
          boot.sources.find((item) => item.id === this.session.sourceId) ||
          this.source;
      this.restoredSessionId = this.session.id;
      this.app.workspace.requestSaveLayout();
      this.pageEl.max = String(this.source.pageCount);
      this.pageEl.value = String(
        Math.min(this.source.pageCount, this.session.page || 1),
      );
      const selected =
        this.modelEl.value ||
        JSON.stringify({
          provider: boot.config.provider,
          model: boot.config.model,
        });
      this.modelEl.empty();
      for (const model of boot.config.chatModels) {
        const value = JSON.stringify({
          provider: model.provider,
          model: model.name,
        });
        this.modelEl.createEl("option", {
          value,
          text: `${model.name} · ${model.cloud || model.provider === "openai" ? "cloud" : "local"}`,
        });
      }
      // Preserve the configured default even when offline, rather than silently
      // selecting another provider. Bibliography queries still work offline.
      if (![...this.modelEl.options].some((item) => item.value === selected))
        this.modelEl.createEl("option", {
          value: selected,
          text: `${JSON.parse(selected).model || "Configured model"} · unavailable`,
          attr: { "data-unavailable": "true" },
        });
      this.modelEl.value = selected;
      this.contextEl.setText(
        `${this.notePath} + ${this.source.kind === "pdf" ? `PDF (${this.source.pageCount} pages)` : "note only · no PDF"}`,
      );
      await this.loadHistory();
      const runs = await call(`/sessions/${this.session.id}/runs`);
      const active = runs.find((run) => !terminalRun(run));
      if (active) {
        this.activeRun = active;
        this.cursor = 0;
        this.setBusy(true);
        this.statusEl.setText("Reconnected to the running agent.");
        void this.poll();
      } else {
        this.activeRun = null;
        this.statusEl.setText(
          `Ready · ${boot.workspaces.find((item) => item.id === this.session.workspaceId)?.title || "Margin session"} · note refreshed before each turn`,
        );
        this.setBusy(false);
      }
    } catch (error) {
      if (!this.closed) {
        this.statusEl.setText(`${error.message} Use Reconnect to retry.`);
        this.setBusy(false);
        this.sendEl.disabled = true;
      }
    }
  }
  async loadHistory() {
    const session = await this.client.call(`/sessions/${this.session.id}`);
    if (this.closed) return;
    for (const renderer of this.renderers) this.removeChild(renderer);
    this.renderers = [];
    this.transcriptEl.empty();
    for (const artifact of session.artifacts.filter((item) => item.runId)) {
      const entry = this.transcriptEl.createDiv({ cls: "margin-chat-entry" });
      entry.createEl("small", {
        text: artifact.origin === "user" ? "> you" : "> margin",
      });
      const body = entry.createDiv();
      const evidence = artifact.evidence || [];
      const text = String(artifact.text || "").replace(
        /\{\{cite:([^}]+)\}\}/g,
        (_, handle) => {
          const item = evidence.find((item) =>
            [item.id, item.handle, ...(item.handles || [])].includes(handle),
          );
          if (!item) return "[citation unavailable]";
          const label =
            `${item.title || "Source"}${item.page ? ` · p. ${item.page}` : ""}`.replace(
              /[\[\]\\]/g,
              "",
            );
          const target = item.path
            ? `obsidian://open?vault=${encodeURIComponent(this.app.vault.getName())}&file=${encodeURIComponent(item.path)}`
            : item.sourceId === this.source.id && this.source.kind === "pdf"
              ? `${this.client.origin}/api/sources/${encodeURIComponent(item.sourceId)}/file#page=${item.page || 1}`
              : `${this.client.origin}/?session=${encodeURIComponent(session.id)}`;
          return `[${label}](${target})`;
        },
      );
      const renderer = new Component();
      this.addChild(renderer);
      this.renderers.push(renderer);
      await MarkdownRenderer.render(
        this.app,
        text,
        body,
        this.notePath,
        renderer,
      );
    }
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }
  async send() {
    if (this.busy || !this.session || !this.input.value.trim()) return;
    const text = this.input.value.trim();
    this.setBusy(true);
    this.statusEl.setText("Saving note and starting Margin…");
    try {
      await this.plugin.saveChatNote(this.notePath);
      // Revalidate the vault and token before every question, including after a
      // server restart or a settings change in the browser.
      const current = await this.plugin.chatClient();
      if (current.origin !== this.client.origin)
        throw new Error("Margin URL changed. Reconnect before sending.");
      this.client = current;
      const page = Number(this.pageEl.value);
      if (!Number.isInteger(page) || page < 1 || page > this.source.pageCount)
        throw new Error("Choose a valid PDF page.");
      if (!this.pending || this.pending.text !== text)
        this.pending = {
          text,
          idempotencyKey: require("node:crypto").randomUUID(),
        };
      const run = await this.client.call(`/sessions/${this.session.id}/runs`, {
        ...this.pending,
        mode: "discuss",
        anchor: { sourceId: this.source.id, page, quote: "" },
        ...(this.modelEl.selectedOptions[0]?.hasAttribute("data-unavailable")
          ? {}
          : { selection: JSON.parse(this.modelEl.value) }),
        budgets: { contextTokens: 32768 },
      });
      this.pending = null;
      this.activeRun = run;
      this.cursor = 0;
      this.streamText = "";
      this.input.value = "";
      await this.loadHistory();
      this.setBusy(true);
      void this.poll();
    } catch (error) {
      this.statusEl.setText(error.message);
      this.setBusy(false);
    }
  }
  async poll() {
    try {
      while (!this.closed && this.activeRun) {
        const { run, events, cursor, more } = await this.client.call(
          `/runs/${this.activeRun.id}/progress?after=${this.cursor}`,
        );
        if (this.closed) return;
        this.cursor = cursor;
        for (const event of events) {
          const data = event.data || event;
          if (["text.delta", "answer.delta"].includes(event.type)) {
            this.streamText =
              `${this.streamText || ""}${data.delta || ""}`.slice(-30000);
            this.draftEl.setText(this.streamText);
          }
          if (event.type === "tool.started")
            this.activityEl.setText(
              `$ ${data.name || "Reading context"}${data.message ? ` · ${data.message}` : ""}`,
            );
          if (event.type === "model.started")
            this.activityEl.setText(
              `$ ${data.model || "Margin"} is responding…`,
            );
        }
        this.statusEl.setText(`Margin · ${run.state || run.status}`);
        if (terminalRun(run) && !more) {
          await this.loadHistory();
          this.activeRun = null;
          this.draftEl.empty();
          this.activityEl.empty();
          this.statusEl.setText(
            `Margin · ${run.state || run.status}${run.error ? ` · ${run.error.message || run.error}` : ""}`,
          );
          this.setBusy(false);
          this.input.focus();
          return;
        }
        if (!more)
          await new Promise((resolve) => {
            this.wakePoll = resolve;
            this.pollTimer = window.setTimeout(() => {
              this.wakePoll = null;
              resolve();
            }, 800);
          });
      }
    } catch (error) {
      if (!this.closed) {
        this.statusEl.setText(
          `Connection interrupted: ${error.message} Reconnect to resume the saved run.`,
        );
        this.setBusy(false);
        this.sendEl.disabled = true;
      }
    }
  }
  async stop() {
    if (!this.activeRun) return;
    this.stopEl.disabled = true;
    try {
      await this.client.call(`/runs/${this.activeRun.id}/cancel`, {});
    } catch (error) {
      this.statusEl.setText(error.message);
      this.stopEl.disabled = false;
    }
  }
  async onClose() {
    this.closed = true;
    window.clearTimeout(this.pollTimer);
    this.wakePoll?.();
    for (const renderer of this.renderers) this.removeChild(renderer);
    this.renderers = [];
  }
}

class MarginSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Margin URL")
      .setDesc(
        "Start Margin first. Use its local address, normally http://127.0.0.1:4317.",
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.url).onChange(async (value) => {
          this.plugin.settings.url = value.trim();
          await this.plugin.saveData(this.plugin.settings);
        }),
      );
  }
}

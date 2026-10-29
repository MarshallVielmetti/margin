const {
  Plugin,
  MarkdownView,
  Notice,
  normalizePath,
  PluginSettingTab,
  Setting,
} = require("obsidian");

module.exports = class MarginBridge extends Plugin {
  async onload() {
    this.settings = {
      url: "http://127.0.0.1:4317",
      ...(await this.loadData()),
    };
    this.addSettingTab(new MarginSettings(this.app, this));
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
      const heading = (
        this.app.metadataCache.getFileCache(file)?.headings || []
      ).find(
        (h) => h.heading.toLowerCase() === (params.heading || "").toLowerCase(),
      );
      const requested = heading
        ? heading.position.start.line + 1
        : Math.max(0, (Number(params.line) || 1) - 1);
      const line = Math.min(requested, view.editor.lineCount() - 1);
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
};

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

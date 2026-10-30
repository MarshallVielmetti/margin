import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { digest, safeNotePath, parseNote } from "./vault.mjs";
import { atomicNoteWrite } from "./note-files.mjs";
import { mergeMarkdown } from "./document-merge.mjs";

export const documentError = (message, status = 409, details = {}) =>
  Object.assign(new Error(message), { status, ...details });
export function artifactRevision(artifact) {
  return `${artifact.id}:${digest(JSON.stringify({ text: artifact.text, anchor: artifact.anchor, assumptions: artifact.assumptions })).slice(0, 20)}`;
}
export function documentBlocks(markdown, revision) {
  const frontmatter =
    markdown.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length || 0;
  const blocks = [];
  if (frontmatter) {
    const note = parseNote("note.md", markdown);
    if (
      Object.hasOwn(note.metadata, "summary") &&
      !note.headings.some((h) => /^summary$/i.test(h.title))
    )
      blocks.push({
        id: `summary:${revision}:${digest(markdown.slice(0, frontmatter)).slice(0, 12)}`,
        start: 0,
        end: frontmatter,
        text: markdown.slice(0, frontmatter),
        section: "Summary",
        summaryProperty: true,
        summary: String(note.metadata.summary || ""),
      });
  }
  let section = "Note",
    start = null,
    offset = frontmatter,
    fence = null,
    math = false;
  const flush = (end) => {
    if (start === null) return;
    const text = markdown.slice(start, end).replace(/\r?\n$/, "");
    const heading = text.match(/^#{1,6}\s+(.+?)(?:\r?\n|$)/);
    if (heading) section = heading[1];
    if (text)
      blocks.push({
        id: `block:${revision}:${start}:${digest(text).slice(0, 12)}`,
        start,
        end: start + text.length,
        text,
        section,
      });
    start = null;
  };
  // Keep fenced code and display mathematics intact even across blank lines.
  for (const line of markdown.slice(frontmatter).match(/[^\n]*\n|[^\n]+$/g) ||
    []) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && !math && /^\s*$/.test(line)) flush(offset);
    else {
      if (start === null) start = offset;
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length)
          fence = null;
      } else if (!fence && (line.match(/\$\$/g) || []).length % 2) math = !math;
    }
    offset += line.length;
  }
  flush(markdown.length);
  return blocks;
}

export class Documents {
  constructor({ store, getVault, onWritten }) {
    this.store = store;
    this.getVault = getVault;
    this.onWritten = onWritten;
    this.locks = new Map();
    this.bridgeClients = new Map();
  }
  vaultIdentity() {
    const root = this.getVault().root;
    if (!root) return "";
    try {
      return realpathSync(root);
    } catch {
      return resolve(root);
    }
  }
  get(id) {
    const document = this.store.get("literatureDocument", id);
    if (!document) throw documentError("Literature document not found.", 404);
    return document;
  }
  async serial(id, work) {
    const before = this.locks.get(id) || Promise.resolve();
    const promise = before.catch(() => {}).then(work);
    this.locks.set(id, promise);
    try {
      return await promise;
    } finally {
      if (this.locks.get(id) === promise) this.locks.delete(id);
    }
  }
  async forSource(source) {
    const vaultId = this.vaultIdentity();
    const keys = [
      `source:${source.id}`,
      ...["citekey", "attachmentId", "zotero"].flatMap((key) =>
        source[key] ? [`${key}:${source[key]}`] : [],
      ),
      ...(source.notePath ? [`note:${source.notePath}`] : []),
    ];
    const matches = this.store
      .list("literatureDocument")
      .filter(
        (d) =>
          (d.vaultId === vaultId ||
            (!vaultId && d.sourceIds.includes(source.id))) &&
          (d.paperKeys.some((k) => keys.includes(k)) ||
            (source.notePath && d.notePath === source.notePath)),
      );
    if (matches.length > 1)
      throw documentError(
        "Several literature documents match this paper. Relink the intended note in Synthesis.",
      );
    if (matches[0]) {
      const current = matches[0];
      return this.serial(current.id, async () => {
        const latest = this.get(current.id);
        this.store.put("literatureDocument", {
          ...latest,
          sourceIds: [...new Set([...latest.sourceIds, source.id])],
          paperKeys: [...new Set([...latest.paperKeys, ...keys])],
        });
        return this.refreshVault(current.id);
      });
    }
    let markdown = "",
      notePath = "",
      syncedHash = null;
    if (vaultId && source.notePath) {
      try {
        const file = await safeNotePath(vaultId, source.notePath);
        markdown = readFileSync(file, "utf8");
        notePath = source.notePath;
        syncedHash = digest(markdown);
      } catch {
        /* A missing association stays a local draft until explicitly relinked. */
      }
    }
    return this.store.transaction(() => {
      const raced = this.store
        .list("literatureDocument")
        .find(
          (d) =>
            d.vaultId === vaultId && d.paperKeys.some((k) => keys.includes(k)),
        );
      if (raced)
        return this.store.put("literatureDocument", {
          ...raced,
          sourceIds: [...new Set([...raced.sourceIds, source.id])],
          paperKeys: [...new Set([...raced.paperKeys, ...keys])],
        });
      const doc = this.store.put("literatureDocument", {
        schemaVersion: 1,
        vaultId,
        notePath,
        title: source.title,
        paperKeys: keys,
        sourceIds: [source.id],
        markdown,
        revision: 0,
        syncedRevision: 0,
        syncedMarkdown: markdown,
        syncedHash,
        syncEnabled: false,
        syncMethod: "bridge",
        syncStatus: "local",
        conflict: null,
        organizeAsRead: false,
        organizationModel: "",
        legacyOffered: false,
        createdAt: new Date().toISOString(),
      });
      this.store.put("documentRevision", {
        documentId: doc.id,
        revision: 0,
        parentRevision: null,
        before: markdown,
        markdown,
        attribution: { origin: notePath ? "vault-import" : "user" },
        createdAt: doc.createdAt,
      });
      return doc;
    });
  }
  view(id) {
    const document = this.get(id);
    const contributions = this.store
      .list("contribution")
      .filter((c) => c.documentId === id);
    const inputs = this.store
      .list("artifact")
      .filter(
        (a) =>
          document.sourceIds.includes(
            this.store.get("session", a.sessionId)?.sourceId,
          ) &&
          a.origin === "user" &&
          (a.kind !== "question" || a.surface === "thoughts"),
      );
    const consumed = new Set(
      contributions
        .filter((c) => ["pending", "accepted", "dismissed"].includes(c.state))
        .map((c) => c.artifactRevisionId),
    );
    return {
      schemaVersion: 1,
      document,
      blocks: documentBlocks(document.markdown, document.revision),
      suggestions: this.store
        .list("synthesisSuggestion")
        .filter((s) => s.documentId === id),
      pending: inputs
        .filter((a) => !consumed.has(artifactRevision(a)))
        .map((a) => ({ ...a, artifactRevisionId: artifactRevision(a) })),
      revisions: this.store
        .list("documentRevision")
        .filter((r) => r.documentId === id)
        .sort((a, b) => b.revision - a.revision),
      run:
        this.store
          .list("synthesisRun")
          .filter((r) => r.documentId === id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null,
    };
  }
  async refreshVault(id) {
    const doc = this.get(id);
    if (!doc.notePath || doc.vaultId !== this.vaultIdentity()) return doc;
    try {
      const file = await safeNotePath(doc.vaultId, doc.notePath);
      const external = readFileSync(file, "utf8"),
        hash = digest(external);
      if (hash === doc.syncedHash || doc.conflict?.externalHash === hash)
        return doc;
      const merged = mergeMarkdown(doc.syncedMarkdown, doc.markdown, external);
      return this.store.reviseDocument(
        id,
        doc.revision,
        merged.text,
        { origin: "external-refresh" },
        {
          conflict: merged.conflicts.length
            ? { ...merged, external, externalHash: hash }
            : null,
          ...(merged.conflicts.length
            ? {}
            : { syncedMarkdown: external, syncedHash: hash }),
          syncStatus: merged.conflicts.length ? "conflict" : "local",
          syncError: "",
        },
      );
    } catch (error) {
      return this.store.put("literatureDocument", {
        ...doc,
        syncStatus: "offline",
        syncError: `The literature note is unavailable (${error.message}). Relink or restore it; your local revision is retained.`,
      });
    }
  }
  async save(id, expectedRevision, markdown, attribution = { origin: "user" }) {
    return this.serial(id, () => {
      const current = this.get(id);
      if (current.conflict)
        throw documentError(
          "Resolve the overlapping vault blocks before editing the document.",
          409,
          { current },
        );
      return this.store.reviseDocument(
        id,
        expectedRevision,
        markdown,
        attribution,
        { syncStatus: "local" },
      );
    });
  }
  async bind(id, input) {
    return this.serial(id, async () => {
      const doc = this.get(id),
        root = this.vaultIdentity();
      if (!root)
        throw documentError(
          "Connect a vault in Settings before linking a note.",
          400,
        );
      if (input.expectedRevision !== doc.revision)
        throw documentError(
          "The document changed. Reload the connection before relinking.",
        );
      const file = await safeNotePath(root, input.path, {
        allowNew: input.create,
      });
      const duplicate = this.store
        .list("literatureDocument")
        .find(
          (d) => d.id !== id && d.vaultId === root && d.notePath === input.path,
        );
      if (duplicate)
        throw documentError(
          "This note is already connected to another literature document. Open its paper to continue.",
        );
      const exists = existsSync(file);
      if (input.create && exists)
        throw documentError(
          "This note already exists. Choose it as an existing note.",
        );
      if (!input.create && !exists)
        throw documentError(
          "The note is missing. Choose an existing note or explicitly create a new one.",
        );
      const external = exists ? readFileSync(file, "utf8") : "";
      // Connecting a nonempty local draft to an existing note keeps both versions.
      const merged = mergeMarkdown(
        doc.syncedMarkdown || "",
        doc.markdown,
        external,
      );
      return this.store.reviseDocument(
        id,
        doc.revision,
        merged.text,
        { origin: "note-connection" },
        {
          vaultId: root,
          notePath: input.path,
          syncEnabled: input.syncEnabled,
          syncMethod: input.syncMethod,
          syncedMarkdown: external,
          syncedHash: exists ? digest(external) : null,
          syncedRevision: doc.revision,
          allowCreate: input.create,
          syncStatus: merged.conflicts.length ? "conflict" : "local",
          conflict: merged.conflicts.length
            ? { ...merged, external, externalHash: digest(external) }
            : null,
        },
      );
    });
  }
  async preferences(id, input) {
    return this.serial(id, () => {
      const doc = this.get(id);
      return this.store.put("literatureDocument", { ...doc, ...input });
    });
  }
  async sync(id) {
    return this.serial(id, async () => {
      let doc = this.get(id);
      if (!doc.syncEnabled || !doc.notePath) return doc;
      if (doc.vaultId !== this.vaultIdentity())
        return this.store.put("literatureDocument", {
          ...doc,
          syncStatus: "offline",
          syncError:
            "The connected vault is unavailable. Your local note is retained.",
        });
      try {
        const file = await safeNotePath(doc.vaultId, doc.notePath, {
          allowNew: !!doc.allowCreate,
        });
        if (!existsSync(file) && !doc.allowCreate)
          throw documentError(
            "The note was renamed or deleted. Relink or explicitly restore it; your local note is retained.",
          );
        const external = existsSync(file) ? readFileSync(file, "utf8") : "";
        const hash = existsSync(file) ? digest(external) : null;
        if (doc.conflict?.externalHash === hash) return doc;
        const merged = mergeMarkdown(
          doc.syncedMarkdown,
          doc.markdown,
          external,
        );
        if (merged.text !== doc.markdown || merged.conflicts.length)
          doc = this.store.reviseDocument(
            id,
            doc.revision,
            merged.text,
            { origin: "external-merge" },
            {
              conflict: merged.conflicts.length
                ? { ...merged, external, externalHash: hash }
                : null,
              syncStatus: merged.conflicts.length ? "conflict" : "local",
            },
          );
        if (merged.conflicts.length) return doc;
        if (merged.text !== external || hash === null) {
          if (doc.syncMethod === "bridge")
            await this.bridgeWrite(doc, external, merged.text, hash);
          else atomicNoteWrite(file, merged.text, hash);
        }
        // Re-read after a coordinated write. Never mark a late or failed write synced.
        if (readFileSync(file, "utf8") !== merged.text)
          throw documentError(
            "The note changed during synchronization. Retry to merge its current version.",
          );
        await this.onWritten(doc.notePath);
        return this.store.put("literatureDocument", {
          ...doc,
          syncedMarkdown: merged.text,
          syncedHash: digest(merged.text),
          syncedRevision: doc.revision,
          syncStatus: "synced",
          syncError: "",
          allowCreate: false,
        });
      } catch (error) {
        return this.store.put("literatureDocument", {
          ...this.get(id),
          syncStatus: error.status === 409 ? "conflict" : "offline",
          syncError: error.message,
        });
      }
    });
  }
  async resolve(id, { expectedRevision, markdown, externalHash }) {
    await this.serial(id, async () => {
      const doc = this.get(id);
      if (!doc.conflict || doc.revision !== expectedRevision)
        throw documentError(
          "The conflict changed. Reload before resolving it.",
        );
      const file = await safeNotePath(doc.vaultId, doc.notePath);
      const external = readFileSync(file, "utf8");
      if (digest(external) !== externalHash)
        throw documentError(
          "Obsidian changed again. Refresh the conflict before resolving it.",
        );
      this.store.reviseDocument(
        id,
        expectedRevision,
        markdown,
        { origin: "user-conflict-resolution" },
        {
          conflict: null,
          syncedMarkdown: external,
          syncedHash: externalHash,
          syncStatus: "local",
        },
      );
    });
    return this.sync(id);
  }
  async undo(id, revisionId, expectedRevision) {
    return this.serial(id, () => {
      const doc = this.get(id),
        revision = this.store.get("documentRevision", revisionId);
      if (
        !revision ||
        revision.documentId !== id ||
        revision.parentRevision === null
      )
        throw documentError(
          "Choose an authored or accepted revision to undo.",
          400,
        );
      if (doc.revision !== expectedRevision)
        throw documentError(
          "The document changed. Refresh its history before undoing.",
        );
      const inverse = mergeMarkdown(
        revision.markdown,
        revision.before,
        doc.markdown,
      );
      if (inverse.conflicts.length)
        throw documentError(
          "Newer edits overlap this change. The original and edited versions remain in revision history for recovery.",
        );
      return this.store.reviseDocument(
        id,
        expectedRevision,
        inverse.text,
        { origin: "user-undo", undoOf: revision.id },
        { syncStatus: "local" },
      );
    });
  }
  bridgePoll(clientId, vaultId) {
    if (vaultId !== this.vaultIdentity())
      throw documentError("The bridge belongs to a different vault.", 400);
    this.bridgeClients.set(clientId, { vaultId, at: Date.now() });
    return this.store
      .list("bridgeWrite")
      .filter(
        (job) =>
          job.status === "pending" &&
          job.clientId === clientId &&
          job.expiresAt > Date.now(),
      );
  }
  bridgeAck(id, clientId, result) {
    const job = this.store.get("bridgeWrite", id);
    if (!job || job.clientId !== clientId)
      throw documentError("Unknown bridge write.", 404);
    if (job.status !== "pending") return job;
    return this.store.put("bridgeWrite", {
      ...job,
      status: result.ok ? "completed" : "failed",
      error: result.error || "",
    });
  }
  async bridgeWrite(doc, before, after, beforeHash) {
    const client = [...this.bridgeClients.entries()].find(
      ([, c]) => c.vaultId === doc.vaultId && Date.now() - c.at < 6000,
    );
    if (!client)
      throw documentError(
        "Reload the Margin bridge in Obsidian, or choose sync while this note is closed.",
        503,
      );
    const job = this.store.put("bridgeWrite", {
      documentId: doc.id,
      vaultId: doc.vaultId,
      path: doc.notePath,
      clientId: client[0],
      before,
      after,
      beforeHash,
      create: beforeHash === null,
      status: "pending",
      expiresAt: Date.now() + 8000,
    });
    while (Date.now() < job.expiresAt) {
      const current = this.store.get("bridgeWrite", job.id);
      if (current.status === "completed") return;
      if (current.status === "failed")
        throw documentError(
          current.error ||
            "Obsidian declined the write. Save its editor buffer and retry.",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.store.put("bridgeWrite", { ...job, status: "expired" });
    throw documentError(
      "The bridge did not confirm the write. Your local revision is retained; retry to reconcile the file.",
      503,
    );
  }
}

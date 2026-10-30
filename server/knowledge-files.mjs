import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { digest } from "./vault.mjs";

export const KNOWLEDGE_VERSION = "knowledge-1";
const safeId = (id) => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new Error("Invalid knowledge identity.");
  return id;
};
export function markdownRecord(metadata, body = "") {
  return `---\n${YAML.stringify(metadata, { lineWidth: 0 })}---\n${body.trim()}\n`;
}
export function readMarkdownRecord(file) {
  const raw = readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!match) throw new Error("Knowledge Markdown is missing its metadata.");
  return {
    metadata: YAML.parse(match[1]),
    body: raw.slice(match[0].length),
    raw,
  };
}
function durableWrite(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, value, { flag: "wx", mode: 0o600 });
  const fd = openSync(temp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  const dir = openSync(dirname(file), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

// Generated prose lives only in these Markdown files. SQLite contains rebuildable
// indexes, identities, input dependencies, jobs, and human review decisions.
export class KnowledgeFiles {
  constructor(root) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }
  entityPath(scope, entityId) {
    return resolve(this.root, safeId(scope), safeId(entityId));
  }
  manifest(scope, entityId) {
    const file = resolve(this.entityPath(scope, entityId), "manifest.md");
    return existsSync(file) ? readMarkdownRecord(file).metadata : null;
  }
  saveManifest(scope, manifest) {
    durableWrite(
      resolve(this.entityPath(scope, manifest.id), "manifest.md"),
      markdownRecord(
        manifest,
        `# ${manifest.title}\n\nMargin knowledge interface.\nGenerated preparation is separate from the linked note.\n`,
      ),
    );
  }
  revisionPath(scope, entityId, revisionId) {
    return resolve(
      this.entityPath(scope, entityId),
      "revisions",
      safeId(revisionId),
    );
  }
  readRevision(scope, entityId, revisionId) {
    const dir = this.revisionPath(scope, entityId, revisionId);
    const overview = readMarkdownRecord(resolve(dir, "overview.md"));
    const metadata = overview.metadata;
    if (
      metadata.entityId !== entityId ||
      metadata.revisionId !== revisionId ||
      metadata.version !== KNOWLEDGE_VERSION
    )
      throw new Error("Knowledge revision identity or schema does not match.");
    const readCards = (kind) =>
      (metadata.files || [])
        .filter((f) => f.kind === kind)
        .map((f) => {
          const file = resolve(dir, kind, `${safeId(f.id)}.md`);
          const record = readMarkdownRecord(file);
          if (digest(record.raw) !== f.hash || record.metadata.id !== f.id)
            throw new Error("Knowledge card failed its integrity check.");
          return { ...record.metadata, markdown: record.body };
        });
    return {
      ...metadata,
      markdown: overview.body,
      units: readCards("units"),
      connections: readCards("connections"),
    };
  }
  publish(scope, manifest, snapshot) {
    const parent = resolve(this.entityPath(scope, manifest.id), "revisions");
    mkdirSync(parent, { recursive: true });
    const final = this.revisionPath(scope, manifest.id, snapshot.revisionId);
    if (!existsSync(final)) {
      const staging = resolve(
        parent,
        `.pending-${snapshot.revisionId}-${randomUUID()}`,
      );
      mkdirSync(staging);
      const files = [];
      for (const kind of ["units", "connections"]) {
        for (const card of snapshot[kind]) {
          const { markdown, ...metadata } = card;
          const raw = markdownRecord(metadata, markdown);
          durableWrite(resolve(staging, kind, `${safeId(card.id)}.md`), raw);
          files.push({ kind, id: card.id, hash: digest(raw) });
        }
      }
      const { units, connections, markdown, ...metadata } = snapshot;
      durableWrite(
        resolve(staging, "overview.md"),
        markdownRecord({ ...metadata, files }, markdown),
      );
      renameSync(staging, final);
      const fd = openSync(parent, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    // Validate the complete immutable directory before moving the single pointer.
    this.readRevision(scope, manifest.id, snapshot.revisionId);
    this.saveManifest(scope, {
      ...manifest,
      currentRevision: snapshot.revisionId,
    });
  }
  entities(scope) {
    const dir = resolve(this.root, safeId(scope));
    return existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(d.name))
          .map((d) => d.name)
      : [];
  }
  work(scope, entityId, key, value) {
    const file = resolve(
      this.entityPath(scope, entityId),
      "work",
      `${safeId(key)}.md`,
    );
    if (value) {
      const { markdown, ...metadata } = value;
      durableWrite(file, markdownRecord(metadata, markdown));
      return { ...metadata, markdown: `${String(markdown || "").trim()}\n` };
    }
    if (!existsSync(file)) return null;
    const record = readMarkdownRecord(file);
    return { ...record.metadata, markdown: record.body };
  }
  export(scope, entityId) {
    const manifest = this.manifest(scope, entityId);
    if (!manifest) throw new Error("Knowledge manifest not found.");
    const records = [
      {
        path: `${entityId}/manifest.md`,
        markdown: readFileSync(
          resolve(this.entityPath(scope, entityId), "manifest.md"),
          "utf8",
        ),
      },
    ];
    if (manifest.currentRevision) {
      const snapshot = this.readRevision(
        scope,
        entityId,
        manifest.currentRevision,
      );
      const dir = this.revisionPath(scope, entityId, snapshot.revisionId);
      for (const file of [
        "overview.md",
        ...snapshot.files.map((f) => `${f.kind}/${f.id}.md`),
      ])
        records.push({
          path: `${entityId}/revisions/${snapshot.revisionId}/${file}`,
          markdown: readFileSync(resolve(dir, file), "utf8"),
        });
    }
    return records;
  }
}

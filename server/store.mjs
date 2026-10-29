import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA_VERSION = 2;
const TERMINAL_RUN_STATES = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "awaiting_user",
]);
const TERMINAL_RUN_EVENTS = new Set([
  "run.completed",
  "run.partial",
  "run.failed",
  "run.cancelled",
  "run.awaiting_user",
]);
const SESSION_RESEARCH_RECORD_KINDS = [
  "artifact",
  "toolCall",
  "runEvidence",
  "sessionSummary",
  "researchInquiry",
  "researchClaim",
  "conceptOccurrence",
  "learningEvidence",
  "memoryProposal",
  "relationship",
  "promotion",
];
const VERBOSE_RUN_FIELDS = [
  "transcript",
  "toolTranscript",
  "providerDiagnostics",
  "diagnostics",
  "debugTrace",
  "trace",
  "draftText",
];

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function hasFileContents(filename) {
  if (filename === ":memory:") return false;
  try {
    return statSync(filename).size > 0;
  } catch {
    return false;
  }
}

function backupBeforeMigration(db, filename, version) {
  if (filename === ":memory:") return undefined;
  const backupPath = `${resolve(filename)}.v${version}.${Date.now()}.${randomUUID().slice(0, 8)}.bak`;
  // VACUUM INTO takes a consistent snapshot, including committed WAL contents.
  // This runs before schema changes or switching journal mode.
  db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
  return backupPath;
}

function createLegacyTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_kind ON records(kind);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

function createAgentTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      idempotency_key TEXT,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS agent_runs_session_updated
      ON agent_runs(session_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS agent_runs_status
      ON agent_runs(status);
    CREATE TABLE IF NOT EXISTS agent_events (
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS agent_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function migrate(db, filename) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `Database schema version ${version} is newer than this application supports (${SCHEMA_VERSION}).`,
    );
  }

  let backupPath;
  if (version < SCHEMA_VERSION && hasFileContents(filename)) {
    backupPath = backupBeforeMigration(db, filename, version);
  }

  db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
  try {
    if (version === 0) {
      createLegacyTables(db);
      db.exec(`
        CREATE TABLE IF NOT EXISTS migration_ledger (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      db.prepare(
        "INSERT OR IGNORE INTO migration_ledger(version,name,applied_at) VALUES (1,?,?)",
      ).run("legacy records and settings", new Date().toISOString());
      db.exec("PRAGMA user_version=1;");
    } else if (version === 1) {
      // A v1 database predates the ledger. Record the known baseline before
      // applying the first tracked migration.
      db.exec(`
        CREATE TABLE IF NOT EXISTS migration_ledger (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      db.prepare(
        "INSERT OR IGNORE INTO migration_ledger(version,name,applied_at) VALUES (1,?,?)",
      ).run("legacy records and settings", new Date().toISOString());
    }

    if (version < 2) {
      createAgentTables(db);
      db.prepare(
        "INSERT OR REPLACE INTO migration_ledger(version,name,applied_at) VALUES (2,?,?)",
      ).run("durable agent runs and events", new Date().toISOString());
      db.exec("PRAGMA user_version=2;");
    }
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration error if SQLite already rolled back.
    }
    db.close();
    throw error;
  }
  return backupPath;
}

function parseJson(value, label = "stored value") {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${error.message}`);
  }
}

function isTerminal(run) {
  return TERMINAL_RUN_STATES.has(run?.status);
}

function sessionRecordScope(record, session, runIds) {
  const related =
    record.sessionId === session.id ||
    (!record.sessionId && record.runId && runIds.has(record.runId));
  if (!related) return { related: false, owned: false };
  if (record.sessionId && record.sessionId !== session.id)
    return { related: true, owned: false };
  if (
    record.workspaceId &&
    session.workspaceId &&
    record.workspaceId !== session.workspaceId
  )
    return { related: true, owned: false };
  return { related: true, owned: true };
}

function referencesEvidence(record, evidenceId) {
  if (!record || typeof record !== "object") return false;
  if (record.evidenceId === evidenceId) return true;
  if (
    Array.isArray(record.evidenceIds) &&
    record.evidenceIds.includes(evidenceId)
  )
    return true;
  if (
    Array.isArray(record.loadedEvidenceIds) &&
    record.loadedEvidenceIds.includes(evidenceId)
  )
    return true;
  if (
    Array.isArray(record.citationEvidenceIds) &&
    record.citationEvidenceIds.includes(evidenceId)
  )
    return true;
  if (
    Array.isArray(record.attribution?.evidenceIds) &&
    record.attribution.evidenceIds.includes(evidenceId)
  )
    return true;
  const collections = [
    record.evidence,
    record.evidenceSupport,
    record.provenance?.evidence,
    record.proposedProvenance?.evidence,
  ];
  return collections.some(
    (items) =>
      Array.isArray(items) &&
      items.some(
        (item) => item?.id === evidenceId || item?.evidenceId === evidenceId,
      ),
  );
}

function evidenceReferences(record, output = new Set()) {
  if (!record || typeof record !== "object") return output;
  for (const key of ["evidenceId"]) {
    if (typeof record[key] === "string" && record[key]) output.add(record[key]);
  }
  for (const key of [
    "evidenceIds",
    "loadedEvidenceIds",
    "citationEvidenceIds",
  ]) {
    if (Array.isArray(record[key]))
      for (const id of record[key])
        if (typeof id === "string" && id) output.add(id);
  }
  if (Array.isArray(record.attribution?.evidenceIds))
    for (const id of record.attribution.evidenceIds)
      if (typeof id === "string" && id) output.add(id);
  for (const key of [
    "evidence",
    "evidenceSupport",
    "provenance",
    "proposedProvenance",
  ]) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item) output.add(item);
        else if (item && typeof item === "object") {
          if (typeof item.id === "string" && item.id) output.add(item.id);
          if (typeof item.evidenceId === "string" && item.evidenceId)
            output.add(item.evidenceId);
          evidenceReferences(item, output);
        }
      }
    } else if (value && typeof value === "object") {
      evidenceReferences(value, output);
    }
  }
  return output;
}

function terminalEventType(status) {
  return `run.${status}`;
}

function deletionError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function stableJson(value) {
  if (Array.isArray(value))
    return JSON.stringify(value.map((item) => JSON.parse(stableJson(item))));
  if (value && typeof value === "object") {
    const sorted = Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, JSON.parse(stableJson(value[key]))]),
    );
    return JSON.stringify(sorted);
  }
  return JSON.stringify(value ?? null);
}

function idempotencyConflict(existing, requested) {
  const fields = [
    "text",
    "anchor",
    "mode",
    "selection",
    "contextOverrides",
    "budgets",
    "workspaceId",
    "sourceId",
    "sourceRevision",
    "researchQuestion",
    "model",
    "provider",
    "cloud",
    "capabilityProfile",
    "scope",
  ];
  return fields.some((field) => {
    const previous = existing[field] ?? existing.input?.[field];
    const current = requested[field] ?? requested.input?.[field];
    return stableJson(previous) !== stableJson(current);
  });
}

export class Store {
  constructor(filename) {
    this.filename = filename;
    if (filename !== ":memory:")
      mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    try {
      this.migrationBackupPath = migrate(this.db, filename);
      this.db.exec("PRAGMA journal_mode=WAL;");
    } catch (error) {
      // migrate() closes the connection on failure; this also covers setup
      // failures after migration completed.
      try {
        this.db.close();
      } catch {
        // Ignore an already closed connection.
      }
      throw error;
    }
  }

  put(kind, value) {
    const item = {
      ...value,
      id: value.id || randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO records VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at WHERE records.kind=excluded.kind",
      )
      .run(item.id, kind, JSON.stringify(item), item.updatedAt);
    return item;
  }

  get(kind, id) {
    if (kind === "agentRun") return this.getAgentRun(id);
    const row = this.db
      .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? parseJson(row.payload, `record ${kind}/${id}`) : undefined;
  }

  list(kind) {
    if (kind === "agentRun") return this.listAgentRuns();
    return this.db
      .prepare(
        "SELECT payload FROM records WHERE kind=? ORDER BY updated_at DESC",
      )
      .all(kind)
      .map((r) => parseJson(r.payload, `record of kind ${kind}`));
  }

  setting(key, value) {
    if (value !== undefined)
      this.db
        .prepare(
          "INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, JSON.stringify(value));
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return row ? parseJson(row.value, `setting ${key}`) : undefined;
  }

  createAgentRun(run, event = null) {
    return this.transaction(() => {
      if (run.idempotencyKey) {
        const existing = this.db
          .prepare(
            "SELECT payload FROM agent_runs WHERE session_id=? AND idempotency_key=?",
          )
          .get(run.sessionId, run.idempotencyKey);
        if (existing) {
          const existingRun = parseJson(
            existing.payload,
            `run ${run.idempotencyKey}`,
          );
          if (idempotencyConflict(existingRun, run)) {
            const error = new Error(
              "This idempotency key was already used for a different run request.",
            );
            error.status = 409;
            error.code = "IDEMPOTENCY_CONFLICT";
            throw error;
          }
          return {
            run: existingRun,
            created: false,
          };
        }
      }
      const now = run.createdAt || new Date().toISOString();
      const questionArtifactId = run.questionArtifactId || randomUUID();
      const storedRun = {
        ...run,
        questionArtifactId,
        createdAt: now,
        updatedAt: run.updatedAt || now,
      };
      this.db
        .prepare(
          "INSERT INTO agent_runs(id,session_id,idempotency_key,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          storedRun.id,
          storedRun.sessionId,
          storedRun.idempotencyKey || null,
          storedRun.status,
          JSON.stringify(storedRun),
          storedRun.createdAt,
          storedRun.updatedAt,
        );
      const question = {
        id: questionArtifactId,
        runId: storedRun.id,
        sessionId: storedRun.sessionId,
        text: storedRun.text ?? storedRun.input?.text ?? "",
        kind: "question",
        origin: "user",
        status: "open",
        ...(storedRun.anchor !== undefined ||
        storedRun.input?.anchor !== undefined
          ? { anchor: storedRun.anchor ?? storedRun.input.anchor }
          : {}),
        ...(storedRun.mode !== undefined || storedRun.input?.mode !== undefined
          ? { mode: storedRun.mode ?? storedRun.input.mode }
          : {}),
        createdAt: storedRun.createdAt,
        updatedAt: storedRun.updatedAt,
      };
      const existingQuestion = this.db
        .prepare("SELECT payload FROM records WHERE id=? AND kind='artifact'")
        .get(question.id);
      if (existingQuestion) {
        const savedQuestion = parseJson(
          existingQuestion.payload,
          `question artifact ${question.id}`,
        );
        if (
          savedQuestion.kind !== "question" ||
          savedQuestion.sessionId !== storedRun.sessionId ||
          savedQuestion.text !== question.text
        )
          throw new Error(`Question artifact ID collision for ${question.id}.`);
      } else {
        this.db
          .prepare(
            "INSERT INTO records(id,kind,payload,updated_at) VALUES (?,?,?,?)",
          )
          .run(
            question.id,
            "artifact",
            JSON.stringify(question),
            question.updatedAt,
          );
      }
      const storedEvent = event
        ? this.#insertAgentEvent(storedRun.id, event)
        : undefined;
      return { run: storedRun, event: storedEvent, created: true };
    });
  }

  getAgentRun(id) {
    const row = this.db
      .prepare("SELECT payload FROM agent_runs WHERE id=?")
      .get(id);
    return row ? parseJson(row.payload, `agent run ${id}`) : undefined;
  }

  findAgentRun(sessionId, idempotencyKey) {
    if (!idempotencyKey) return undefined;
    const row = this.db
      .prepare(
        "SELECT payload FROM agent_runs WHERE session_id=? AND idempotency_key=?",
      )
      .get(sessionId, idempotencyKey);
    return row
      ? parseJson(row.payload, `agent run ${idempotencyKey}`)
      : undefined;
  }

  listAgentRuns(sessionId) {
    const rows =
      sessionId === undefined
        ? this.db
            .prepare("SELECT payload FROM agent_runs ORDER BY created_at DESC")
            .all()
        : this.db
            .prepare(
              "SELECT payload FROM agent_runs WHERE session_id=? ORDER BY created_at DESC",
            )
            .all(sessionId);
    return rows.map((row) => parseJson(row.payload, "agent run"));
  }

  updateAgentRun(run, event = null) {
    return this.transaction(() => {
      const current = this.getAgentRun(run.id);
      if (!current) return { run: undefined, updated: false };
      if (isTerminal(current)) return { run: current, updated: false };
      const updated = {
        ...current,
        ...run,
        updatedAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          "UPDATE agent_runs SET status=?,payload=?,updated_at=? WHERE id=? AND status=?",
        )
        .run(
          updated.status,
          JSON.stringify(updated),
          updated.updatedAt,
          run.id,
          current.status,
        );
      const changed =
        this.db.prepare("SELECT changes() AS count").get().count > 0;
      const storedEvent =
        changed && event ? this.#insertAgentEvent(run.id, event) : undefined;
      return {
        run: changed ? updated : this.getAgentRun(run.id),
        event: storedEvent,
        updated: changed,
      };
    });
  }

  appendAgentEvent(runId, event) {
    return this.transaction(() => {
      if (!this.getAgentRun(runId))
        throw new Error(`Unknown agent run: ${runId}`);
      return this.#insertAgentEvent(runId, event);
    });
  }

  getAgentEvents(runId, after = 0) {
    return this.db
      .prepare(
        "SELECT seq,type,payload,created_at AS createdAt FROM agent_events WHERE run_id=? AND seq>? ORDER BY seq ASC",
      )
      .all(runId, Math.max(0, Number(after) || 0))
      .map((row) => ({
        seq: row.seq,
        type: row.type,
        ...parseJson(row.payload, `event ${runId}/${row.seq}`),
        createdAt: row.createdAt,
      }));
  }

  getAgentArtifact(runId) {
    const row = this.db
      .prepare("SELECT payload FROM agent_artifacts WHERE run_id=?")
      .get(runId);
    return row
      ? parseJson(row.payload, `artifact for run ${runId}`)
      : undefined;
  }

  listAgentArtifacts() {
    return this.db
      .prepare("SELECT payload FROM agent_artifacts ORDER BY created_at")
      .all()
      .map((row) => parseJson(row.payload, "agent artifact"));
  }

  finalizeAgentRun(run, artifact, event) {
    return this.transaction(() => {
      const current = this.getAgentRun(run.id);
      if (!current) return { run: undefined, committed: false };
      if (isTerminal(current))
        return {
          run: current,
          artifact: this.getAgentArtifact(run.id),
          committed: false,
        };

      const now = new Date().toISOString();
      const finalRun = { ...current, ...run, updatedAt: now };
      this.db
        .prepare(
          "UPDATE agent_runs SET status=?,payload=?,updated_at=? WHERE id=? AND status=?",
        )
        .run(
          finalRun.status,
          JSON.stringify(finalRun),
          now,
          run.id,
          current.status,
        );
      if (this.db.prepare("SELECT changes() AS count").get().count === 0)
        return { run: this.getAgentRun(run.id), committed: false };

      for (const item of Array.isArray(finalRun.evidence)
        ? finalRun.evidence
        : []) {
        const evidenceId = typeof item === "string" ? item : item?.id;
        if (!evidenceId) continue;
        const id = `${run.id}:${evidenceId}`;
        const row = this.db
          .prepare(
            "SELECT payload FROM records WHERE kind='runEvidence' AND id=?",
          )
          .get(id);
        if (!row) continue;
        const link = parseJson(row.payload, `run evidence ${id}`);
        const loadedInPrompt =
          typeof item !== "string" &&
          (item.loadedInPrompt === true || item.state === "loaded");
        const state = loadedInPrompt
          ? "loaded"
          : typeof item !== "string" && item.state
            ? item.state
            : "available";
        const updatedLink = {
          ...link,
          state,
          loadedInPrompt,
          ...(typeof item !== "string" && item.tokenCost !== undefined
            ? { tokenCost: item.tokenCost }
            : {}),
          updatedAt: now,
        };
        this.db
          .prepare(
            "UPDATE records SET payload=?,updated_at=? WHERE id=? AND kind='runEvidence'",
          )
          .run(JSON.stringify(updatedLink), now, id);
      }

      const startedToolEvents = this.db
        .prepare(
          "SELECT seq,payload FROM agent_events WHERE run_id=? AND type='tool.started' ORDER BY seq",
        )
        .all(run.id);
      for (const toolEvent of startedToolEvents) {
        const payload = parseJson(
          toolEvent.payload,
          `tool start ${run.id}/${toolEvent.seq}`,
        );
        const toolCallId =
          payload.toolCallId || payload.callId || `event-${toolEvent.seq}`;
        const id = `${run.id}:${toolCallId}`;
        const row = this.db
          .prepare("SELECT payload FROM records WHERE kind='toolCall' AND id=?")
          .get(id);
        if (!row) continue;
        const item = parseJson(row.payload, `tool call ${id}`);
        if (item.status !== "running") continue;
        const updatedCall = {
          ...item,
          status: finalRun.status === "cancelled" ? "cancelled" : "interrupted",
          ...(finalRun.failure?.type
            ? { interruptionReason: finalRun.failure.type }
            : {}),
          completedAt: now,
          updatedAt: now,
        };
        this.db
          .prepare(
            "UPDATE records SET payload=?,updated_at=? WHERE id=? AND kind='toolCall'",
          )
          .run(JSON.stringify(updatedCall), now, id);
      }

      let savedArtifact;
      if (artifact) {
        savedArtifact = {
          ...artifact,
          id: artifact.id || randomUUID(),
          runId: run.id,
          updatedAt: artifact.updatedAt || now,
        };
        this.db
          .prepare(
            "INSERT INTO agent_artifacts(id,run_id,payload,created_at) VALUES (?,?,?,?)",
          )
          .run(savedArtifact.id, run.id, JSON.stringify(savedArtifact), now);
        // Keep the long-standing artifact reader usable while the run API is
        // introduced. Both rows commit or roll back with the terminal state.
        this.db
          .prepare(
            "INSERT INTO records(id,kind,payload,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at WHERE records.kind=excluded.kind",
          )
          .run(
            savedArtifact.id,
            "artifact",
            JSON.stringify(savedArtifact),
            savedArtifact.updatedAt,
          );
      }
      const storedEvent = event
        ? this.#insertAgentEvent(run.id, event)
        : undefined;
      return {
        run: finalRun,
        artifact: savedArtifact,
        event: storedEvent,
        committed: true,
      };
    });
  }

  cancelAgentRun(id, patch, event) {
    return this.transaction(() => {
      const current = this.getAgentRun(id);
      if (!current) return { run: undefined, cancelled: false };
      if (isTerminal(current)) return { run: current, cancelled: false };
      const updated = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          "UPDATE agent_runs SET status=?,payload=?,updated_at=? WHERE id=? AND status=?",
        )
        .run(
          updated.status,
          JSON.stringify(updated),
          updated.updatedAt,
          id,
          current.status,
        );
      const changed =
        this.db.prepare("SELECT changes() AS count").get().count > 0;
      const storedEvent =
        changed && event ? this.#insertAgentEvent(id, event) : undefined;
      return {
        run: changed ? updated : this.getAgentRun(id),
        event: storedEvent,
        cancelled: changed,
      };
    });
  }

  /**
   * Remove verbose diagnostics from terminal runs while retaining their input,
   * evidence, final artifact, and one replayable terminal event. A caller can
   * scope the operation to one run or one session; an unscoped call is capped
   * to the oldest 100 terminal runs by default.
   */
  purgeAgentDiagnostics({ sessionId, runId, limit = 100 } = {}) {
    const safeLimit = Math.max(
      1,
      Math.min(500, Math.floor(Number(limit) || 100)),
    );
    return this.transaction(() => {
      const candidates = this.listAgentRuns()
        .filter((run) => isTerminal(run))
        .filter((run) => sessionId === undefined || run.sessionId === sessionId)
        .filter((run) => runId === undefined || run.id === runId)
        .sort((a, b) =>
          String(a.updatedAt || a.createdAt || "").localeCompare(
            String(b.updatedAt || b.createdAt || ""),
          ),
        )
        .slice(0, safeLimit);

      let runsPurged = 0;
      let eventsDeleted = 0;
      let eventsInserted = 0;
      let toolCallsDeleted = 0;
      const fieldsRemoved = {};

      for (const run of candidates) {
        const allEvents = this.getAgentEvents(run.id);
        const terminalEvent = allEvents
          .filter((event) => event.type === terminalEventType(run.status))
          .at(-1);
        let keptEvent = terminalEvent;
        let insertedTerminalEvent = false;
        if (!keptEvent) {
          keptEvent = this.#insertAgentEvent(run.id, {
            type: terminalEventType(run.status),
            status: run.status,
            ...(run.artifactId ? { artifactId: run.artifactId } : {}),
            replayedFromStore: true,
          });
          eventsInserted += 1;
          insertedTerminalEvent = true;
        }

        const deleteEvents = this.db
          .prepare("DELETE FROM agent_events WHERE run_id=? AND seq<>?")
          .run(run.id, keptEvent.seq).changes;
        eventsDeleted += deleteEvents;

        const callRows = this.db
          .prepare("SELECT id,payload FROM records WHERE kind='toolCall'")
          .all();
        let deletedCallsForRun = 0;
        const session = {
          id: run.sessionId,
          workspaceId: run.workspaceId,
        };
        for (const row of callRows) {
          const call = parseJson(row.payload, `tool call ${row.id}`);
          if (
            call.runId === run.id &&
            sessionRecordScope(call, session, new Set([run.id])).owned
          ) {
            const deleted = this.db
              .prepare("DELETE FROM records WHERE id=? AND kind='toolCall'")
              .run(row.id).changes;
            toolCallsDeleted += deleted;
            deletedCallsForRun += deleted;
          }
        }

        const compacted = { ...run };
        const removed = [];
        for (const field of VERBOSE_RUN_FIELDS) {
          if (Object.hasOwn(compacted, field)) {
            delete compacted[field];
            removed.push(field);
          }
        }
        if (removed.length) {
          compacted.updatedAt = run.updatedAt;
          this.db
            .prepare("UPDATE agent_runs SET payload=? WHERE id=? AND status=?")
            .run(JSON.stringify(compacted), run.id, run.status);
          for (const field of removed)
            fieldsRemoved[field] = (fieldsRemoved[field] || 0) + 1;
        }
        if (
          removed.length ||
          deleteEvents ||
          insertedTerminalEvent ||
          deletedCallsForRun
        ) {
          runsPurged += 1;
        }
      }

      return {
        sessionId: sessionId ?? null,
        runId: runId ?? null,
        runsConsidered: candidates.length,
        runsPurged,
        eventsDeleted,
        eventsInserted,
        toolCallsDeleted,
        fieldsRemoved,
      };
    });
  }

  /**
   * Delete one session's persisted run, artifact, history, and research data.
   * The session row remains available to the reader, with derived summary
   * fields cleared. Workspace/source records and on-disk files are untouched.
   */
  deleteSessionData(sessionId) {
    if (typeof sessionId !== "string" || !sessionId.trim())
      throw new TypeError("A session ID is required.");

    return this.transaction(() => {
      const session = this.get("session", sessionId);
      if (!session)
        throw deletionError(
          `Unknown session: ${sessionId}`,
          404,
          "SESSION_NOT_FOUND",
        );

      const allSessionRuns = this.listAgentRuns(sessionId);
      if (allSessionRuns.some((run) => !isTerminal(run))) {
        throw deletionError(
          "Session research history cannot be deleted while a run is active.",
          409,
          "ACTIVE_RUNS",
        );
      }

      const isWorkspaceOwnedRun = (run) =>
        !run.workspaceId ||
        !session.workspaceId ||
        run.workspaceId === session.workspaceId;
      const runs = allSessionRuns.filter(isWorkspaceOwnedRun);
      const runIds = new Set(runs.map((run) => run.id));
      const deletedEvents = runs.reduce(
        (count, run) =>
          count +
          this.db
            .prepare(
              "SELECT COUNT(*) AS count FROM agent_events WHERE run_id=?",
            )
            .get(run.id).count,
        0,
      );
      const deletedAgentArtifacts = runs.reduce(
        (count, run) => count + (this.getAgentArtifact(run.id) ? 1 : 0),
        0,
      );
      const recordRows = this.db
        .prepare(
          "SELECT id,kind,payload FROM records WHERE kind IN (" +
            SESSION_RESEARCH_RECORD_KINDS.map(() => "?").join(",") +
            ")",
        )
        .all(...SESSION_RESEARCH_RECORD_KINDS);
      const ownedRecords = [];
      let preservedForeignRecords = 0;
      for (const row of recordRows) {
        const record = parseJson(row.payload, `record ${row.kind}/${row.id}`);
        const scope = sessionRecordScope(record, session, runIds);
        if (scope.owned) ownedRecords.push(row);
        else if (scope.related) preservedForeignRecords += 1;
      }

      const evidenceCandidates = new Set();
      for (const run of runs) {
        for (const id of evidenceReferences(run)) evidenceCandidates.add(id);
      }
      for (const row of ownedRecords) {
        const record = parseJson(row.payload, `record ${row.kind}/${row.id}`);
        for (const id of evidenceReferences(record)) evidenceCandidates.add(id);
      }
      for (const row of recordRows.filter(
        (item) => item.kind === "runEvidence",
      )) {
        const link = parseJson(row.payload, `run evidence ${row.id}`);
        if (sessionRecordScope(link, session, runIds).owned && link.evidenceId)
          evidenceCandidates.add(String(link.evidenceId));
      }
      const snapshotRows = this.db
        .prepare("SELECT id,payload FROM records WHERE kind='evidenceSnapshot'")
        .all();
      for (const row of snapshotRows) {
        const snapshot = parseJson(row.payload, `evidence snapshot ${row.id}`);
        if (
          snapshot.sessionId === sessionId ||
          (snapshot.runId && runIds.has(snapshot.runId))
        )
          evidenceCandidates.add(row.id);
      }

      const deletedRecords = {};
      for (const row of ownedRecords) {
        const changed = this.db
          .prepare("DELETE FROM records WHERE id=? AND kind=?")
          .run(row.id, row.kind).changes;
        if (changed)
          deletedRecords[row.kind] = (deletedRecords[row.kind] || 0) + changed;
      }

      let deletedRuns = 0;
      for (const run of runs) {
        deletedRuns += this.db
          .prepare("DELETE FROM agent_runs WHERE id=? AND session_id=?")
          .run(run.id, sessionId).changes;
      }

      let deletedEvidenceSnapshots = 0;
      let preservedSharedEvidenceSnapshots = 0;
      let preservedForeignEvidenceSnapshots = 0;
      const remainingRecords = this.db
        .prepare(
          "SELECT kind,payload FROM records WHERE kind<>'evidenceSnapshot'",
        )
        .all()
        .map((row) => parseJson(row.payload, `record ${row.kind}`));
      const remainingRuns = this.listAgentRuns();
      const remainingArtifacts = this.listAgentArtifacts();
      const remainingEvents = this.db
        .prepare("SELECT payload FROM agent_events")
        .all()
        .map((row) => parseJson(row.payload, "agent event"));
      for (const id of evidenceCandidates) {
        const row = this.db
          .prepare(
            "SELECT payload FROM records WHERE kind='evidenceSnapshot' AND id=?",
          )
          .get(id);
        if (!row) continue;
        const snapshot = parseJson(row.payload, `evidence snapshot ${id}`);
        const foreignScope =
          (snapshot.sessionId && snapshot.sessionId !== sessionId) ||
          (snapshot.workspaceId &&
            session.workspaceId &&
            snapshot.workspaceId !== session.workspaceId);
        if (foreignScope) {
          preservedForeignEvidenceSnapshots += 1;
          continue;
        }
        const referenced =
          remainingRecords.some((record) => referencesEvidence(record, id)) ||
          remainingRuns.some((run) => referencesEvidence(run, id)) ||
          remainingArtifacts.some((artifact) =>
            referencesEvidence(artifact, id),
          ) ||
          remainingEvents.some((event) => referencesEvidence(event, id));
        if (referenced) {
          preservedSharedEvidenceSnapshots += 1;
          continue;
        }
        deletedEvidenceSnapshots += this.db
          .prepare("DELETE FROM records WHERE kind='evidenceSnapshot' AND id=?")
          .run(id).changes;
      }

      const clearedSession = { ...session };
      const clearedSessionFields = [];
      for (const field of ["nextStep", "takeaway"]) {
        if (Object.hasOwn(clearedSession, field)) {
          delete clearedSession[field];
          clearedSessionFields.push(field);
        }
      }
      if (clearedSessionFields.length) {
        clearedSession.updatedAt = new Date().toISOString();
        this.db
          .prepare(
            "UPDATE records SET payload=?,updated_at=? WHERE id=? AND kind='session'",
          )
          .run(
            JSON.stringify(clearedSession),
            clearedSession.updatedAt,
            sessionId,
          );
      }

      return {
        sessionId,
        sessionPreserved: true,
        workspaceId: session.workspaceId ?? null,
        deletedRuns,
        deletedEvents,
        deletedAgentArtifacts,
        deletedRecords,
        deletedEvidenceSnapshots,
        preservedSharedEvidenceSnapshots,
        preservedForeignEvidenceSnapshots,
        preservedForeignRecords,
        clearedSessionFields,
      };
    });
  }

  #insertAgentEvent(runId, event) {
    const max = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq),0) AS seq FROM agent_events WHERE run_id=?",
      )
      .get(runId).seq;
    const createdAt = event.createdAt || new Date().toISOString();
    const persisted = {
      ...event,
      seq: max + 1,
      createdAt,
    };
    const { seq, type, createdAt: _createdAt, ...payload } = persisted;
    this.db
      .prepare(
        "INSERT INTO agent_events(run_id,seq,type,payload,created_at) VALUES (?,?,?,?,?)",
      )
      .run(runId, seq, type, JSON.stringify(payload), createdAt);
    if (type === "tool.started" || type === "tool.completed")
      this.#persistToolCall(runId, seq, type, payload, createdAt);
    return persisted;
  }

  #persistToolCall(runId, seq, type, payload, createdAt) {
    const requestedId = payload.toolCallId || payload.callId;
    let callId = requestedId ? String(requestedId) : undefined;
    let recordId = callId ? `${runId}:${callId}` : undefined;
    let existing;
    if (recordId) {
      const row = this.db
        .prepare("SELECT payload FROM records WHERE kind='toolCall' AND id=?")
        .get(recordId);
      if (row) existing = parseJson(row.payload, `tool call ${recordId}`);
    } else if (type === "tool.completed") {
      const rows = this.db
        .prepare(
          "SELECT payload FROM records WHERE kind='toolCall' ORDER BY updated_at DESC",
        )
        .all();
      existing = rows
        .map((row) => parseJson(row.payload, "tool call"))
        .find(
          (item) =>
            item.runId === runId &&
            item.status === "running" &&
            (!payload.name || item.name === payload.name),
        );
      if (existing) {
        recordId = existing.id;
        callId = existing.toolCallId;
      }
    }
    if (type === "tool.started" && !recordId) {
      callId = `event-${seq}`;
      recordId = `${runId}:${callId}`;
    }

    const item =
      type === "tool.started"
        ? {
            ...(existing || {}),
            id: recordId,
            runId,
            toolCallId: callId,
            name: payload.name || payload.tool || "unknown tool",
            ...(payload.arguments !== undefined
              ? { arguments: payload.arguments }
              : {}),
            status: "running",
            startedEventSeq: seq,
            startedAt: createdAt,
            updatedAt: createdAt,
          }
        : {
            ...(existing || {}),
            id: recordId || `${runId}:${callId || `event-${seq}`}`,
            runId,
            toolCallId: callId || null,
            name: payload.name || existing?.name || "unknown tool",
            ...(payload.result !== undefined ? { result: payload.result } : {}),
            ...(payload.error !== undefined ? { error: payload.error } : {}),
            ...(payload.ok !== undefined ? { ok: payload.ok } : {}),
            status:
              payload.ok === false || payload.error ? "failed" : "completed",
            ...(existing?.startedEventSeq
              ? { startedEventSeq: existing.startedEventSeq }
              : {}),
            ...(existing?.startedAt ? { startedAt: existing.startedAt } : {}),
            completedEventSeq: seq,
            completedAt: createdAt,
            updatedAt: createdAt,
          };
    this.db
      .prepare(
        "INSERT INTO records(id,kind,payload,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at WHERE records.kind=excluded.kind",
      )
      .run(item.id, "toolCall", JSON.stringify(item), item.updatedAt);
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

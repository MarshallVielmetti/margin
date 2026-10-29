import { randomUUID } from "node:crypto";

const idPattern = /^ev_[A-Za-z0-9_-]{1,128}$/;

function strings(values) {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  return [
    ...new Set(
      list
        .filter((value) => value != null)
        .map((value) => String(value).trim())
        .filter(Boolean),
    ),
  ];
}

function snapshotId(input) {
  return idPattern.test(String(input.id || ""))
    ? String(input.id)
    : `ev_${randomUUID().replaceAll("-", "")}`;
}

function aliasesFor(input, id) {
  return strings([
    ...(Array.isArray(input.handles) ? input.handles : []),
    ...(Array.isArray(input.aliases) ? input.aliases : []),
    input.handle,
    input.promptHandle,
    input.label,
    input.id && input.id !== id ? input.id : undefined,
  ]);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function revisionValue(value) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const revision = String(value).trim();
  return revision || undefined;
}

function registrationFreshness(input, revision) {
  if (input.currentRevision != null)
    return evidenceFreshness({ revision }, input.currentRevision);
  if (["current", "stale", "unknown", "unchecked"].includes(input.freshness))
    return input.freshness;
  return evidenceFreshness({ revision });
}

export function evidenceFreshness(evidence, currentRevision) {
  const snapshotRevision = revisionValue(evidence?.revision);
  const current = revisionValue(currentRevision);
  if (!snapshotRevision) return "unknown";
  if (!current) return "unchecked";
  return snapshotRevision === current ? "current" : "stale";
}

export const getEvidenceFreshness = evidenceFreshness;

/**
 * Register a trusted source snapshot and attach it to one run.
 * The evidence ID is globally unique. Legacy prompt IDs such as S1 or N2 are
 * retained as aliases, scoped to the supplied run through runEvidence.
 */
export function registerEvidence(store, runId, input) {
  if (
    !store ||
    typeof store.put !== "function" ||
    typeof store.get !== "function"
  )
    throw new TypeError("Evidence registration requires a record store.");
  if (typeof runId !== "string" || !runId.trim())
    throw new TypeError("Evidence registration requires a run ID.");
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Evidence input must be a trusted snapshot object.");
  if (typeof input.title !== "string" || !input.title.trim())
    throw new TypeError("Evidence requires a trusted source title.");
  if (typeof input.text !== "string")
    throw new TypeError("Evidence requires the exact retrieved text.");
  if (typeof input.kind !== "string" || !input.kind.trim())
    throw new TypeError("Evidence requires a content kind.");

  const id = snapshotId(input);
  const revision = revisionValue(input.revision);
  const handles = aliasesFor(input, id);
  const {
    currentRevision: _currentRevision,
    handles: _handles,
    aliases: _aliases,
    handle: _handle,
    promptHandle: _promptHandle,
    label: _label,
    freshness: _freshness,
    legacySnapshot: _legacySnapshot,
    registeredAt: _registeredAt,
    snapshotVersion: _snapshotVersion,
    updatedAt: _updatedAt,
    ...sourceFields
  } = input;

  const persist = () => {
    const existing = store.get("evidenceSnapshot", id);
    const snapshot = {
      ...sourceFields,
      id,
      title: input.title,
      text: input.text,
      kind: input.kind,
      revision: revision ?? null,
      legacySnapshot: !revision,
      registeredAt:
        existing?.registeredAt ||
        input.registeredAt ||
        new Date().toISOString(),
      snapshotVersion: 1,
    };
    if (existing) {
      const {
        updatedAt: _oldUpdatedAt,
        handles: _oldHandles,
        freshness: _oldFreshness,
        ...oldSnapshot
      } = existing;
      if (stableStringify(oldSnapshot) !== stableStringify(snapshot))
        throw new Error(`Evidence ID collision for ${id}.`);
    } else {
      store.put("evidenceSnapshot", snapshot);
    }
    store.put("runEvidence", {
      id: `${runId}:${id}`,
      runId,
      evidenceId: id,
      handles,
      freshness: registrationFreshness(input, revision),
      state: "available",
    });
    return {
      ...snapshot,
      handles,
      freshness: registrationFreshness(input, revision),
    };
  };
  return typeof store.transaction === "function"
    ? store.transaction(persist)
    : persist();
}

export function getEvidence(store, runId, evidenceId) {
  if (!store || typeof store.get !== "function") return undefined;
  const link = store.get("runEvidence", `${runId}:${evidenceId}`);
  if (!link) return undefined;
  const evidence = store.get("evidenceSnapshot", link.evidenceId);
  if (!evidence) return undefined;
  return {
    ...evidence,
    handles: strings(link.handles || []),
    freshness: link.freshness || evidenceFreshness(evidence),
  };
}

export function listEvidence(store, runId) {
  if (!store || typeof store.list !== "function") return [];
  return store
    .list("runEvidence")
    .filter((link) => link.runId === runId)
    .map((link) => getEvidence(store, runId, link.evidenceId))
    .filter(Boolean);
}

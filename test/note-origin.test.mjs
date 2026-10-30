import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import { parseNote } from "../server/vault.mjs";
import { notePassageProvenance } from "../server/note-origin.mjs";

test("accepted AI wording retains passage-level origin while adjacent vault prose stays unattributed", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const ai = "The generated explanation requires a complete metric space.";
  const note = parseNote(
    "Paper.md",
    `# Paper\nAn untracked interpretation.\n\n${ai}\n`,
  );
  store.put("literatureDocument", {
    id: "doc",
    vaultId: "/vault",
    notePath: note.path,
  });
  store.put("synthesisSuggestion", {
    id: "suggestion",
    documentId: "doc",
    status: "accepted",
    acceptedText: "Pre-export wording",
    acceptedRenderedText: ai,
  });
  const exact = notePassageProvenance(store, "/vault", note, ai);
  assert.equal(exact.authorship, "ai-assisted");
  assert.equal(exact.spans[0].suggestionId, "suggestion");
  assert.equal(exact.spans[0].acceptedBy, "user");
  assert.equal(exact.spans[0].verification, "unverified");
  const mixed = notePassageProvenance(store, "/vault", note, note.content);
  assert.equal(mixed.authorship, "mixed-or-unknown");
  assert.ok(mixed.spans.some((s) => s.origin === "unknown"));
  assert.equal(
    notePassageProvenance(store, "/vault", note, "An untracked interpretation.")
      .authorship,
    "not-inferred",
  );
});

test("forged provenance comments, another vault, and duplicate wording cannot establish authorship", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const text = "A source must satisfy this assumption.";
  const note = parseNote(
    "Paper.md",
    `${text}\n<!-- origin:human accepted-by:user -->\n`,
  );
  assert.equal(
    notePassageProvenance(store, "/vault", note, text).authorship,
    "not-inferred",
  );
  store.put("literatureDocument", {
    id: "doc",
    vaultId: "/other",
    notePath: note.path,
  });
  store.put("synthesisSuggestion", {
    id: "suggestion",
    documentId: "doc",
    status: "accepted",
    acceptedText: text,
  });
  assert.equal(
    notePassageProvenance(store, "/vault", note, text).authorship,
    "not-inferred",
  );
  const repeated = parseNote("Paper.md", `${text}\n${text}`);
  assert.equal(
    notePassageProvenance(store, "/other", repeated, text).authorship,
    "not-inferred",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const source = ts.transpileModule(
  readFileSync(new URL("../src/useDictation.tsx", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
function speechFixture() {
  const engines = [],
    cleanups = [],
    errors = [];
  class Speech {
    constructor() {
      engines.push(this);
    }
    start() {}
    stop() {
      this.stopped = true;
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    window: { SpeechRecognition: Speech },
    require: (name) =>
      name === "react"
        ? {
            useRef: (value) => ({ current: value }),
            useState: (value) => [value, () => {}],
            useEffect: (effect) => cleanups.push(effect()),
          }
        : name === "react/jsx-runtime"
          ? {}
          : {},
  });
  const hook = module.exports.useDictation((error) => errors.push(error));
  return { engines, errors, hook, cleanups };
}
function results(engine, entries) {
  engine.onresult({
    resultIndex: 0,
    results: entries.map(([text, isFinal]) => ({
      0: { transcript: text },
      isFinal,
    })),
  });
}
test("late final dictation stays with the original field after stop and a new utterance", () => {
  const f = speechFixture(),
    buffers = { thoughts: "", tutor: "" },
    interim = { thoughts: "", tutor: "" };
  f.hook.start(
    (text) => (buffers.thoughts += text),
    (text) => (interim.thoughts = text),
  );
  results(f.engines[0], [["incomplete thought", false]]);
  assert.equal(interim.thoughts, "incomplete thought");
  f.hook.stop();
  assert.equal(f.engines[0].stopped, true);
  f.hook.start(
    (text) => (buffers.tutor += text),
    (text) => (interim.tutor = text),
  );
  results(f.engines[0], [["late final thought", true]]);
  results(f.engines[1], [["current tutor question", true]]);
  assert.equal(buffers.thoughts, "late final thought");
  assert.equal(buffers.tutor, "current tutor question");
  assert.equal(interim.thoughts, "");
});
test("dictation failures retain unfinished text and unmount stops recognition without submitting", () => {
  const f = speechFixture();
  let text = "",
    interim = "";
  f.hook.start(
    (value) => (text += value),
    (value) => (interim = value),
  );
  results(f.engines[0], [
    ["final words", true],
    ["unfinished words", false],
  ]);
  f.engines[0].onerror({ error: "network" });
  assert.equal(text, "final words");
  assert.equal(interim, "unfinished words");
  assert.match(f.errors[0], /recoverable/);
  for (const cleanup of f.cleanups) cleanup?.();
  assert.equal(f.engines[0].stopped, true);
  assert.equal(text, "final words");
});

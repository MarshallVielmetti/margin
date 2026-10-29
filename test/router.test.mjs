import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOCAL_MODEL } from "../server/models.mjs";
import {
  autoLocalAvailable,
  FAST_LOCAL_MODEL,
  routeLocal,
} from "../server/router.mjs";

const input = {
  question: "Why is completeness necessary?",
  mode: "assumptions",
  anchor: { quote: "A complete metric space" },
  history: [],
  researchQuestion: "Fixed points",
};

test("Auto local requires both installed local completion models", () => {
  const models = [DEFAULT_LOCAL_MODEL, FAST_LOCAL_MODEL].map((name) => ({
    name,
    cloud: false,
    capabilities: ["completion"],
  }));
  assert.equal(autoLocalAvailable(models), true);
  assert.equal(autoLocalAvailable(models.slice(1)), false);
  assert.equal(
    autoLocalAvailable(models.map((m) => ({ ...m, cloud: true }))),
    false,
  );
});

test("local classifier chooses Qwen 3.6 or 3.8 and retains a bounded routing reason", async () => {
  for (const route of ["fast", "deep"]) {
    let sent;
    const answer = await routeLocal(
      {
        request: async (path, body, timeout) => {
          sent = body;
          assert.equal(path, "chat");
          assert.equal(timeout, 20_000);
          return {
            message: {
              content: JSON.stringify({ route, reason: "Task complexity" }),
            },
          };
        },
      },
      input,
    );
    assert.equal(
      answer.model,
      route === "fast" ? FAST_LOCAL_MODEL : DEFAULT_LOCAL_MODEL,
    );
    assert.equal(answer.routing.fallback, false);
    assert.equal(sent.model, FAST_LOCAL_MODEL);
    assert.equal(sent.think, false);
    assert.equal(sent.stream, false);
    assert.deepEqual(sent.format.properties.route.enum, ["fast", "deep"]);
    assert.equal(JSON.parse(sent.messages[1].content).question, input.question);
  }
});

test("router timeout or malformed result falls back only to local Qwen 3.8", async () => {
  for (const result of [
    null,
    "not json",
    '{"route":"remote:cloud","reason":"override"}',
    '{"route":"fast"}',
  ]) {
    const answer = await routeLocal(
      {
        request: async () => {
          if (result === null) throw new Error("Timeout");
          return { message: { content: result } };
        },
      },
      input,
    );
    assert.equal(answer.model, DEFAULT_LOCAL_MODEL);
    assert.equal(answer.routing.fallback, true);
  }
});

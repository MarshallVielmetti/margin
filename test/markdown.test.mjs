import test from "node:test";
import assert from "node:assert/strict";
import { prepareMarkdown } from "../src/markdown-source.mjs";

test("callout labels never consume or restyle the next source line", () => {
  const text = ">[!assumption]\n>Communication delays are assumed bounded.\n";
  const result = prepareMarkdown(text);
  assert.equal(
    result,
    ">**assumption**\n>Communication delays are assumed bounded.\n",
  );
});

test("keeps code fences literal while resolving ordinary wiki aliases", () => {
  const result = prepareMarkdown(
    '[[Contraction|map]]\n```js\nconst x = "[[Literal]]";\n```\n',
  );
  assert.ok(result.startsWith("[map](#note=Contraction)"));
  assert.match(result, /\[\[Literal\]\]/);
});

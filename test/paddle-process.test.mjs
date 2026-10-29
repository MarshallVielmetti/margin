import test from "node:test";
import assert from "node:assert/strict";
import { runLocalProcess } from "../server/paddle.mjs";

test("cancelling a local extractor waits for the whole subprocess group to exit", async () => {
  const controller = new AbortController();
  let pid;
  await assert.rejects(
    runLocalProcess(
      process.execPath,
      [
        "-e",
        `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);console.log(child.pid);setInterval(()=>{},1000);`,
      ],
      {
        signal: controller.signal,
        onProgress: (line) => {
          pid = Number(line);
          controller.abort();
        },
      },
    ),
    /cancelled/,
  );
  assert.ok(Number.isInteger(pid));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
test("extractor timeouts terminate workers and report an actionable failure", async () => {
  await assert.rejects(
    runLocalProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeout: 100,
    }),
    /time limit/,
  );
});

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash, paddleLayout } from "./regions.mjs";

// Kill the whole process group: uv can have a Python worker beneath it.
// Wait for exit before removing its temporary output directory.
export function runLocalProcess(
  command,
  args,
  {
    signal,
    onProgress = () => {},
    timeout = 30 * 60 * 1000,
    env = process.env,
  } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped,
      env,
    });
    let log = "",
      timedOut = false,
      settled = false,
      killTimer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
      error ? reject(error) : resolve();
    };
    const kill = (type) => {
      if (!child.pid) return;
      try {
        grouped ? process.kill(-child.pid, type) : child.kill(type);
      } catch (error) {
        if (error.code !== "ESRCH") finish(error);
      }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 5000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    const record = (chunk) => {
      log = (log + chunk.toString()).slice(-3000);
      onProgress(
        log
          .split(/[\r\n]+/)
          .filter(Boolean)
          .at(-1)
          ?.replace(/\x1b\[[0-9;]*m/g, "")
          .slice(0, 200) || "Running PaddleOCR",
      );
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.once("error", (error) =>
      finish(
        new Error(
          `Cannot start PaddleOCR: ${error.message}. Install uv and see extraction setup in README.`,
        ),
      ),
    );
    child.once("close", (code) =>
      finish(
        signal?.aborted
          ? new Error("Intake cancelled.")
          : timedOut
            ? new Error("PaddleOCR exceeded its intake time limit.")
            : code === 0
              ? null
              : new Error(`PaddleOCR failed (${code}). ${log.slice(-1800)}`),
      ),
    );
  });
}

export async function extractPaddle(
  sourceId,
  file,
  signal,
  onProgress = () => {},
) {
  const dir = await mkdtemp(join(tmpdir(), "margin-paddle-"));
  const project = fileURLToPath(new URL("../extraction/", import.meta.url));
  const output = join(dir, "regions.json");
  try {
    await runLocalProcess(
      "uv",
      [
        "run",
        "--locked",
        "--project",
        project,
        "--extra",
        "paddle",
        "python",
        join(project, "paddle_extract.py"),
        file,
        output,
      ],
      {
        signal,
        onProgress,
        env: {
          ...process.env,
          PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
          HF_HUB_DISABLE_TELEMETRY: "1",
          HF_HUB_DISABLE_PROGRESS_BARS: "1",
        },
      },
    );
    signal?.throwIfAborted();
    return paddleLayout(
      sourceId,
      hash(new Uint8Array(await readFile(file))),
      JSON.parse(await readFile(output, "utf8")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

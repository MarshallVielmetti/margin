import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "./vault.mjs";

// Shared by reviewed promotions and the continuously edited literature document.
// The caller guards the vault path and serializes operations for that document.
export function atomicNoteWrite(file, text, expectedHash) {
  const check = () => {
    const current = existsSync(file)
      ? digest(readFileSync(file, "utf8"))
      : null;
    if (current !== expectedHash)
      throw Object.assign(
        new Error(
          "The note changed while saving. Your local revision is retained.",
        ),
        { status: 409 },
      );
  };
  check();
  if (expectedHash === null) {
    writeFileSync(file, text, { flag: "wx" });
    return;
  }
  const temporary = join(dirname(file), `.margin-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: "wx" });
    check();
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

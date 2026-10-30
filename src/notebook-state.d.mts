import type { Anchor, Artifact, NotebookDraft, NotebookMode } from "./types";
export const notebookModes: NotebookMode[];
export function nextNotebookMode(
  mode: NotebookMode,
  backwards?: boolean,
): NotebookMode;
export function freezeDraft(
  draft: NotebookDraft,
  text: string,
  anchor: Anchor,
): NotebookDraft;
export function synthesisTabAction(
  text: string,
  start: number,
  end: number,
  backwards?: boolean,
): { text: string; start: number; end: number } | null;
export function tutorThreads(
  artifacts: Artifact[],
): { id: string; question: Artifact | null; answers: Artifact[] }[];

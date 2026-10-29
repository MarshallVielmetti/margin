export const source = {
  id: "monotonic-two-column-paper",
  title: "Monotonic Two-column Reference Fixture",
  kind: "pdf",
  fingerprint: "fixture-two-column-v1",
  pages: [
    "Main text with a references section on the next page.",
    [
      "References",
      "[1] First column entry.",
      "[2] Second column entry.",
      "[3] Third column entry.",
      "[4] Fourth column entry.",
    ].join("\n"),
  ],
  extraction: {
    method: "pdfjs-text",
    parserVersion: "pdfjs-layout-v1",
    status: "ambiguous",
    pages: [
      { page: 1, status: "text_extracted", layout: "single-column" },
      { page: 2, status: "ambiguous", layout: "two-column" },
    ],
  },
};

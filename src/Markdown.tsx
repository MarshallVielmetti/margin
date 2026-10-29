import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { prepareMarkdown } from "./markdown-source.mjs";
import { remarkCitations } from "./citations.mjs";
import type { CitationContext, CitationEvidence } from "./citations.mjs";
import { Citation } from "./Citation";
import type { Anchor } from "./types";
import "./citation.css";

export function Markdown({
  text,
  onNote,
  evidence,
  citationContext,
  onAnchor,
}: {
  text: string;
  onNote?: (title: string) => void;
  evidence?: CitationEvidence[];
  citationContext?: Partial<CitationContext>;
  onAnchor?: (anchor: Anchor) => void;
}) {
  const processed = prepareMarkdown(text);
  const components = {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
      href?.startsWith("#note=") ? (
        <button
          className="wiki-link"
          onClick={() => onNote?.(decodeURIComponent(href.slice(6)))}
        >
          {children}
        </button>
      ) : (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      ),
    citation: ({
      handle,
      original,
    }: {
      handle?: string;
      original?: string;
    }) => (
      <Citation
        handle={handle || ""}
        original={original || ""}
        evidence={evidence}
        citationContext={citationContext}
        onAnchor={onAnchor}
      />
    ),
    img: ({ src, alt }: { src?: string; alt?: string }) => (
      <span className="muted">
        [Image: {alt || "embedded image"}
        {src?.startsWith("http") ? " · open in the original note" : ""}]
      </span>
    ),
  };
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, [remarkCitations, { evidence }]]}
        rehypePlugins={[[rehypeKatex, { strict: false, trust: false }]]}
        urlTransform={(url) =>
          /^(obsidian|zotero):\/\//.test(url) ? url : defaultUrlTransform(url)
        }
        components={components}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}

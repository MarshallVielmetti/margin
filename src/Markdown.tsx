import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { prepareMarkdown } from "./markdown-source.mjs";

export function Markdown({
  text,
  onNote,
}: {
  text: string;
  onNote?: (title: string) => void;
}) {
  const processed = prepareMarkdown(text);
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, trust: false }]]}
        urlTransform={(url) =>
          /^(obsidian|zotero):\/\//.test(url) ? url : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children }) =>
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
          img: ({ src, alt }) => (
            <span className="muted">
              [Image: {alt || "embedded image"}
              {src?.startsWith("http") ? " · open in the original note" : ""}]
            </span>
          ),
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}

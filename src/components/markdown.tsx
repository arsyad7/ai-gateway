"use client";

import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders model output as GitHub-flavored Markdown. Raw HTML in the text is
 * never rendered (react-markdown escapes it), so untrusted model output is safe.
 * Styles live under `.md` in globals.css.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Fenced code block with a language label and a copy button. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    return <pre>{children}</pre>;
  }
  const lang = /language-([\w+-]+)/.exec(child.props.className ?? "")?.[1] ?? "text";
  const code = String(child.props.children ?? "").replace(/\n$/, "");

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable (e.g. plain http on another device) */
    }
  }

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang}</span>
        <button type="button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{child}</pre>
    </div>
  );
}

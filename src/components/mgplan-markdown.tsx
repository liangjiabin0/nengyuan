'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MgplanMarkdown({ content }: { content: string }) {
  if (!content.trim()) {
    return <p className="text-sm text-muted-foreground">还没有正文。</p>;
  }
  return (
    <div className="prose-corpus text-sm leading-7 text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-3 text-[15px] font-semibold first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1.5 mt-2.5 text-sm font-semibold first:mt-0">{children}</h3>,
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-amber-400/70 pl-3 text-muted-foreground">{children}</blockquote>
          ),
          code: ({ children }) => <code className="rounded-md bg-muted px-1.5 py-0.5 text-[0.9em]">{children}</code>,
          pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-lg bg-muted/70 p-3 text-xs">{children}</pre>,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="min-w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-border/70 px-3 py-2 align-top">{children}</td>
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

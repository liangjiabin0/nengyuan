'use client';

import { useEffect, useState, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MathPlugins = {
  remarkMath: typeof import('remark-math').default;
  rehypeKatex: typeof import('rehype-katex').default;
};

export function ChatMarkdown({
  children,
  enableMath = false,
  components
}: {
  children: string;
  enableMath?: boolean;
  components: ComponentProps<typeof ReactMarkdown>['components'];
}) {
  const [math, setMath] = useState<MathPlugins | null>(null);

  useEffect(() => {
    if (!enableMath) {
      setMath(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      import('katex/dist/katex.min.css'),
      import('remark-math'),
      import('rehype-katex')
    ]).then(([, remarkMathMod, rehypeKatexMod]) => {
      if (cancelled) return;
      setMath({
        remarkMath: remarkMathMod.default,
        rehypeKatex: rehypeKatexMod.default
      });
    });
    return () => {
      cancelled = true;
    };
  }, [enableMath]);

  const remarkPlugins = math
    ? ([[math.remarkMath, { singleDollarTextMath: true }], remarkGfm] as ComponentProps<typeof ReactMarkdown>['remarkPlugins'])
    : ([remarkGfm] as ComponentProps<typeof ReactMarkdown>['remarkPlugins']);
  const rehypePlugins = math
    ? ([math.rehypeKatex] as ComponentProps<typeof ReactMarkdown>['rehypePlugins'])
    : undefined;

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {children}
    </ReactMarkdown>
  );
}

'use client';

import Markdown from 'react-markdown';

import { MermaidDiagram } from './mermaid-diagram';

interface PatternContentProps {
  content: string;
}

/**
 * Renders markdown content with special handling for mermaid code blocks.
 * Mermaid blocks are extracted and rendered via the MermaidDiagram client component.
 */
export function PatternContent({ content }: PatternContentProps) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <Markdown
        components={{
          code({ className, children, ...props }) {
            const match = /language-mermaid/.exec(className ?? '');
            if (match) {
              const text = typeof children === 'string' ? children : '';
              return <MermaidDiagram code={text.trim()} />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre({ children, node, ...props }) {
            // Skip the <pre> wrapper for mermaid blocks (rendered by the code override above)
            const codeEl = node?.children?.find(
              (c): c is typeof c & { tagName: string; properties?: { className?: string[] } } =>
                'tagName' in c && c.tagName === 'code'
            );
            const isMermaid = codeEl?.properties?.className?.some((cls: string) =>
              cls.includes('language-mermaid')
            );
            if (isMermaid) return <>{children}</>;
            return <pre {...props}>{children}</pre>;
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';

interface MermaidDiagramProps {
  code: string;
}

let mermaidInitialized = false;

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      if (!containerRef.current) return;

      try {
        const mermaid = (await import('mermaid')).default;
        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            theme: 'neutral',
            securityLevel: 'loose',
          });
          mermaidInitialized = true;
        }

        const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
        const { svg } = await mermaid.render(id, code);

        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
          setLoading(false);
        }
      }
    }

    void render();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="bg-muted overflow-x-auto rounded-lg border p-4">
        <pre className="text-sm whitespace-pre-wrap">
          <code>{code}</code>
        </pre>
        <p className="text-muted-foreground mt-2 text-xs">Diagram could not be rendered</p>
      </div>
    );
  }

  return (
    <div className="my-4">
      {loading && <div className="bg-muted h-48 animate-pulse rounded-lg" />}
      <div ref={containerRef} className="overflow-x-auto [&>svg]:mx-auto" />
    </div>
  );
}

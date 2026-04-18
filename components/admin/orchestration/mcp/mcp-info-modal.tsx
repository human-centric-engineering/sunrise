'use client';

/**
 * MCP Info Modal
 *
 * Educational modal explaining MCP concepts. Triggered by (i) icon
 * on MCP admin pages.
 */

import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

interface McpInfoModalProps {
  title: string;
  children: React.ReactNode;
}

export function McpInfoModal({ title, children }: McpInfoModalProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={`Info: ${title}`}>
          <Info className="text-muted-foreground h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="text-muted-foreground space-y-3 text-sm">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

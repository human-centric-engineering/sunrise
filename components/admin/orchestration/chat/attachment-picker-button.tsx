'use client';

/**
 * AttachmentPickerButton — open a hidden file input, encode the picked
 * files as base64 via `useAttachments`, and render a thumbnail strip
 * with per-attachment remove buttons.
 *
 * Designed to sit next to `<MicButton>` in `AgentTestChat`. Image
 * thumbnails use `URL.createObjectURL` (revoked on remove / clear /
 * unmount inside the hook). PDFs and other documents render as a
 * paperclip + filename + size chip.
 *
 * Paste support is opt-in via the `pasteTarget` prop — pass the parent
 * textarea's ref and a `paste` listener is bound that intercepts image
 * files from the clipboard. PDFs / docs from the clipboard are ignored
 * to keep the paste contract intuitive (Cmd+V pastes a screenshot, not
 * an arbitrary file). The user can drop a PDF onto the picker button
 * via the file picker dialog.
 */

import { useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { Paperclip, X, FileText, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  ATTACHMENT_ACCEPT_MIME,
  useAttachments,
  type AttachmentEntry,
  type UseAttachmentsResult,
} from '@/lib/hooks/use-attachments';
import type { ChatAttachment } from '@/lib/orchestration/chat/types';

export interface AttachmentPickerButtonProps {
  /** Set of MIMEs the input should accept. Defaults to image + PDF. */
  acceptMime?: readonly string[];
  /** Called whenever the attached list changes (after add / remove / clear). */
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  /** Called with a user-facing error string when validation rejects a file. */
  onError?: (message: string) => void;
  /** Disable the picker (e.g. while the chat is streaming a reply). */
  disabled?: boolean;
  /** Optional textarea ref to bind clipboard-paste image handling on. */
  pasteTarget?: React.RefObject<HTMLTextAreaElement | null>;
  /** Imperative handle for the parent — exposes `clear()` for "send" reset. */
  controlsRef?: React.MutableRefObject<{ clear: () => void } | null>;
  /** Additional class names for the button element. */
  className?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ThumbnailStrip({
  attachments,
  remove,
}: {
  attachments: AttachmentEntry[];
  remove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul
      className="flex flex-wrap items-center gap-2 pt-2"
      data-testid="attachment-thumbnail-strip"
      aria-label="Attached files"
    >
      {attachments.map((entry) => (
        <li
          key={entry.id}
          className="bg-muted/50 relative flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
        >
          {entry.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- Object URL is local, not remote
            <img
              src={entry.previewUrl}
              alt={entry.attachment.name}
              className="h-8 w-8 rounded object-cover"
            />
          ) : (
            <FileText className="h-4 w-4" aria-hidden="true" />
          )}
          <span className="max-w-[12rem] truncate" title={entry.attachment.name}>
            {entry.attachment.name}
          </span>
          <span className="text-muted-foreground tabular-nums">{formatBytes(entry.byteSize)}</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full"
            aria-label={`Remove ${entry.attachment.name}`}
            onClick={() => remove(entry.id)}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AttachmentPickerButton({
  acceptMime = ATTACHMENT_ACCEPT_MIME,
  onAttachmentsChange,
  onError,
  disabled = false,
  pasteTarget,
  controlsRef,
  className,
}: AttachmentPickerButtonProps) {
  const { attachments, error, attach, remove, clear, payload } = useAttachments();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isBusyRef = useRef(false);

  // Bubble error strings out as soon as they appear. The hook owns the
  // last-error state; this component is presentation only.
  useEffect(() => {
    if (error) onError?.(error);
  }, [error, onError]);

  // Propagate the attachment list upward whenever it changes so the
  // parent can include it in the next chat POST body.
  useEffect(() => {
    onAttachmentsChange?.(payload());
  }, [attachments, payload, onAttachmentsChange]);

  // Expose an imperative `clear()` to the parent so the chat surface
  // can reset attachments after sending without owning the state.
  useImperativeHandle(
    controlsRef ?? { current: null },
    () => ({
      clear: () => {
        clear();
      },
    }),
    [clear]
  );

  // Clipboard paste: when the user pastes into the linked textarea and
  // the clipboard contains an image file, capture it. Avoids
  // intercepting text or non-image paste contents.
  useEffect(() => {
    const target = pasteTarget?.current;
    if (!target) return;
    const handlePaste = (event: ClipboardEvent) => {
      if (disabled) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        event.preventDefault();
        void attach(files);
      }
    };
    target.addEventListener('paste', handlePaste);
    return () => target.removeEventListener('paste', handlePaste);
  }, [pasteTarget, attach, disabled]);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;
      isBusyRef.current = true;
      try {
        await attach(files);
      } finally {
        isBusyRef.current = false;
        // Clear the input value so picking the same file twice re-fires
        // the change event.
        event.target.value = '';
      }
    },
    [attach]
  );

  return (
    <div className="flex w-full flex-col">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Attach an image or PDF"
          onClick={handleClick}
          disabled={disabled}
          className={cn('shrink-0', className)}
          data-testid="attachment-picker-button"
        >
          {isBusyRef.current ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Paperclip className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept={acceptMime.join(',')}
          multiple
          hidden
          onChange={(e) => {
            void handleFileChange(e);
          }}
          data-testid="attachment-picker-input"
        />
      </div>
      <ThumbnailStrip attachments={attachments} remove={remove} />
    </div>
  );
}

/**
 * Re-export the underlying hook for parents that want full control over
 * attach / remove / clear without going through the imperative handle.
 */
export type AttachmentPickerControls = UseAttachmentsResult;

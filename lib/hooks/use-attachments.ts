'use client';

/**
 * useAttachments — manage a list of `ChatAttachment` entries for a chat
 * turn (image and PDF uploads). Owns base64 conversion, per-file and
 * combined size validation, and `object URL` lifecycle for previews.
 *
 * Validation mirrors `lib/validations/orchestration.ts:chatAttachmentSchema`
 * + `chatAttachmentsArraySchema` so the server cannot reject a payload
 * the client believed was acceptable.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatAttachment } from '@/lib/orchestration/chat/types';
import {
  MAX_CHAT_ATTACHMENT_BASE64_CHARS,
  MAX_CHAT_ATTACHMENT_COMBINED_BASE64_CHARS,
} from '@/lib/validations/orchestration';

const MAX_ATTACHMENTS_PER_TURN = 10;

/** Image MIME types — gated by the agent's `enableImageInput` toggle. */
export const IMAGE_ATTACHMENT_MIME = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

/** Document MIME types — gated by the agent's `enableDocumentInput` toggle. */
export const DOCUMENT_ATTACHMENT_MIME = ['application/pdf'] as const;

/** Full attachment MIME set. Picker callers pass the subset they want
 *  enabled — the union is only a backstop for callers that don't know
 *  which toggles are on. */
export const ATTACHMENT_ACCEPT_MIME = [
  ...IMAGE_ATTACHMENT_MIME,
  ...DOCUMENT_ATTACHMENT_MIME,
] as const;

export type AttachmentMime = (typeof ATTACHMENT_ACCEPT_MIME)[number];

export interface UseAttachmentsOptions {
  /**
   * Restrict the set of MIME types the hook accepts. When unset, every
   * documented MIME is allowed. Set this to the union of the toggles
   * that are actually on so a user with only `enableImageInput=true`
   * can't drag-and-drop a PDF past the picker. The route layer still
   * runs its own gate, but client-side rejection produces a clearer
   * "this agent doesn't accept PDFs" error than a server SSE event.
   */
  allowedMimes?: readonly string[];
}

export interface AttachmentEntry {
  /** Stable id for React list keys + remove() targeting. */
  id: string;
  attachment: ChatAttachment;
  /** Object URL for image previews; null for non-image attachments. */
  previewUrl: string | null;
  /** Raw byte size (post base64-decode) — used for the "X.X MB" preview chip. */
  byteSize: number;
}

export interface UseAttachmentsResult {
  attachments: AttachmentEntry[];
  /** Last validation / I/O error message, or null when clean. */
  error: string | null;
  /** Append the given files; rejected ones surface via `error`. */
  attach: (files: FileList | File[]) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
  /** Flat `ChatAttachment[]` for sending to the chat API. */
  payload: () => ChatAttachment[];
}

/**
 * Read a `File` as a base64 string without the data-URL prefix.
 *
 * `FileReader.readAsDataURL` returns `data:<mime>;base64,...`. We strip
 * the prefix because `chatAttachmentSchema.data` expects pure base64.
 * The reader is implicitly chunked — Chrome / Firefox / Safari handle
 * multi-MB files without blocking the main thread.
 */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error(`Unexpected reader result type for ${file.name}`));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function mintId(): string {
  // Slightly stronger than Math.random for React keys; not cryptographic.
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function describeAllowed(allowed: readonly string[]): string {
  const hasImages = allowed.some((m) => m.startsWith('image/'));
  const hasPdf = allowed.includes('application/pdf');
  if (hasImages && hasPdf) return 'JPEG, PNG, GIF, WebP, PDF';
  if (hasImages) return 'JPEG, PNG, GIF, WebP';
  if (hasPdf) return 'PDF';
  return 'none';
}

export function useAttachments(options: UseAttachmentsOptions = {}): UseAttachmentsResult {
  const allowedMimes = options.allowedMimes ?? ATTACHMENT_ACCEPT_MIME;
  const [attachments, setAttachments] = useState<AttachmentEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Track active object URLs so we can revoke them on remove / clear /
  // unmount. Without this the browser holds Blob references for the
  // entire session, leaking memory across many uploads.
  const objectUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const attach = useCallback(
    async (files: FileList | File[]) => {
      setError(null);
      const incoming = Array.from(files);

      // Hard cap on number of attachments per turn — matches server.
      // Reject the whole batch rather than partially adding, so the user
      // can adjust their selection and retry.
      if (attachments.length + incoming.length > MAX_ATTACHMENTS_PER_TURN) {
        setError(
          `You can attach at most ${MAX_ATTACHMENTS_PER_TURN} files per message (${attachments.length} already attached).`
        );
        return;
      }

      const newEntries: AttachmentEntry[] = [];

      // Revoke any object URLs minted so far in this batch and clear
      // them from the tracking set. Called before every early return so
      // a per-file validation failure on file N doesn't leave dangling
      // blob URLs for files 1…N-1 until the component unmounts.
      const rejectBatch = (message: string): void => {
        for (const entry of newEntries) {
          if (entry.previewUrl) {
            URL.revokeObjectURL(entry.previewUrl);
            objectUrlsRef.current.delete(entry.previewUrl);
          }
        }
        setError(message);
      };

      for (const file of incoming) {
        if (!allowedMimes.includes(file.type)) {
          rejectBatch(
            `${file.name}: unsupported file type "${file.type}". Allowed: ${describeAllowed(allowedMimes)}.`
          );
          return;
        }
        try {
          const base64 = await readFileAsBase64(file);
          if (base64.length === 0) {
            rejectBatch(`${file.name}: file is empty.`);
            return;
          }
          if (base64.length > MAX_CHAT_ATTACHMENT_BASE64_CHARS) {
            rejectBatch(
              `${file.name}: file exceeds the per-attachment 5 MB limit. Pick a smaller file or compress it.`
            );
            return;
          }
          const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
          if (previewUrl) objectUrlsRef.current.add(previewUrl);
          newEntries.push({
            id: mintId(),
            attachment: {
              name: file.name,
              mediaType: file.type,
              data: base64,
            },
            previewUrl,
            byteSize: file.size,
          });
        } catch (err) {
          rejectBatch(
            `${file.name}: ${err instanceof Error ? err.message : 'failed to read file'}.`
          );
          return;
        }
      }

      // Combined cap check applies to the resulting list, not the
      // incoming batch alone — a partial accept could silently bust
      // the per-turn cap.
      const combinedSize =
        attachments.reduce((sum, a) => sum + a.attachment.data.length, 0) +
        newEntries.reduce((sum, a) => sum + a.attachment.data.length, 0);
      if (combinedSize > MAX_CHAT_ATTACHMENT_COMBINED_BASE64_CHARS) {
        rejectBatch(
          'Combined attachment size exceeds the per-turn 25 MB limit. Remove some files and try again.'
        );
        return;
      }

      setAttachments((prev) => [...prev, ...newEntries]);
    },
    [attachments, allowedMimes]
  );

  const remove = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((entry) => entry.id === id);
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
        objectUrlsRef.current.delete(removed.previewUrl);
      }
      return prev.filter((entry) => entry.id !== id);
    });
    setError(null);
  }, []);

  const clear = useCallback(() => {
    setAttachments((prev) => {
      for (const entry of prev) {
        if (entry.previewUrl) {
          URL.revokeObjectURL(entry.previewUrl);
          objectUrlsRef.current.delete(entry.previewUrl);
        }
      }
      return [];
    });
    setError(null);
  }, []);

  const payload = useCallback(() => attachments.map((entry) => entry.attachment), [attachments]);

  return { attachments, error, attach, remove, clear, payload };
}

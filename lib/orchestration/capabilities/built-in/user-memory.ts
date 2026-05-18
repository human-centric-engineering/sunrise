/**
 * User Memory capabilities
 *
 * Per-user-per-agent key-value memory that persists across conversations.
 * Agents can remember user preferences, prior topics, and important facts
 * via tool calls.
 *
 * Two capabilities:
 *   - `read_user_memory`  — retrieve stored memories for the current user
 *   - `write_user_memory` — store or update a memory for the current user
 */

import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { redactedString } from '@/lib/security/redact';

// ── Read Memory ──────────────────────────────────────────────────────────────

const readSchema = z.object({
  key: z.string().min(1).max(255).optional(),
});

type ReadArgs = z.infer<typeof readSchema>;

interface MemoryEntry {
  key: string;
  value: string;
  updatedAt: string;
}

interface ReadData {
  memories: MemoryEntry[];
}

export class ReadUserMemoryCapability extends BaseCapability<ReadArgs, ReadData> {
  readonly slug = 'read_user_memory';
  readonly processesPii = true;

  /**
   * The `key` argument is a short structured label (e.g.
   * `preferred_language`, `favorite_topic`) — not PII. Memory `value`
   * fields, however, are exactly the kind of free-text the LLM
   * extracts from conversation context: "user's name is X", "their
   * address is Y", "they prefer to be called Z". Persisting those
   * verbatim in the chat message's audit row would defeat the point
   * of user-memory being scoped to the user/agent pair.
   *
   * Audit row keeps the `key` (so an auditor can confirm "memory for
   * preferred_language was read") + the count of returned entries;
   * each `value` becomes a sentinel.
   */
  redactProvenance(
    args: ReadArgs,
    result: CapabilityResult<ReadData>
  ): {
    args: unknown;
    resultPreview: string;
  } {
    if (result.success && result.data) {
      const safeData = {
        memories: result.data.memories.map((m) => ({
          key: m.key,
          value: redactedString('memory-value'),
          updatedAt: m.updatedAt,
        })),
      };
      return {
        args,
        resultPreview: JSON.stringify({ success: true, data: safeData }),
      };
    }
    return { args, resultPreview: JSON.stringify(result) };
  }

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'read_user_memory',
    description:
      'Read stored memories for the current user. Returns all memories if no key is specified, or a single memory by key.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description:
            'Optional key to look up a specific memory. Omit to retrieve all memories for this user.',
          minLength: 1,
          maxLength: 255,
        },
      },
      required: [],
    },
  };

  protected readonly schema = readSchema;

  async execute(args: ReadArgs, context: CapabilityContext): Promise<CapabilityResult<ReadData>> {
    const where: { userId: string; agentId: string; key?: string } = {
      userId: context.userId,
      agentId: context.agentId,
    };
    if (args.key) {
      where.key = args.key;
    }

    const rows = await prisma.aiUserMemory.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    return this.success({
      memories: rows.map((r) => ({
        key: r.key,
        value: r.value,
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  }
}

// ── Write Memory ─────────────────────────────────────────────────────────────

const writeSchema = z.object({
  key: z.string().min(1).max(255),
  value: z.string().min(1).max(5000),
});

type WriteArgs = z.infer<typeof writeSchema>;

interface WriteData {
  key: string;
  action: 'created' | 'updated';
}

export class WriteUserMemoryCapability extends BaseCapability<WriteArgs, WriteData> {
  readonly slug = 'write_user_memory';
  readonly processesPii = true;

  /**
   * The `value` parameter is up to 5000 chars of LLM-extracted user
   * fact — name, preference, address, schedule, anything the model
   * decided was worth remembering. Persisting it verbatim on the chat
   * message's audit row creates a second copy outside the per-user
   * memory store.
   *
   * Audit row keeps `key` (the label, useful for "was a preference
   * stored?" auditing) + the result envelope's structural fields
   * (created vs updated). Value is redacted.
   */
  redactProvenance(
    args: WriteArgs,
    result: CapabilityResult<WriteData>
  ): {
    args: unknown;
    resultPreview: string;
  } {
    const safeArgs = {
      key: args.key,
      value: redactedString(`memory-value, ${args.value.length} chars`),
    };
    return { args: safeArgs, resultPreview: JSON.stringify(result) };
  }

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'write_user_memory',
    description:
      'Store or update a memory about the current user. Use this to remember preferences, important context, or facts the user has shared.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description:
            'A short, descriptive key for this memory (e.g. "preferred_language", "favorite_topic", "project_name").',
          minLength: 1,
          maxLength: 255,
        },
        value: {
          type: 'string',
          description: 'The value to store. Can be a single value or a brief description.',
          minLength: 1,
          maxLength: 5000,
        },
      },
      required: ['key', 'value'],
    },
  };

  protected readonly schema = writeSchema;

  async execute(args: WriteArgs, context: CapabilityContext): Promise<CapabilityResult<WriteData>> {
    const existing = await prisma.aiUserMemory.findUnique({
      where: {
        userId_agentId_key: {
          userId: context.userId,
          agentId: context.agentId,
          key: args.key,
        },
      },
    });

    await prisma.aiUserMemory.upsert({
      where: {
        userId_agentId_key: {
          userId: context.userId,
          agentId: context.agentId,
          key: args.key,
        },
      },
      create: {
        userId: context.userId,
        agentId: context.agentId,
        key: args.key,
        value: args.value,
      },
      update: {
        value: args.value,
      },
    });

    return this.success({
      key: args.key,
      action: existing ? 'updated' : 'created',
    });
  }
}

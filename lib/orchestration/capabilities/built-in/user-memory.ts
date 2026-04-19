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

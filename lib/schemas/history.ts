import { z } from 'zod';

import { publicIpSchema } from './provider.js';

export const HISTORY_VERSION = 1;
export const historyEventSchema = z.object({
  at: z.string(),
  status: z.string(),
  ip: publicIpSchema,
  discoveryErrors: z
    .object({
      v4: z.boolean(),
      v6: z.boolean(),
    })
    .optional(),
  message: z.string(),
  forced: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  durationMs: z.number(),
  accountId: z.string().optional(),
  cycle: z.number().int(),
  /** Compact failure list for post-restart diagnose (no provider detail blobs). */
  failedHosts: z
    .array(
      z.object({
        host: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});

export const historyFileSchema = z.object({
  version: z.literal(HISTORY_VERSION),
  events: z.array(historyEventSchema),
});

export type HistoryEvent = z.infer<typeof historyEventSchema>;
export type HistoryFile = z.infer<typeof historyFileSchema>;

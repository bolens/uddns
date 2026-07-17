import { z } from 'zod';

import { providerIdSchema, publicIpSchema } from './provider.js';

export const stateFileSchema = z.object({
  version: z.literal(1),
  provider: providerIdSchema,
  hosts: z.record(z.string().min(1), publicIpSchema),
});

export type StateFile = z.infer<typeof stateFileSchema>;

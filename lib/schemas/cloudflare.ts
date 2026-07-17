import { z } from 'zod';

export const cloudflareErrorSchema = z.object({
  code: z.number().optional(),
  message: z.string().optional(),
});

const cloudflareZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const cloudflareDnsRecordSchema = z.object({
  id: z.string(),
  content: z.string(),
  proxied: z.boolean(),
  ttl: z.number().int().optional(),
});

export const cloudflareEnvelopeSchema = z.object({
  success: z.boolean().optional(),
  result: z.unknown().optional(),
  errors: z.array(cloudflareErrorSchema).optional(),
  messages: z.array(z.unknown()).optional(),
});

export const cloudflareZonesResponseSchema = z.object({
  success: z.boolean().optional(),
  result: z.array(cloudflareZoneSchema).optional(),
  errors: z.array(cloudflareErrorSchema).optional(),
  messages: z.array(z.unknown()).optional(),
});

export const cloudflareRecordResponseSchema = z.object({
  success: z.boolean().optional(),
  result: cloudflareDnsRecordSchema.nullable().optional(),
  errors: z.array(cloudflareErrorSchema).optional(),
  messages: z.array(z.unknown()).optional(),
});

export const cloudflareRecordsResponseSchema = z.object({
  success: z.boolean().optional(),
  result: z.array(cloudflareDnsRecordSchema).optional(),
  errors: z.array(cloudflareErrorSchema).optional(),
  messages: z.array(z.unknown()).optional(),
});

export type CloudflareError = z.infer<typeof cloudflareErrorSchema>;
export type CloudflareDnsRecord = z.infer<typeof cloudflareDnsRecordSchema>;
export type CloudflareEnvelope = z.infer<typeof cloudflareEnvelopeSchema>;

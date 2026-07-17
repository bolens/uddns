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

function cloudflareResponse<T extends z.ZodTypeAny>(result: T) {
  return z.object({
    success: z.boolean().optional(),
    result: result.optional(),
    errors: z.array(cloudflareErrorSchema).optional(),
    messages: z.array(z.unknown()).optional(),
  });
}

export const cloudflareEnvelopeSchema = cloudflareResponse(z.unknown());

export const cloudflareZonesResponseSchema = cloudflareResponse(z.array(cloudflareZoneSchema));

export const cloudflareRecordResponseSchema = cloudflareResponse(
  cloudflareDnsRecordSchema.nullable(),
);

export const cloudflareRecordsResponseSchema = cloudflareResponse(
  z.array(cloudflareDnsRecordSchema),
);

export type CloudflareError = z.infer<typeof cloudflareErrorSchema>;
export type CloudflareDnsRecord = z.infer<typeof cloudflareDnsRecordSchema>;
export type CloudflareEnvelope = z.infer<typeof cloudflareEnvelopeSchema>;

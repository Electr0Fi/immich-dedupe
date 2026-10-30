import { z } from "zod";

const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ExecutionRequestSchema = z.object({
  dryRun: z.boolean().default(true),
  scanLimit: limit.optional(),
  executeLimit: limit.optional(),
  limit: limit.optional(),
}).transform((body) => ({
  dryRun: body.dryRun,
  scanLimit: body.scanLimit ?? body.limit ?? 100,
  executeLimit: body.executeLimit ?? body.limit ?? 10,
}));

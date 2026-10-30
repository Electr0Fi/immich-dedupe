import { z } from "zod";

const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const CreatePlanSchema = z.object({ scanLimit: limit.default(100), executeLimit: limit.default(10) }).strict();
export const ReviewedRunSchema = z.object({
  selectedGroupIds: z.array(z.string().min(1)).nonempty().refine((ids) => new Set(ids).size === ids.length),
  dryRun: z.boolean().default(true),
}).strict();
export const PrepareQuickSelectionSchema = z.object({
  selectedGroupIds: z.array(z.string().min(1)).nonempty().refine((ids) => new Set(ids).size === ids.length),
  executeLimit: limit,
}).strict();
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

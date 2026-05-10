import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  IMMICH_URL: z.string().url(),
  IMMICH_API_KEY: z.string().min(1),
});

export const env = EnvSchema.parse(process.env);
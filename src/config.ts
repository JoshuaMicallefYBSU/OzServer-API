import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  PLUGIN_TOKEN: z.string().min(24),
  WEBSITE_ORIGIN: z.string().url().default("https://ozserver.org"),
  DISCONNECT_GRACE_MINUTES: z.coerce.number().positive().default(5),
  RESUME_WINDOW_MINUTES: z.coerce.number().positive().default(5),
  FDR_RETAIN_MINUTES: z.coerce.number().positive().default(15),
  ATIS_RETAIN_MINUTES: z.coerce.number().positive().default(90)
});

export const config = schema.parse(process.env);

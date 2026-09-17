import { envSchema } from "@/shared/schemas/env.ts";
export const env = envSchema.parse(process.env);

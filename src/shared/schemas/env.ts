import { z } from "zod";

export const envSchema = z.object({
  DATABASE_URL: z.url().default("postgres://localhost/caps"),
  PORT: z.coerce.number().default(4000),
  DHIS2_USERNAME: z.string().default("username"),
  DHIS2_PASSWORD: z.string().default("password"),
  DHIS2_BASE_URL: z.url().default("https://localhost:8080"),
  RABBITMQ_URL: z.url().default("amqp://localhost"),
  CHAP_BASE_URL: z.url(),
  CHAP_API_TOKEN: z.string().optional(),
  OUTPUTS_DIR: z.string().default("./outputs"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(""),
  CLIMATE_DATA_BASE_URL: z.url().default("http://localhost:8081"),
  CLIMATE_API_BASE_URL: z.url().default("http://localhost:8001"),
});

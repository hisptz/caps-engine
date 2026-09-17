import { PrismaClient } from "@db/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

export function createDbClient() {
  return new PrismaClient({
    adapter,
    log: ["error"],
  });
}

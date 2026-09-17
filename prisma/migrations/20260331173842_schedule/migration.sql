-- CreateEnum
CREATE TYPE "ConcurrencyPolicy" AS ENUM ('ALLOW', 'SKIP', 'REPLACE');

-- AlterTable
ALTER TABLE "pipelines" ADD COLUMN     "concurrencyPolicy" "ConcurrencyPolicy" NOT NULL DEFAULT 'SKIP',
ADD COLUMN     "cronExpression" TEXT,
ADD COLUMN     "lastScheduledAt" TIMESTAMP(3),
ADD COLUMN     "timezone" TEXT DEFAULT 'UTC';

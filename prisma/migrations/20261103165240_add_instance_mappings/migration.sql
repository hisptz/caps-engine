-- Instance mappings: staging data elements paired with items on a connected instance, each
-- pulled (instance → staging) or pushed (staging → instance), plus per-instance settings.
-- Only one instance can pull into a staging data element (unique pullTarget).

-- CreateEnum
CREATE TYPE "OrgUnitMatch" AS ENUM ('ID', 'CODE');

-- CreateEnum
CREATE TYPE "MappingDirection" AS ENUM ('PULL', 'PUSH');

-- CreateEnum
CREATE TYPE "RemoteItemType" AS ENUM ('DATA_ELEMENT', 'INDICATOR', 'PROGRAM_INDICATOR');

-- CreateTable
CREATE TABLE "connected_instances" (
    "routeCode" TEXT NOT NULL,
    "orgUnitMatch" "OrgUnitMatch" NOT NULL DEFAULT 'ID',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connected_instances_pkey" PRIMARY KEY ("routeCode")
);

-- CreateTable
CREATE TABLE "instance_mappings" (
    "id" UUID NOT NULL,
    "routeCode" TEXT NOT NULL,
    "direction" "MappingDirection" NOT NULL,
    "remoteItem" TEXT NOT NULL,
    "remoteItemType" "RemoteItemType" NOT NULL,
    "stagingDataElement" TEXT NOT NULL,
    "pullTarget" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instance_mappings_pullTarget_key" ON "instance_mappings"("pullTarget");

-- CreateIndex
CREATE UNIQUE INDEX "instance_mappings_routeCode_stagingDataElement_key" ON "instance_mappings"("routeCode", "stagingDataElement");

-- CreateIndex
CREATE UNIQUE INDEX "instance_mappings_routeCode_remoteItem_key" ON "instance_mappings"("routeCode", "remoteItem");

-- AddForeignKey
ALTER TABLE "instance_mappings" ADD CONSTRAINT "instance_mappings_routeCode_fkey" FOREIGN KEY ("routeCode") REFERENCES "connected_instances"("routeCode") ON DELETE CASCADE ON UPDATE CASCADE;

-- pullTarget always follows direction
ALTER TABLE "instance_mappings" ADD CONSTRAINT "instance_mappings_pull_target_check" CHECK (
  ("direction" = 'PUSH' AND "pullTarget" IS NULL) OR
  ("direction" = 'PULL' AND "pullTarget" = "stagingDataElement")
);

-- Only data elements can receive pushed values
ALTER TABLE "instance_mappings" ADD CONSTRAINT "instance_mappings_push_type_check" CHECK (
  "direction" = 'PULL' OR "remoteItemType" = 'DATA_ELEMENT'
);

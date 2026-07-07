-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RevoProjectKind" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "RevoProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETED');

-- CreateTable
CREATE TABLE "RevoProject" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "kind" "RevoProjectKind" NOT NULL DEFAULT 'USER',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "RevoProjectStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "RevoProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isRoot" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Revision" (
    "id" TEXT NOT NULL,
    "sequence" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comment" TEXT NOT NULL DEFAULT '',
    "isHead" BOOLEAN NOT NULL DEFAULT false,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "isStart" BOOLEAN NOT NULL DEFAULT false,
    "hasChanges" BOOLEAN NOT NULL DEFAULT false,
    "branchId" TEXT NOT NULL,
    "parentId" TEXT,

    CONSTRAINT "Revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Table" (
    "versionId" TEXT NOT NULL,
    "createdId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "readonly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "system" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Table_pkey" PRIMARY KEY ("versionId")
);

-- CreateTable
CREATE TABLE "Row" (
    "versionId" TEXT NOT NULL,
    "createdId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "readonly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "hash" TEXT NOT NULL,
    "schemaHash" TEXT NOT NULL,

    CONSTRAINT "Row_pkey" PRIMARY KEY ("versionId")
);

-- CreateTable
CREATE TABLE "FileBlob" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "projectId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "size" BIGINT NOT NULL,

    CONSTRAINT "FileBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectFileUsage" (
    "projectId" TEXT NOT NULL,
    "fileBytes" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectFileUsage_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "TableMigration" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "sourceTableVersionId" TEXT NOT NULL,
    "shadowTableVersionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "phase" TEXT NOT NULL DEFAULT 'INIT',
    "patches" JSONB NOT NULL,
    "previousSchema" JSONB NOT NULL,
    "previousSchemaHash" TEXT NOT NULL,
    "targetSchemaHash" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "copiedRows" INTEGER NOT NULL DEFAULT 0,
    "lastCopiedRowId" TEXT,
    "batchSize" INTEGER NOT NULL DEFAULT 1000,
    "currentBatch" INTEGER NOT NULL DEFAULT 0,
    "totalBatches" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastProgressAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "TableMigration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_RevisionToTable" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_RevisionToTable_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_RowToTable" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_RowToTable_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_FileBlobToRow" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_FileBlobToRow_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "RevoProject_slug_key" ON "RevoProject"("slug");

-- CreateIndex
CREATE INDEX "RevoProject_status_idx" ON "RevoProject"("status");

-- CreateIndex
CREATE INDEX "RevoProject_kind_status_idx" ON "RevoProject"("kind", "status");

-- CreateIndex
CREATE INDEX "RevoProject_deletedAt_idx" ON "RevoProject"("deletedAt");

-- CreateIndex
CREATE INDEX "Branch_projectId_idx" ON "Branch"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_name_projectId_key" ON "Branch"("name", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Revision_sequence_key" ON "Revision"("sequence");

-- CreateIndex
CREATE INDEX "Revision_branchId_idx" ON "Revision"("branchId");

-- CreateIndex
CREATE INDEX "Table_id_idx" ON "Table"("id");

-- CreateIndex
CREATE INDEX "Row_data_idx" ON "Row" USING GIN ("data");

-- CreateIndex
CREATE INDEX "Row_id_idx" ON "Row"("id");

-- CreateIndex
CREATE INDEX "Row_hash_idx" ON "Row"("hash");

-- CreateIndex
CREATE INDEX "Row_schemaHash_idx" ON "Row"("schemaHash");

-- CreateIndex
CREATE INDEX "Row_publishedAt_idx" ON "Row"("publishedAt");

-- CreateIndex
CREATE INDEX "FileBlob_projectId_idx" ON "FileBlob"("projectId");

-- CreateIndex
CREATE INDEX "FileBlob_hash_idx" ON "FileBlob"("hash");

-- CreateIndex
CREATE INDEX "FileBlob_deletedAt_idx" ON "FileBlob"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FileBlob_projectId_hash_key" ON "FileBlob"("projectId", "hash");

-- CreateIndex
CREATE INDEX "TableMigration_status_idx" ON "TableMigration"("status");

-- CreateIndex
CREATE INDEX "TableMigration_lockedBy_idx" ON "TableMigration"("lockedBy");

-- CreateIndex
CREATE INDEX "TableMigration_status_heartbeatAt_idx" ON "TableMigration"("status", "heartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "TableMigration_revisionId_tableId_key" ON "TableMigration"("revisionId", "tableId");

-- CreateIndex
CREATE INDEX "_RevisionToTable_B_index" ON "_RevisionToTable"("B");

-- CreateIndex
CREATE INDEX "_RowToTable_B_index" ON "_RowToTable"("B");

-- CreateIndex
CREATE INDEX "_FileBlobToRow_B_index" ON "_FileBlobToRow"("B");

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "RevoProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Revision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RevisionToTable" ADD CONSTRAINT "_RevisionToTable_A_fkey" FOREIGN KEY ("A") REFERENCES "Revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RevisionToTable" ADD CONSTRAINT "_RevisionToTable_B_fkey" FOREIGN KEY ("B") REFERENCES "Table"("versionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RowToTable" ADD CONSTRAINT "_RowToTable_A_fkey" FOREIGN KEY ("A") REFERENCES "Row"("versionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RowToTable" ADD CONSTRAINT "_RowToTable_B_fkey" FOREIGN KEY ("B") REFERENCES "Table"("versionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_FileBlobToRow" ADD CONSTRAINT "_FileBlobToRow_A_fkey" FOREIGN KEY ("A") REFERENCES "FileBlob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_FileBlobToRow" ADD CONSTRAINT "_FileBlobToRow_B_fkey" FOREIGN KEY ("B") REFERENCES "Row"("versionId") ON DELETE CASCADE ON UPDATE CASCADE;

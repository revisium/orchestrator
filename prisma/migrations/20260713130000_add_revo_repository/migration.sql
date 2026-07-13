-- CreateTable
CREATE TABLE "RevoRepository" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "remoteUrl" TEXT,
    "localPath" TEXT,
    "defaultBranch" TEXT,

    CONSTRAINT "RevoRepository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RevoRepository_projectId_name_key" ON "RevoRepository"("projectId", "name");

-- AddForeignKey
ALTER TABLE "RevoRepository" ADD CONSTRAINT "RevoRepository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "RevoProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TaskRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "repos" TEXT[],
    "scope" TEXT NOT NULL DEFAULT '',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "playbookId" TEXT NOT NULL DEFAULT '',
    "pipelineId" TEXT NOT NULL DEFAULT '',
    "params" JSONB NOT NULL DEFAULT '{}',
    "routeDecision" JSONB NOT NULL DEFAULT '{}',
    "executionProfile" JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "TaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunTask" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "runId" TEXT NOT NULL,
    "repoRef" TEXT NOT NULL DEFAULT '',
    "roleHint" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dependsOn" TEXT[],
    "scope" TEXT NOT NULL DEFAULT '',
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RunTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" SERIAL NOT NULL,
    "runId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL DEFAULT '',
    "stepId" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "actor" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunAttempt" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL DEFAULT '',
    "attemptNo" INTEGER NOT NULL DEFAULT 0,
    "iteration" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL DEFAULT '',
    "modelProfile" TEXT NOT NULL DEFAULT '',
    "verdict" TEXT NOT NULL DEFAULT '',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costAmount" DECIMAL(20,12) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "outputSummary" TEXT NOT NULL DEFAULT '',
    "artifactRef" TEXT NOT NULL DEFAULT '',
    "stdoutTail" TEXT NOT NULL DEFAULT '',
    "stderrTail" TEXT NOT NULL DEFAULT '',
    "lesson" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxItem" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "runId" TEXT,
    "taskId" TEXT NOT NULL DEFAULT '',
    "stepId" TEXT NOT NULL DEFAULT '',
    "projectId" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "options" TEXT[],
    "status" TEXT NOT NULL,
    "answer" JSONB,
    "resolvedBy" TEXT NOT NULL DEFAULT '',
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "InboxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunOutput" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "schemaRef" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "payloadRef" TEXT NOT NULL DEFAULT '',
    "attemptId" TEXT NOT NULL DEFAULT '',
    "producedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostLedgerEntry" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL DEFAULT '',
    "attemptId" TEXT NOT NULL DEFAULT '',
    "modelProfile" TEXT NOT NULL DEFAULT '',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costAmount" DECIMAL(20,12) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskRun_projectId_idx" ON "TaskRun"("projectId");

-- CreateIndex
CREATE INDEX "TaskRun_status_idx" ON "TaskRun"("status");

-- CreateIndex
CREATE INDEX "TaskRun_playbookId_pipelineId_idx" ON "TaskRun"("playbookId", "pipelineId");

-- CreateIndex
CREATE INDEX "TaskRun_createdAt_idx" ON "TaskRun"("createdAt");

-- CreateIndex
CREATE INDEX "RunTask_runId_idx" ON "RunTask"("runId");

-- CreateIndex
CREATE INDEX "RunTask_status_idx" ON "RunTask"("status");

-- CreateIndex
CREATE INDEX "RunTask_createdAt_idx" ON "RunTask"("createdAt");

-- CreateIndex
CREATE INDEX "RunEvent_runId_idx" ON "RunEvent"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "RunEvent_runId_sequence_key" ON "RunEvent"("runId", "sequence");

-- CreateIndex
CREATE INDEX "RunEvent_runId_createdAt_idx" ON "RunEvent"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "RunEvent_runId_sequence_idx" ON "RunEvent"("runId", "sequence");

-- CreateIndex
CREATE INDEX "RunEvent_type_idx" ON "RunEvent"("type");

-- CreateIndex
CREATE INDEX "RunAttempt_runId_idx" ON "RunAttempt"("runId");

-- CreateIndex
CREATE INDEX "RunAttempt_runId_stepId_idx" ON "RunAttempt"("runId", "stepId");

-- CreateIndex
CREATE INDEX "RunAttempt_status_idx" ON "RunAttempt"("status");

-- CreateIndex
CREATE INDEX "InboxItem_runId_idx" ON "InboxItem"("runId");

-- CreateIndex
CREATE INDEX "InboxItem_status_idx" ON "InboxItem"("status");

-- CreateIndex
CREATE INDEX "InboxItem_createdAt_idx" ON "InboxItem"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunOutput_runId_nodeId_ordinal_key" ON "RunOutput"("runId", "nodeId", "ordinal");

-- CreateIndex
CREATE INDEX "RunOutput_runId_idx" ON "RunOutput"("runId");

-- CreateIndex
CREATE INDEX "RunOutput_nodeId_idx" ON "RunOutput"("nodeId");

-- CreateIndex
CREATE INDEX "RunOutput_producedAt_idx" ON "RunOutput"("producedAt");

-- CreateIndex
CREATE INDEX "CostLedgerEntry_runId_idx" ON "CostLedgerEntry"("runId");

-- CreateIndex
CREATE INDEX "CostLedgerEntry_attemptId_idx" ON "CostLedgerEntry"("attemptId");

-- CreateIndex
CREATE INDEX "CostLedgerEntry_recordedAt_idx" ON "CostLedgerEntry"("recordedAt");

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "RevoProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunTask" ADD CONSTRAINT "RunTask_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunAttempt" ADD CONSTRAINT "RunAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunOutput" ADD CONSTRAINT "RunOutput_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostLedgerEntry" ADD CONSTRAINT "CostLedgerEntry_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

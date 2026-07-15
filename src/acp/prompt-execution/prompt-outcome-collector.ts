import { Injectable, Scope } from '@nestjs/common';
import type {
  AcpReportedCost,
  AcpReportedUsage,
  AcpStopReason,
} from '../protocol/values.js';
import type { AcpPromptExecutionDiagnostic } from './diagnostic.js';

export type AcpPromptExecutionEvent =
  | Readonly<{ kind: 'agent-text'; sessionId: string; text: string }>
  | Readonly<{
      kind: 'diagnostic';
      sessionId: string;
      diagnostic: AcpPromptExecutionDiagnostic;
    }>
  | Readonly<{
      kind: 'usage';
      sessionId: string;
      used: number;
      size: number;
      reportedCost?: AcpReportedCost;
    }>;

export type AcpPromptTerminalEvent = Readonly<{
  sessionId: string;
  stopReason: AcpStopReason;
}>;

export type AcpPromptProgress = Readonly<{
  sessionId: string;
  text: string;
  stopReason?: AcpStopReason;
  usage?: AcpReportedUsage;
  reportedCost?: AcpReportedCost;
  diagnostics: readonly AcpPromptExecutionDiagnostic[];
}>;

export type AcpPromptOutcome = Readonly<{
  sessionId: string;
  text: string;
  stopReason: AcpStopReason;
  usage?: AcpReportedUsage;
  reportedCost?: AcpReportedCost;
  diagnostics: readonly AcpPromptExecutionDiagnostic[];
}>;

export type AcpPromptCollectionRejectionReason =
  | 'foreign-session'
  | 'duplicate-terminal'
  | 'update-after-terminal';

export type AcpPromptCollectionResult =
  | Readonly<{ outcome: 'accepted' }>
  | Readonly<{
      outcome: 'rejected';
      reason: AcpPromptCollectionRejectionReason;
      diagnostics: readonly AcpPromptExecutionDiagnostic[];
    }>;

export type AcpPromptOutcomeResult =
  | Readonly<{ outcome: 'available'; value: AcpPromptOutcome }>
  | Readonly<{ outcome: 'unavailable'; reason: 'terminal-not-received' }>;

export type AcpPromptOutcomeCollectorDeps = Readonly<{ expectedSessionId: string }>;

function acceptOutcome(): AcpPromptCollectionResult {
  return { outcome: 'accepted' };
}

function copyDiagnostic(
  { severity, reason, message }: AcpPromptExecutionDiagnostic,
): AcpPromptExecutionDiagnostic {
  return { severity, reason, message };
}

function copyReportedCost({ amount, currency }: AcpReportedCost): AcpReportedCost {
  return { amount, currency };
}

const rejectionMessages: Record<AcpPromptCollectionRejectionReason, string> = {
  'foreign-session': 'Outcome event belongs to another session',
  'duplicate-terminal': 'Prompt outcome is already terminal',
  'update-after-terminal': 'Outcome stream event arrived after terminal',
};

function rejectOutcome(reason: AcpPromptCollectionRejectionReason): AcpPromptCollectionResult {
  return {
    outcome: 'rejected',
    reason,
    diagnostics: [{ severity: 'error', reason, message: rejectionMessages[reason] }],
  };
}

@Injectable({ scope: Scope.TRANSIENT })
export class AcpPromptOutcomeCollector {
  private expectedSessionId: string | undefined;
  private readonly textChunks: string[] = [];
  private readonly diagnostics: AcpPromptExecutionDiagnostic[] = [];
  private usage: AcpReportedUsage | undefined;
  private reportedCost: AcpReportedCost | undefined;
  private terminal: Readonly<{ stopReason: AcpStopReason }> | undefined;

  bind(deps: AcpPromptOutcomeCollectorDeps): void {
    if (this.expectedSessionId !== undefined) {
      throw new Error('ACP outcome collector is already bound');
    }
    const { expectedSessionId } = deps;
    this.expectedSessionId = expectedSessionId;
  }

  collect(event: AcpPromptExecutionEvent): AcpPromptCollectionResult {
    const expectedSessionId = this.requireSessionId();
    const { sessionId: eventSessionId } = event;
    if (eventSessionId !== expectedSessionId) return rejectOutcome('foreign-session');
    if (this.terminal) return rejectOutcome('update-after-terminal');

    switch (event.kind) {
      case 'agent-text': {
        const { text } = event;
        this.textChunks.push(text);
        return acceptOutcome();
      }
      case 'diagnostic': {
        const { diagnostic } = event;
        this.diagnostics.push(copyDiagnostic(diagnostic));
        return acceptOutcome();
      }
      case 'usage': {
        const { used, size, reportedCost } = event;
        this.usage = { used, size };
        if (reportedCost !== undefined) {
          this.reportedCost = copyReportedCost(reportedCost);
        }
        return acceptOutcome();
      }
    }
  }

  complete(event: AcpPromptTerminalEvent): AcpPromptCollectionResult {
    const expectedSessionId = this.requireSessionId();
    const { sessionId: eventSessionId, stopReason } = event;
    if (eventSessionId !== expectedSessionId) return rejectOutcome('foreign-session');
    if (this.terminal) return rejectOutcome('duplicate-terminal');
    this.terminal = { stopReason };
    return acceptOutcome();
  }

  snapshot(): AcpPromptProgress {
    const expectedSessionId = this.requireSessionId();
    return {
      sessionId: expectedSessionId,
      text: this.textChunks.join(''),
      ...(this.terminal ? { stopReason: this.terminal.stopReason } : {}),
      ...(this.usage
        ? { usage: { used: this.usage.used, size: this.usage.size } }
        : {}),
      ...(this.reportedCost ? { reportedCost: copyReportedCost(this.reportedCost) } : {}),
      diagnostics: this.diagnostics.map(copyDiagnostic),
    };
  }

  outcome(): AcpPromptOutcomeResult {
    const progress = this.snapshot();
    if (!this.terminal) {
      return { outcome: 'unavailable', reason: 'terminal-not-received' };
    }
    return {
      outcome: 'available',
      value: {
        sessionId: progress.sessionId,
        text: progress.text,
        stopReason: this.terminal.stopReason,
        ...(progress.usage === undefined ? {} : { usage: progress.usage }),
        ...(progress.reportedCost === undefined ? {} : { reportedCost: progress.reportedCost }),
        diagnostics: progress.diagnostics,
      },
    };
  }

  private requireSessionId(): string {
    if (this.expectedSessionId === undefined) {
      throw new Error('ACP outcome collector is not bound');
    }
    return this.expectedSessionId;
  }
}

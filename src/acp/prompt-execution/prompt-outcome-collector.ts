import { Injectable, Scope } from '@nestjs/common';
import type { AcpInteractionDiagnostic } from './diagnostic.js';

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export type AcpReportedUsage = Readonly<{ used: number; size: number }>;
export type AcpReportedCost = Readonly<{ amount: number; currency: string }>;

export type OutcomeStreamEvent =
  | Readonly<{ kind: 'agent-text'; sessionId: string; text: string }>
  | Readonly<{
      kind: 'diagnostic';
      sessionId: string;
      diagnostic: AcpInteractionDiagnostic;
    }>
  | Readonly<{
      kind: 'usage';
      sessionId: string;
      used: number;
      size: number;
      reportedCost?: AcpReportedCost;
    }>;

export type PromptTerminalEvent = Readonly<{
  sessionId: string;
  stopReason: AcpStopReason;
}>;

export type NeutralOutcome = Readonly<{
  sessionId: string;
  text: string;
  stopReason?: AcpStopReason;
  usage?: AcpReportedUsage;
  reportedCost?: AcpReportedCost;
  diagnostics: readonly AcpInteractionDiagnostic[];
}>;

export type OutcomeCollectionRejectionReason =
  | 'foreign-session'
  | 'duplicate-terminal'
  | 'update-after-terminal';

export type OutcomeCollectionResult =
  | Readonly<{ outcome: 'accepted' }>
  | Readonly<{
      outcome: 'rejected';
      reason: OutcomeCollectionRejectionReason;
      diagnostics: readonly AcpInteractionDiagnostic[];
    }>;

export type AcpPromptOutcomeCollectorDeps = Readonly<{ expectedSessionId: string }>;

function acceptOutcome(): OutcomeCollectionResult {
  return { outcome: 'accepted' };
}

function copyDiagnostic(
  { severity, reason, message }: AcpInteractionDiagnostic,
): AcpInteractionDiagnostic {
  return { severity, reason, message };
}

function copyReportedCost({ amount, currency }: AcpReportedCost): AcpReportedCost {
  return { amount, currency };
}

const rejectionMessages: Record<OutcomeCollectionRejectionReason, string> = {
  'foreign-session': 'Outcome event belongs to another session',
  'duplicate-terminal': 'Prompt outcome is already terminal',
  'update-after-terminal': 'Outcome stream event arrived after terminal',
};

function rejectOutcome(reason: OutcomeCollectionRejectionReason): OutcomeCollectionResult {
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
  private readonly diagnostics: AcpInteractionDiagnostic[] = [];
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

  collect(event: OutcomeStreamEvent): OutcomeCollectionResult {
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

  complete(event: PromptTerminalEvent): OutcomeCollectionResult {
    const expectedSessionId = this.requireSessionId();
    const { sessionId: eventSessionId, stopReason } = event;
    if (eventSessionId !== expectedSessionId) return rejectOutcome('foreign-session');
    if (this.terminal) return rejectOutcome('duplicate-terminal');
    this.terminal = { stopReason };
    return acceptOutcome();
  }

  snapshot(): NeutralOutcome {
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

  private requireSessionId(): string {
    if (this.expectedSessionId === undefined) {
      throw new Error('ACP outcome collector is not bound');
    }
    return this.expectedSessionId;
  }
}

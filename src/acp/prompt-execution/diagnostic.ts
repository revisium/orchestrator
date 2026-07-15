export type AcpPromptExecutionDiagnostic = Readonly<{
  severity: 'info' | 'warning' | 'error';
  reason: string;
  message: string;
}>;

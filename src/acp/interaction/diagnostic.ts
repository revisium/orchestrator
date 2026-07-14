export type AcpInteractionDiagnostic = Readonly<{
  severity: 'info' | 'warning' | 'error';
  reason: string;
  message: string;
}>;























export const DBOS_WORKFLOW_VERSION = '1';


export function dbosExecutorId(profile: string): string {
  return `revo-${profile}`;
}




export function dbosEnvPin(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): { DBOS__VMID: string; DBOS__APPVERSION: string } {
  return {
    DBOS__VMID: env['DBOS__VMID'] ?? dbosExecutorId(profile),
    DBOS__APPVERSION: env['DBOS__APPVERSION'] ?? DBOS_WORKFLOW_VERSION,
  };
}

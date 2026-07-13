export const runtimeTables = [
  'task_runs',
  'tasks',
  'steps',
  'attempts',
  'events',
  'inbox',
  'cost_ledger',
  'run_outputs',
] as const;

export type RuntimeTable = (typeof runtimeTables)[number];

export function isRuntimeTable(table: string): table is RuntimeTable {
  return (runtimeTables as readonly string[]).includes(table);
}

export const controlPlaneMeaningTables = [
  'playbooks',
  'roles',
  'pipelines',
  'routing_policy',
  'run_profiles',
] as const;

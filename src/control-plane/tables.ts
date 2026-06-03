export const runtimeTables = [
  'task_runs',
  'tasks',
  'steps',
  'attempts',
  'events',
  'inbox',
  'cost_ledger',
] as const;

export type RuntimeTable = (typeof runtimeTables)[number];

export function isRuntimeTable(table: string): table is RuntimeTable {
  return (runtimeTables as readonly string[]).includes(table);
}

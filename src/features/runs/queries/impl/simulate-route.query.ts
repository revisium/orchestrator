export type SimulateRouteQueryData = {
  title: string;
  repo?: string;
  pipeline?: string;
  playbookId?: string;
  params?: unknown;
};

export class SimulateRouteQuery {
  constructor(readonly data: SimulateRouteQueryData) {}
}

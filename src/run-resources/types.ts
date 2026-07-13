export type ResourceName = string;

export type PipelineResourceDecl = {
  kind: 'repository';
  cardinality: 'one';
  required: boolean;
};

export type RetentionPolicy = {
  onSuccess: 'release' | 'retain';
  onFailure: 'release' | 'retain';
  onCancel: 'release' | 'retain';
  onBlocked: 'release' | 'retain';
};

export type PipelineWorkspacePolicy =
  | { isolation: 'scratch'; retention: RetentionPolicy }
  | {
      isolation: 'resource';
      resource: ResourceName;
      mutability: 'read-only' | 'mutable';
      identity: { template: string };
      retention: RetentionPolicy;
    };

export type RepositoryLaunchBinding = {
  repositoryId: string;
  revision?: string;
  credentialAliases?: { git?: string; github?: string };
};

export type RunResourceBindings = Record<ResourceName, RepositoryLaunchBinding>;

export type ParsedRunResourceInputV1 = {
  resources: Record<ResourceName, PipelineResourceDecl>;
  workspace: PipelineWorkspacePolicy;
  bindings: RunResourceBindings;
};

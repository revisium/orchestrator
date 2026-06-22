import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { addWsServer } from '../api/graphql-api/graphql-ws/ws.js';
import { isPortFree, resolveDefaultGraphqlPort } from '../config.js';
import { GraphqlHostModule } from './graphql-host.module.js';

export const DEFAULT_GRAPHQL_HOST = '127.0.0.1';

export type GraphqlHostOptions = {
  host?: string;
  port?: number;
};

export type StartedGraphqlHost = {
  app: INestApplication;
  host: string;
  port: number;
  url: string;
};

export type GraphqlHostDeps = {
  isPortFree: typeof isPortFree;
};

const defaultDeps: GraphqlHostDeps = {
  isPortFree,
};

function parsePort(raw: string | undefined): number {
  if (!raw) return resolveDefaultGraphqlPort();
  const candidate = raw.trim();
  if (!/^\d+$/.test(candidate)) {
    throw new TypeError(`Invalid GraphQL port: ${raw}`);
  }
  const port = Number(candidate);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError(`Invalid GraphQL port: ${raw}`);
  }
  return port;
}

export function resolveGraphqlHostOptions(options: GraphqlHostOptions = {}): Required<GraphqlHostOptions> {
  const host = options.host ?? process.env.REVO_GRAPHQL_HOST ?? DEFAULT_GRAPHQL_HOST;
  if (host !== DEFAULT_GRAPHQL_HOST) {
    throw new TypeError(`GraphQL host must bind ${DEFAULT_GRAPHQL_HOST} in v1; received ${host}`);
  }

  return {
    host,
    port: options.port ?? parsePort(process.env.REVO_GRAPHQL_PORT),
  };
}

export async function startGraphqlHost(
  options: GraphqlHostOptions = {},
  deps: GraphqlHostDeps = defaultDeps,
): Promise<StartedGraphqlHost> {
  const resolved = resolveGraphqlHostOptions(options);
  if (resolved.host !== DEFAULT_GRAPHQL_HOST) {
    throw new Error(`GraphQL host must bind ${DEFAULT_GRAPHQL_HOST} in v1; received ${resolved.host}`);
  }
  if (!(await deps.isPortFree(resolved.port))) {
    throw new Error(
      `GraphQL port ${resolved.port} is already in use; set REVO_GRAPHQL_PORT or --port to a free isolated port.`,
    );
  }

  const app = await NestFactory.create(GraphqlHostModule, { logger: ['error', 'warn'] });
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  await app.listen(resolved.port, resolved.host);
  const ws = addWsServer(app);
  const close = app.close.bind(app);
  app.close = async () => {
    await ws.dispose();
    await close();
  };

  return {
    app,
    ...resolved,
    url: `http://${resolved.host}:${resolved.port}/graphql`,
  };
}

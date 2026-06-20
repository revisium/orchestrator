import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { resolveDefaultGraphqlPort } from '../config.js';
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
  return {
    host: options.host ?? process.env.REVO_GRAPHQL_HOST ?? DEFAULT_GRAPHQL_HOST,
    port: options.port ?? parsePort(process.env.REVO_GRAPHQL_PORT),
  };
}

export async function startGraphqlHost(options: GraphqlHostOptions = {}): Promise<StartedGraphqlHost> {
  const resolved = resolveGraphqlHostOptions(options);
  if (resolved.host !== DEFAULT_GRAPHQL_HOST) {
    throw new Error(`GraphQL host must bind ${DEFAULT_GRAPHQL_HOST} in v1; received ${resolved.host}`);
  }

  const app = await NestFactory.create(GraphqlHostModule, { logger: ['error', 'warn'] });
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  await app.listen(resolved.port, resolved.host);

  return {
    app,
    ...resolved,
    url: `http://${resolved.host}:${resolved.port}/graphql`,
  };
}

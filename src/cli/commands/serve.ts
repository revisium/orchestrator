import type { Command } from 'commander';

type ServeOptions = {
  host?: string;
  port?: string;
};

export function parsePortOption(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError(`Invalid --port value: ${raw}`);
  }
  return port;
}

async function runServe(options: ServeOptions): Promise<void> {
  const { startGraphqlHost } = await import('../../http/graphql-host.js');
  const started = await startGraphqlHost({
    host: options.host,
    port: parsePortOption(options.port),
  });

  console.log(`GraphQL listening on ${started.url}`);
}

export function registerServe(program: Command): void {
  program
    .command('serve')
    .description('Start the local HTTP GraphQL front door')
    .option('--host <host>', 'HTTP bind host (v1 only allows 127.0.0.1)')
    .option('--port <port>', 'HTTP port (default: 19223 or REVO_GRAPHQL_PORT)')
    .action((options: ServeOptions) => runServe(options));
}

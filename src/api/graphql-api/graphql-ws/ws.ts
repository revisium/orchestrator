import type { INestApplication } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { useServer } from 'graphql-ws/lib/use/ws';
import { WebSocketServer } from 'ws';

export function addWsServer(app: INestApplication) {
  const schema = app.get(GraphQLSchemaHost).schema;
  const wsServer = new WebSocketServer({
    server: app.getHttpServer(),
    path: '/graphql',
  });
  const cleanup = useServer({ schema }, wsServer);
  app.enableShutdownHooks();
  return {
    wsServer,
    async dispose() {
      await cleanup.dispose();
      await new Promise<void>((resolve, reject) => {
        wsServer.close((error?: Error) => error ? reject(error) : resolve());
      });
    },
  };
}

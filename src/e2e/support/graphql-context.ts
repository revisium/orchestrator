import assert from 'node:assert/strict';
import { createClient, type Client } from 'graphql-ws';
import { isAlive } from '../../config.js';
import { readHostRuntime } from '../../host/host-runtime.js';
import { stubFixtureAgentProfile } from './run-profiles.js';

export type GraphqlError = Readonly<{
  message: string;
  path?: readonly (string | number)[];
  extensions?: Readonly<Record<string, unknown>>;
}>;

export type GraphqlResult<T> = Readonly<{
  status: number;
  data?: T;
  errors: readonly GraphqlError[];
}>;

export type GraphqlSubscriptionResult<T> = Readonly<{
  data?: T;
  errors: readonly GraphqlError[];
}>;

function errorsFrom(value: unknown): readonly GraphqlError[] {
  if (!Array.isArray(value)) return [];
  return value.map((error) => {
    const candidate = error as {
      message?: unknown;
      path?: unknown;
      extensions?: unknown;
    };
    return {
      message: typeof candidate.message === 'string' ? candidate.message : String(candidate.message),
      ...(Array.isArray(candidate.path) ? { path: candidate.path as (string | number)[] } : {}),
      ...(candidate.extensions && typeof candidate.extensions === 'object'
        ? { extensions: candidate.extensions as Record<string, unknown> }
        : {}),
    };
  });
}

export function graphqlSubscriptionResult<T>(value: Readonly<{
  data?: unknown;
  errors?: unknown;
}>): GraphqlSubscriptionResult<T> {
  return {
    ...(value.data !== undefined ? { data: value.data as T } : {}),
    errors: errorsFrom(value.errors),
  };
}

export class GraphqlSubscription<T> {
  readonly #client: Client;
  readonly #buffer: GraphqlSubscriptionResult<T>[] = [];
  #failure: unknown;
  #notify: (() => void) | undefined;
  readonly #disposeSubscription: () => void;
  readonly #ready: Promise<void>;

  constructor(
    client: Client,
    ready: Promise<void>,
    query: string,
    variables?: Readonly<Record<string, unknown>>,
  ) {
    this.#client = client;
    this.#ready = ready;
    this.#disposeSubscription = client.subscribe(
      { query, ...(variables ? { variables } : {}) },
      {
        next: (value) => {
          this.#buffer.push(graphqlSubscriptionResult<T>(value));
          this.#notify?.();
        },
        error: (error) => {
          this.#failure = error;
          this.#notify?.();
        },
        complete() {},
      },
    );
  }

  async ready(timeoutMs = 10_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('GraphQL subscription did not connect before timeout')), timeoutMs);
        }),
      ]);
    } catch (error) {
      this.#disposeSubscription();
      await this.#client.dispose();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async waitFor(
    match: (result: GraphqlSubscriptionResult<T>) => boolean,
    timeoutMs = 10_000,
  ): Promise<GraphqlSubscriptionResult<T>> {
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        if (this.#failure) throw this.#failure;
        const result = this.#buffer.find(match);
        if (result) return result;
        if (Date.now() >= deadline) throw new Error('GraphQL subscription result not observed before timeout');
        await new Promise<void>((resolve) => {
          this.#notify = resolve;
          setTimeout(resolve, 100);
        });
      }
    } finally {
      this.#disposeSubscription();
      await this.#client.dispose();
    }
  }
}

export class GraphqlContext {
  readonly #httpUrl: string;
  readonly #websocketUrl: string;

  constructor(httpUrl: string) {
    this.#httpUrl = httpUrl;
    this.#websocketUrl = httpUrl.replace('http://', 'ws://');
  }

  async execute<T>(query: string, variables?: Readonly<Record<string, unknown>>): Promise<GraphqlResult<T>> {
    const response = await fetch(this.#httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
    });
    const body = await response.json() as { data?: T; errors?: unknown };
    return {
      status: response.status,
      ...(body.data !== undefined ? { data: body.data } : {}),
      errors: errorsFrom(body.errors),
    };
  }

  subscribe<T>(query: string, variables?: Readonly<Record<string, unknown>>): GraphqlSubscription<T> {
    let connected: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const client = createClient({
      url: this.#websocketUrl,
      on: { connected: () => connected?.() },
    });
    return new GraphqlSubscription(client, ready, query, variables);
  }
}

export function createGraphqlContext(): GraphqlContext {
  const runtime = readHostRuntime();
  assert.ok(runtime && isAlive(runtime.pid), 'e2e host daemon must be running before GraphQL tests');
  return new GraphqlContext(`http://127.0.0.1:${runtime.graphqlPort}/graphql`);
}

export function graphqlStubAgentProfile(): ReturnType<typeof stubFixtureAgentProfile> {
  return stubFixtureAgentProfile();
}

import type { PaginatedShape } from '../../api/graphql-api/share/model/paginated.model.js';

export type ConnectionInput = {
  first?: number;
  after?: string;
};

const DEFAULT_FIRST = 50;
const MAX_FIRST = 500;

function encodeCursor(index: number): string {
  return Buffer.from(String(index), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return -1;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 ? index : -1;
}

function normalizeFirst(first: number | undefined): number {
  return Math.min(Math.max(first ?? DEFAULT_FIRST, 0), MAX_FIRST);
}

export function connectionFetchLimit(input: ConnectionInput = {}): number {
  const start = decodeCursor(input.after) + 1;
  return start + normalizeFirst(input.first) + 1;
}

export function toConnection<T>(items: T[], input: ConnectionInput = {}): PaginatedShape<T> {
  const first = normalizeFirst(input.first);
  const start = decodeCursor(input.after) + 1;
  const page = items.slice(start, start + first);
  const edges = page.map((node, offset) => ({
    cursor: encodeCursor(start + offset),
    node,
  }));
  return {
    edges,
    totalCount: items.length,
    pageInfo: {
      startCursor: edges[0]?.cursor,
      endCursor: edges.at(-1)?.cursor,
      hasPreviousPage: start > 0,
      hasNextPage: start + first < items.length,
    },
  };
}

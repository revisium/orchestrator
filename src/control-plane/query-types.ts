export type RowWhereInput = {
  id?: { equals?: string; in?: string[] };
  data?: { path?: string; equals?: unknown };
  AND?: RowWhereInput[];
  OR?: RowWhereInput[];
  NOT?: RowWhereInput | RowWhereInput[];
  [field: string]: unknown;
};

export const ROW_ORDER_BY_FIELDS = ['id', 'createdAt', 'updatedAt', 'publishedAt'] as const;

export type RowOrderByField = (typeof ROW_ORDER_BY_FIELDS)[number];

export type RowOrderBy = {
  field: RowOrderByField;
  direction: 'asc' | 'desc';
};

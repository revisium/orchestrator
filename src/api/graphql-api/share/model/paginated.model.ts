import { Type } from '@nestjs/common';
import { Field, Int, ObjectType } from '@nestjs/graphql';

export type PageInfoShape = {
  endCursor?: string;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor?: string;
};

export type PaginatedShape<T> = {
  edges: Array<{ cursor: string; node: T }>;
  totalCount: number;
  pageInfo: PageInfoShape;
};

@ObjectType()
export class PageInfo implements PageInfoShape {
  @Field(() => String, { nullable: true })
  endCursor?: string;

  @Field(() => Boolean)
  hasNextPage!: boolean;

  @Field(() => Boolean)
  hasPreviousPage!: boolean;

  @Field(() => String, { nullable: true })
  startCursor?: string;
}

export function Paginated<T>(classRef: Type<T>): Type<PaginatedShape<T>> {
  @ObjectType(`${classRef.name}Edge`)
  abstract class EdgeType {
    @Field(() => String)
    cursor!: string;

    @Field(() => classRef)
    node!: T;
  }

  @ObjectType({ isAbstract: true })
  abstract class PaginatedType implements PaginatedShape<T> {
    @Field(() => [EdgeType])
    edges!: Array<{ cursor: string; node: T }>;

    @Field(() => Int)
    totalCount!: number;

    @Field(() => PageInfo)
    pageInfo!: PageInfo;
  }

  return PaginatedType as Type<PaginatedShape<T>>;
}

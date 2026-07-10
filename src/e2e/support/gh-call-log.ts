export function caseGhCallBoundary(calls: readonly (readonly string[])[]): number {
  return calls.length;
}

export function reviewReplyBodiesSince(
  calls: readonly (readonly string[])[],
  boundary: number,
): string[] {
  return calls
    .slice(boundary)
    .filter((args) => args[0] === 'api' && args[1] === 'graphql' &&
      args.some((arg) => arg.includes('addPullRequestReviewThreadReply')))
    .map((args) => args.find((arg) => arg.startsWith('body='))?.slice('body='.length) ?? '');
}

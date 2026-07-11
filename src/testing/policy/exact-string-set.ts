function compareExactStrings(left: string, right: string): number {
  const localeOrder = left.localeCompare(right);
  if (localeOrder !== 0 || left === right) return localeOrder;
  return left < right ? -1 : 1;
}

export function sameExactStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = left.toSorted(compareExactStrings);
  const sortedRight = right.toSorted(compareExactStrings);
  return left.length === right.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
}

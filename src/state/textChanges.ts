export interface ChangedLineRange {
  startLine: number;
  endLine: number;
}

export function findChangedLineRange(
  previous: string,
  current: string
): ChangedLineRange | undefined {
  if (previous === current) {
    return undefined;
  }
  const before = previous.split(/\r?\n/);
  const after = current.split(/\r?\n/);
  let prefix = 0;
  while (
    prefix < before.length
    && prefix < after.length
    && before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    startLine: prefix,
    endLine: Math.max(
      prefix,
      before.length - suffix - 1,
      after.length - suffix - 1
    )
  };
}

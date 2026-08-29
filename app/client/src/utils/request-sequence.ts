export function createRequestSequence() {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(sequence: number): boolean {
      return sequence === current;
    }
  };
}

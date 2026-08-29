import { describe, expect, it } from 'vitest';

import { createRequestSequence } from '../src/utils/request-sequence';

describe('request sequence', () => {
  it('只把最新代数视为当前请求', () => {
    const sequence = createRequestSequence();
    const first = sequence.next();
    const second = sequence.next();
    expect(sequence.isCurrent(first)).toBe(false);
    expect(sequence.isCurrent(second)).toBe(true);
    sequence.next();
    expect(sequence.isCurrent(second)).toBe(false);
  });
});

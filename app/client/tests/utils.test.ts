import { describe, expect, it } from 'vitest';
import { displayLabel } from '../src/utils/display';
import { finiteInRange, isIsoDate, positiveInteger } from '../src/utils/validation';

describe('client display and validation utilities', () => {
  it('localizes business enums without leaking unknown enum values', () => {
    expect(displayLabel('BREAKFAST')).toBe('早餐');
    expect(displayLabel('GRAM')).toBe('克');
    expect(displayLabel('SOMETHING_NEW')).toBe('未知');
  });
  it('validates real dates and numeric ranges', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2025-02-29')).toBe(false);
    expect(finiteInRange('5', 0, 5)).toBe(true);
    expect(finiteInRange('Infinity', 0)).toBe(false);
    expect(positiveInteger('1')).toBe(true);
    expect(positiveInteger('1.5')).toBe(false);
  });
});

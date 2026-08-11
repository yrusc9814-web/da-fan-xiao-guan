import type { QuantityUnit } from '../../../shared/types/domain.js';

const unitGroups: Record<string, Record<string, number>> = {
  MASS: {
    GRAM: 1,
    KILOGRAM: 1000
  },
  VOLUME: {
    MILLILITER: 1,
    LITER: 1000
  }
};

function groupForUnit(unit: QuantityUnit): Record<string, number> | null {
  return Object.values(unitGroups).find((group) => unit in group) ?? null;
}

export function convertQuantity(quantity: number, from: QuantityUnit, to: QuantityUnit): number | null {
  if (quantity < 0) {
    throw new Error('数量不能为负数');
  }

  if (from === to) {
    return quantity;
  }

  const fromGroup = groupForUnit(from);
  const toGroup = groupForUnit(to);

  if (!fromGroup || !toGroup || fromGroup !== toGroup) {
    return null;
  }

  return quantity * (fromGroup[from] / toGroup[to]);
}

export function canConvertUnit(from: QuantityUnit, to: QuantityUnit): boolean {
  return convertQuantity(1, from, to) !== null;
}

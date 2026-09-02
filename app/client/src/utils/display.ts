const labels: Record<string, string> = {
  BREAKFAST: '早餐',
  LUNCH: '午餐',
  DINNER: '晚餐',
  AFTERNOON_TEA: '下午茶',
  SOUP: '汤品',
  MAIN: '主菜',
  SIDE: '配菜',
  STAPLE: '主食',
  DRINK: '饮品',
  HOMEMADE: '在家做',
  DINE_IN: '堂食',
  TAKEOUT: '外卖',
  CUSTOM: '其他',
  DRAFT: '待完成',
  CONFIRMED: '已记录',
  PLANNED: '已安排',
  UNPLANNED: '待安排',
  CANCELLED: '已取消',
  COMPLETED: '已完成',
  AVAILABLE: '可用',
  BROKEN: '损坏',
  MAINTENANCE: '维护中',
  NORMAL: '充足',
  LOW: '库存偏低',
  EMPTY: '已用完',
  EXPIRED: '已过期',
  EXPIRING: '临期',
  GRAM: '克',
  KILOGRAM: '千克',
  MILLILITER: '毫升',
  LITER: '升',
  PIECE: '个',
  BOX: '盒',
  BAG: '袋',
  BOTTLE: '瓶',
  CAN: '罐',
  PACK: '包',
  PORTION: '份',
  OTHER: '其他单位',
  MANUAL_ADD: '手动补充',
  MANUAL_DEDUCT: '手动扣减',
  COOK_DEDUCT: '做饭扣减',
  ADJUST: '盘点调整',
  RECIPE: '菜谱',
  STORE: '店铺'
};

export function displayLabel(value: string | null | undefined): string {
  if (!value) return '未设置';
  return labels[value] ?? '未知';
}

export const displayOptions = (values: string[]) => values.map((value) => ({ value, label: displayLabel(value) }));

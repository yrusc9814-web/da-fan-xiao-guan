/**
 * 冰箱食材统一 7 大分类：蔬菜 / 肉禽 / 水产 / 蛋奶豆制 / 主食粮油 / 调味 / 其他。
 *
 * 历史数据（旧前端下拉：蛋奶、烘焙、水果、肉类…）与空分类不会被批量改写数据库，
 * 读取时统一派生为 7 类之一；写入时落库为标准分类，保证「全部 (N)」恒等于各分类计数之和。
 */
export const INGREDIENT_CATEGORIES = ['蔬菜', '肉禽', '水产', '蛋奶豆制', '主食粮油', '调味', '其他'] as const;

export type IngredientCategory = (typeof INGREDIENT_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(INGREDIENT_CATEGORIES);

/** 旧分类名 / 同义名 → 7 大分类。 */
const LEGACY_CATEGORY_MAP: Record<string, IngredientCategory> = {
  蔬菜类: '蔬菜',
  叶菜: '蔬菜',
  生鲜蔬菜: '蔬菜',
  肉类: '肉禽',
  禽类: '肉禽',
  肉禽类: '肉禽',
  猪牛羊肉: '肉禽',
  海鲜: '水产',
  水产类: '水产',
  鱼类: '水产',
  蛋: '蛋奶豆制',
  蛋类: '蛋奶豆制',
  蛋奶: '蛋奶豆制',
  奶制品: '蛋奶豆制',
  乳制品: '蛋奶豆制',
  豆制品: '蛋奶豆制',
  豆类: '蛋奶豆制',
  烘焙: '主食粮油',
  主食: '主食粮油',
  粮食: '主食粮油',
  粮油: '主食粮油',
  米面: '主食粮油',
  调料: '调味',
  调味品: '调味',
  调味料: '调味',
  水果: '其他',
  日常: '其他',
  其他类: '其他'
};

/**
 * 名称关键词 → 分类。顺序即优先级：先命中先归类，
 * 因此「胡椒/花椒」这类调味词必须排在蔬菜的「椒」之前判断。
 */
const NAME_RULES: ReadonlyArray<readonly [IngredientCategory, readonly string[]]> = [
  ['其他', ['牛油果', '苹果', '香蕉', '葡萄', '橙', '柚', '水果']],
  ['调味', ['盐', '糖', '酱', '醋', '料酒', '蚝油', '胡椒', '花椒', '味精', '鸡精', '香料', '调味', '葱', '姜', '蒜']],
  ['蔬菜', ['土豆', '玉米', '毛豆', '豌豆', '豆角', '四季豆', '黄豆芽', '绿豆芽']],
  ['蛋奶豆制', ['蛋', '奶', '乳', '豆腐', '豆浆', '豆干', '腐竹', '奶酪', '黄油', '酸奶', '豆']],
  ['水产', ['虾', '蟹', '鱼', '贝', '蛤', '鱿', '鲍', '海参', '海带', '紫菜', '花甲']],
  ['肉禽', ['排骨', '猪', '牛', '羊', '鸡', '鸭', '鹅', '火腿', '香肠', '培根', '肉']],
  ['主食粮油', ['大米', '糯米', '米', '面', '粉', '馒头', '燕麦', '杂粮', '挂面', '面包', '食用油', '淀粉']],
  ['蔬菜', ['菜', '瓜', '茄', '菇', '菌', '笋', '萝卜', '椒', '番茄', '西红柿']]
];

export function isIngredientCategory(value: string): value is IngredientCategory {
  return CATEGORY_SET.has(value);
}

/** 仅按名称推断；无法判断返回 null（由调用方决定兜底）。 */
export function inferCategoryByName(name: string | null | undefined): IngredientCategory | null {
  const text = (name ?? '').trim();
  if (!text) return null;
  for (const [category, keywords] of NAME_RULES) {
    if (keywords.some((keyword) => text.includes(keyword))) return category;
  }
  return null;
}

/**
 * 分类归一化：标准分类原样返回；旧名按映射表转换；其余按食材名称推断；仍未知兜底「其他」。
 * 名称参数只在分类本身无法识别时使用。
 */
export function normalizeIngredientCategory(
  value: string | null | undefined,
  name?: string | null
): IngredientCategory {
  const text = (value ?? '').trim();
  if (isIngredientCategory(text)) return text;
  const mapped = LEGACY_CATEGORY_MAP[text];
  if (mapped) return mapped;
  return inferCategoryByName(name) ?? inferCategoryByName(text) ?? '其他';
}

/** 数据库存量分类是否命中请求的（标准或旧名）分类。 */
export function matchesIngredientCategory(
  storedCategory: string | null | undefined,
  name: string | null | undefined,
  requestedCategory: string
): boolean {
  return normalizeIngredientCategory(storedCategory, name) === normalizeIngredientCategory(requestedCategory, null);
}

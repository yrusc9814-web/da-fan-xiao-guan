(() => {
  'use strict';
  const API_BASE = '/api/v1';
  const PIN_KEY = 'dafan-pin-token';
  const BLOCKED_MESSAGE = '该功能尚未接通真实后端';
  class ApiError extends Error {
    constructor(status, code, message, details, retryAfter) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
      this.retryAfter = retryAfter;
    }
  }
  const PIN_RETRY_EXCLUDED = [
    '/settings/pin/verify',
    '/settings/pin/session',
    '/settings/high-risk/authorize',
    '/backups/restore'
  ];
  let pinUnlockPromise = null;
  let pinUnlockResolve = null;
  let pinUnlockReject = null;
  let pinUnlockCooldownTimer = null;
  function normalizedPath(path) {
    return String(path).split('?')[0];
  }
  function pinRetryAllowed(path, options, status, code) {
    return (
      !options._pinRetried &&
      status === 401 &&
      code === 'UNAUTHORIZED' &&
      !PIN_RETRY_EXCLUDED.includes(normalizedPath(path))
    );
  }
  function pinUnlockError(message = '已取消 PIN 解锁') {
    return new ApiError(401, 'PIN_UNLOCK_CANCELLED', message);
  }
  function pinDialog() {
    return {
      root: document.getElementById('modalPinUnlock'),
      form: document.getElementById('google2PinUnlockForm'),
      input: document.getElementById('google2PinInput'),
      error: document.getElementById('google2PinError'),
      submit: document.getElementById('google2PinSubmit'),
      cancel: document.getElementById('google2PinCancel')
    };
  }
  function setPinDialogError(message = '') {
    const node = pinDialog().error;
    if (node) node.textContent = message;
  }
  function closePinUnlockDialog() {
    const { root, input } = pinDialog();
    root?.classList.add('hidden');
    if (input) input.value = '';
    setPinDialogError('');
    if (pinUnlockCooldownTimer) {
      clearInterval(pinUnlockCooldownTimer);
      pinUnlockCooldownTimer = null;
    }
  }
  function finishPinUnlock(token) {
    if (!token || !pinUnlockResolve) return;
    localStorage.setItem(PIN_KEY, token);
    const resolve = pinUnlockResolve;
    pinUnlockPromise = pinUnlockResolve = pinUnlockReject = null;
    closePinUnlockDialog();
    resolve(token);
  }
  function cancelPinUnlock() {
    if (!pinUnlockReject) return;
    const reject = pinUnlockReject;
    pinUnlockPromise = pinUnlockResolve = pinUnlockReject = null;
    closePinUnlockDialog();
    reject(pinUnlockError());
  }
  async function verifyPinFromDialog() {
    const { input, submit } = pinDialog();
    const pin = input?.value || '';
    if (!/^\d{4,8}$/.test(pin)) {
      setPinDialogError('请输入 4～8 位数字 PIN');
      input?.focus();
      return;
    }
    if (submit) submit.disabled = true;
    setPinDialogError('正在验证…');
    try {
      const result = await request('/settings/pin/verify', {
        method: 'POST',
        body: JSON.stringify({ pin }),
        _pinRetried: true
      });
      if (result?.valid !== true || typeof result.token !== 'string' || !result.token) {
        setPinDialogError(result?.required === true ? 'PIN 不正确，请重试' : '当前未启用 PIN，请刷新后重试');
        if (input) input.value = '';
        return;
      }
      finishPinUnlock(result.token);
    } catch (error) {
      if (error?.status === 429 && error?.code === 'PIN_ATTEMPTS_EXCEEDED') {
        let remaining = Math.max(1, Number(error.retryAfter) || 30);
        setPinDialogError(`尝试次数过多，请 ${remaining} 秒后再试`);
        if (pinUnlockCooldownTimer) clearInterval(pinUnlockCooldownTimer);
        pinUnlockCooldownTimer = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(pinUnlockCooldownTimer);
            pinUnlockCooldownTimer = null;
            setPinDialogError('可以再次尝试验证');
            if (submit) submit.disabled = false;
          } else setPinDialogError(`尝试次数过多，请 ${remaining} 秒后再试`);
        }, 1000);
      } else setPinDialogError('PIN 验证失败，请稍后重试');
    } finally {
      if (submit && !pinUnlockCooldownTimer) submit.disabled = false;
    }
  }
  function ensurePinUnlock() {
    if (pinUnlockPromise) return pinUnlockPromise;
    pinUnlockPromise = new Promise((resolve, reject) => {
      pinUnlockResolve = resolve;
      pinUnlockReject = reject;
      const { root, form, input, cancel, submit } = pinDialog();
      if (!root || !form || !input) {
        pinUnlockPromise = pinUnlockResolve = pinUnlockReject = null;
        reject(pinUnlockError('PIN 解锁界面不可用'));
        return;
      }
      root.classList.remove('hidden');
      input.value = '';
      setPinDialogError('');
      if (submit) submit.disabled = false;
      form.onsubmit = (event) => {
        event.preventDefault();
        void verifyPinFromDialog();
      };
      cancel.onclick = cancelPinUnlock;
      queueMicrotask(() => input.focus());
    });
    return pinUnlockPromise;
  }
  async function parseApiResponse(response) {
    const text = typeof response?.text === 'function' ? await response.text() : '';
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return payload;
  }
  async function fetchWithPinRetry(path, options = {}) {
    const { _pinRetried = false, _skipPinRetry = false, ...fetchOptions } = options || {};
    const headers = { ...(fetchOptions.headers || {}) };
    const hasBody = fetchOptions.body !== undefined && fetchOptions.body !== null;
    if (
      hasBody &&
      !(fetchOptions.body instanceof FormData) &&
      !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
    )
      headers['Content-Type'] = 'application/json';
    const token = localStorage.getItem(PIN_KEY);
    if (token) headers['X-App-Pin-Token'] = token;
    const response = await fetch(`${API_BASE}${path}`, { ...fetchOptions, headers });
    const payload = await parseApiResponse(response);
    const apiError = payload?.error || {};
    const code = apiError.code || (response.status === 503 ? 'MAINTENANCE' : 'HTTP_ERROR');
    if (!response.ok || !payload || payload.success !== true) {
      const error = new ApiError(
        response.status,
        code,
        apiError.message || `请求失败（${response.status}）`,
        apiError.details,
        Number(response.headers?.get?.('retry-after')) || undefined
      );
      if (!_skipPinRetry && pinRetryAllowed(path, { _pinRetried }, response.status, code)) {
        await ensurePinUnlock();
        return fetchWithPinRetry(path, { ...options, _pinRetried: true });
      }
      throw error;
    }
    return payload.data;
  }
  async function request(path, options = {}) {
    return fetchWithPinRetry(path, options);
  }
  async function requestBlob(path, options = {}) {
    const { _pinRetried = false, _skipPinRetry = false, ...fetchOptions } = options || {};
    const headers = { ...(fetchOptions.headers || {}) };
    const token = localStorage.getItem(PIN_KEY);
    if (token) headers['X-App-Pin-Token'] = token;
    const response = await fetch(`${API_BASE}${path}`, { ...fetchOptions, headers });
    if (!response.ok) {
      const payload = await parseApiResponse(response);
      const apiError = payload?.error || {};
      const code = apiError.code || (response.status === 503 ? 'MAINTENANCE' : 'HTTP_ERROR');
      const error = new ApiError(
        response.status,
        code,
        apiError.message || `请求失败（${response.status}）`,
        apiError.details,
        Number(response.headers?.get?.('retry-after')) || undefined
      );
      if (!_skipPinRetry && pinRetryAllowed(path, { _pinRetried }, response.status, code)) {
        await ensurePinUnlock();
        return requestBlob(path, { ...options, _pinRetried: true });
      }
      throw error;
    }
    return response.blob();
  }
  const ApiClient = {
    request,
    requestBlob,
    get: (path) => request(path),
    post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) }),
    put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (path, body) =>
      request(path, { method: 'DELETE', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    ApiError
  };
  function setText(selector, value, root = document) {
    const target = root.querySelector(selector);
    if (target) target.textContent = value == null ? '' : String(value);
  }
  function setBinding(binding, value, root = document) {
    setText(`[data-binding="${binding}"]`, value, root);
  }
  function toast(message = BLOCKED_MESSAGE, type = 'error') {
    window.showToast?.(message, type);
    return false;
  }
  function fail(error) {
    toast(error instanceof Error ? error.message : '请求失败', 'error');
    return undefined;
  }
  function emit(name) {
    window.BentoBus?.emit(name);
  }
  function mapStore(s) {
    return {
      ...s,
      // category 只来自后端 cuisine（nullable）：不再用 storeType 顶替，空即空
      category: s.cuisine ?? '',
      price: s.averageCost ?? null,
      rating: s.rating ?? '',
      phone: s.contact ?? '',
      hours: s.businessHours ?? '',
      dishes: s.recommendedDishes ?? '',
      icon: s.imagePath || '🍱',
      history: Array.isArray(s.relatedRecords) ? s.relatedRecords.map(mapRecord) : [],
      version: s.version
    };
  }
  function mapIngredient(i) {
    // 后端 RecipeIngredient 的正式字段是 ingredientNameSnapshot（+ 后端枚举 unit）；
    // 兼容旧本地形状（ingredientName/name），unit 保持后端枚举以便原样回写，展示用 unitLabel/amount
    const name = i.ingredientNameSnapshot || i.ingredientName || i.name || '';
    const unitKey = i.unit ?? null;
    const unitLabel = UNIT_LABELS[unitKey] ?? (unitKey || '');
    return {
      ...i,
      name,
      unit: unitKey,
      unitLabel,
      // 回填优先用户原文 amountText（"2汤匙"/"适量"），编辑表单与详情不丢原文语义；
      // 无原文时才用结构化 quantity+unitLabel 合成展示文本
      amount: i.amountText || (i.quantity == null ? '' : `${i.quantity}${unitLabel}`),
      pantryKeyword: name
    };
  }
  const BACKEND_UNITS = new Set([
    'GRAM',
    'KILOGRAM',
    'MILLILITER',
    'LITER',
    'PIECE',
    'BOX',
    'BAG',
    'BOTTLE',
    'CAN',
    'PACK',
    'PORTION',
    'OTHER'
  ]);
  // 只保留无歧义、后端真实支持且展示文案可无损往返的单位。
  // 「根」「块」等没有标准后端单位，绝不伪映射成 OTHER（会把「2根」显示成「2」）。
  const UNIT_TO_BACKEND = {
    g: 'GRAM',
    kg: 'KILOGRAM',
    ml: 'MILLILITER',
    L: 'LITER',
    l: 'LITER',
    克: 'GRAM',
    千克: 'KILOGRAM',
    公斤: 'KILOGRAM',
    毫升: 'MILLILITER',
    升: 'LITER',
    个: 'PIECE',
    盒: 'BOX',
    份: 'PORTION',
    瓶: 'BOTTLE',
    罐: 'CAN',
    包: 'PACK',
    袋: 'BAG'
  };
  const UNIT_LABELS = {
    GRAM: 'g',
    KILOGRAM: 'kg',
    MILLILITER: 'ml',
    LITER: 'L',
    PIECE: '个',
    BOX: '盒',
    BAG: '袋',
    BOTTLE: '瓶',
    CAN: '罐',
    PACK: '包',
    PORTION: '份',
    OTHER: ''
  };
  // 真正可用于结构化写回的标准单位（不含 OTHER 伪映射）：补量弹窗与 UPDATE 回写只接受这些
  const STANDARD_SHOPPING_UNITS = new Set([
    'GRAM',
    'KILOGRAM',
    'MILLILITER',
    'LITER',
    'PIECE',
    'BOX',
    'BAG',
    'BOTTLE',
    'CAN',
    'PACK',
    'PORTION'
  ]);
  function toBackendUnit(unit) {
    if (!unit) return null;
    if (BACKEND_UNITS.has(unit)) return unit;
    return UNIT_TO_BACKEND[unit] || null;
  }
  function toStandardShoppingUnit(unit) {
    const backend = toBackendUnit(unit);
    return backend && STANDARD_SHOPPING_UNITS.has(backend) ? backend : null;
  }
  function localDateKey(daysFromToday) {
    const date = new Date();
    date.setDate(date.getDate() + (daysFromToday || 0));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function daysUntil(dateText) {
    if (!dateText) return undefined;
    const target = new Date(`${dateText}T00:00:00`);
    if (Number.isNaN(target.getTime())) return undefined;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target.getTime() - today.getTime()) / 86400000);
  }
  function mapPantryItem(i) {
    return {
      ...i,
      unitKey: i.unit,
      unit: UNIT_LABELS[i.unit] ?? (i.unit || ''),
      icon: i.imagePath || '🥬',
      stock: i.quantity ?? 0,
      storageLocation: i.location || '',
      purchaseDate: i.purchaseDate || '',
      expireDate: i.expiryDate || '',
      expiryDate: i.expiryDate ?? null,
      expireDaysLeft: daysUntil(i.expiryDate)
    };
  }
  const SHOPPING_SOURCE_LABELS = {
    MANUAL: '手动备忘',
    RECIPE: '菜谱补料',
    RECOMMENDATION: '智能推荐',
    LOW_STOCK: '库存预警',
    PLAN: '排餐计划',
    INSUFFICIENT_STOCK: '库存预警'
  };
  function mapShoppingItem(item) {
    const unitLabel = UNIT_LABELS[item.unit] ?? '';
    const quantity = item.quantity ?? null;
    const amountText = typeof item.amountText === 'string' && item.amountText.trim() ? item.amountText.trim() : null;
    const quantityText = quantity == null ? '' : `${quantity}${unitLabel}`;
    return {
      ...item,
      unitKey: item.unit ?? null,
      unit: unitLabel,
      // 名称只取纯食材名：绝不再把规格拼进名字
      name: item.ingredientNameSnapshot || '',
      amountText,
      quantity,
      // 自由规格优先展示（保留用户原文语义），无原文才用结构化 quantity+单位合成
      amount: amountText || quantityText,
      hasStructuredQuantity: quantity != null && Number(quantity) > 0 && item.unit != null,
      category: '',
      isChecked: !!item.completed,
      source: SHOPPING_SOURCE_LABELS[item.sourceType] || '备忘'
    };
  }
  function mapRecipe(r) {
    // 后端枚举 → 正式中文 UI 标签；mealTypes/mealRoles/tools/tags 保留后端原始值供表单与详情使用
    const mealTypeLabels = (r.mealTypes || []).map((x) => MEAL_TYPE_LABELS[x.mealType || x] || '');
    const toolNames = (r.tools || []).map((t) => t.tool?.name || t.toolNameSnapshot || t.name || '').filter(Boolean);
    const tagNames = (r.tags || [])
      .map((t) => (typeof t === 'string' ? t : t.tag?.name || t.name || ''))
      .filter(Boolean);
    return {
      ...r,
      // category 是后端独立 nullable 字段；tags/mealTypes 仅用于各自关系展示，不能互相推导。
      category: r.category ?? null,
      icon: r.imagePath || '🥘',
      cookTimeMinutes: r.cookingTimeMinutes ?? null,
      calories: r.calories ?? null,
      tags: (r.tags || []).map((t) => (typeof t === 'string' ? { name: t } : { name: t.tag?.name || t.name || '' })),
      tagNames,
      mealTypeLabels,
      mealTypeKeys: (r.mealTypes || []).map((x) => x.mealType || x),
      mealRoleKeys: (r.mealRoles || []).map((x) => x.mealRole || x),
      toolKeys: (r.tools || []).map((t) => ({
        toolId: t.toolId ?? t.tool?.id ?? null,
        name: t.tool?.name || t.toolNameSnapshot || '',
        required: t.required !== false
      })),
      toolNames,
      ingredients: (r.ingredients || []).map(mapIngredient),
      steps: (r.steps || []).map((s, i) => ({
        ...s,
        stepIndex: s.stepNo || i + 1,
        // 标题与计时器均允许 null；步骤编号只用于 UI，不写回后端 title。
        title: s.title ?? null,
        desc: s.desc ?? s.content ?? '',
        timerMinutes: s.timerMinutes ?? null
      })),
      version: r.version
    };
  }
  const MEAL_ROLE_TO_BACKEND = {
    主菜: 'MAIN',
    配菜: 'SIDE',
    主食: 'STAPLE',
    汤品: 'SOUP',
    饮品: 'DRINK'
  };
  const MEAL_TYPE_TO_BACKEND = {
    早餐: 'BREAKFAST',
    午餐: 'LUNCH',
    晚餐: 'DINNER',
    下午茶: 'AFTERNOON_TEA',
    // 记录表单的就餐时段选项是「下午茶/夜宵」（正式 UI 选项，不允许改列表）：
    // 后端 MealType 只有 AFTERNOON_TEA，夜宵没有独立枚举，因此按最近语义接成 AFTERNOON_TEA，
    // 而不是让这个合法选项永远 422 阻断。
    '下午茶/夜宵': 'AFTERNOON_TEA',
    汤品: 'SOUP'
  };
  const MEAL_TYPE_LABELS = {
    BREAKFAST: '早餐',
    LUNCH: '午餐',
    DINNER: '晚餐',
    AFTERNOON_TEA: '下午茶',
    SOUP: '汤品'
  };
  const MEAL_TYPE_KEYS = new Set(Object.keys(MEAL_TYPE_LABELS));
  const MEAL_ROLE_KEYS = new Set(Object.values(MEAL_ROLE_TO_BACKEND));
  function toBackendMealType(slot) {
    return MEAL_TYPE_TO_BACKEND[slot] || (MEAL_TYPE_KEYS.has(slot) ? slot : null);
  }
  /** 菜谱适配餐次：接受正式中文标签或后端枚举，非法值快速失败，绝不静默丢弃。 */
  function toBackendRecipeMealTypes(values) {
    return (values || []).map((value) => {
      const key = MEAL_TYPE_TO_BACKEND[value] || (MEAL_TYPE_KEYS.has(value) ? value : null);
      if (!key) throw new ApiError(422, 'RECIPE_MEAL_TYPE_UNSUPPORTED', `餐次「${value}」无法映射到后端枚举，无法保存`);
      return key;
    });
  }
  /** 菜谱适配餐位：只接受后端枚举或其正式中文标签，非法值快速失败。 */
  function toBackendRecipeMealRoles(values) {
    return (values || []).map((value) => {
      const key = MEAL_ROLE_TO_BACKEND[value] || (MEAL_ROLE_KEYS.has(value) ? value : null);
      if (!key) throw new ApiError(422, 'RECIPE_MEAL_ROLE_UNSUPPORTED', `餐位「${value}」无法映射到后端枚举，无法保存`);
      return key;
    });
  }
  /** 菜谱工具：接受 DTO（{toolId,name}）或工具名/工具对象，非法值快速失败。 */
  function toBackendRecipeTools(values) {
    return (values || []).map((value) => {
      const toolId = typeof value === 'object' && value !== null ? (value.toolId ?? value.id ?? null) : null;
      const name =
        typeof value === 'string'
          ? value
          : (value?.name ?? value?.toolNameSnapshot ?? value?.tool?.name ?? value?.title ?? '');
      if (!String(name).trim())
        throw new ApiError(422, 'RECIPE_TOOL_UNSUPPORTED', '厨房工具名称无法映射到后端，无法保存');
      return {
        toolId,
        name: String(name).trim(),
        required: typeof value === 'object' ? value.required !== false : true
      };
    });
  }
  const SOURCE_TYPE_TO_BACKEND = {
    自烹: 'HOMEMADE',
    外卖: 'TAKEOUT',
    堂食: 'DINE_IN',
    CUSTOM: 'CUSTOM',
    自定义: 'CUSTOM'
  };
  const SOURCE_TYPE_LABELS = { HOMEMADE: '自烹', DINE_IN: '堂食', TAKEOUT: '外卖', CUSTOM: '其他' };
  const SOURCE_TYPE_ICONS = { HOMEMADE: '🍳', DINE_IN: '🍽️', TAKEOUT: '🛵', CUSTOM: '🍱' };
  /** 后端正式饱腹档位（meal-records/service.ts SATIETY_LEVELS 对齐）。 */
  const SATIETY_LEVELS = new Set([3, 5, 7, 8, 10]);
  function mapPlanItemTarget(item) {
    if (item?.itemType === 'RECIPE' && item.recipe)
      return {
        targetType: 'recipe',
        channel: 'cook',
        type: 'cook',
        targetId: item.recipe.id,
        title: item.recipe.name || '',
        icon: item.recipe.imagePath || '🥘'
      };
    if (item?.itemType === 'STORE' && item.store) {
      const channel = item.store.supportsTakeout === false && item.store.supportsDineIn ? 'dinein' : 'takeout';
      return {
        targetType: 'store',
        channel,
        type: channel,
        targetId: item.store.id,
        title: item.store.name || '',
        icon: item.store.imagePath || (channel === 'dinein' ? '🍽️' : '🛵')
      };
    }
    return {
      targetType: 'custom',
      channel: 'cook',
      type: 'cook',
      targetId: '',
      title: item?.customName || '',
      icon: '🍱'
    };
  }
  function mapPlan(p) {
    const target = mapPlanItemTarget((p.items || [])[0]);
    return {
      ...p,
      date: p.planDate,
      slot: MEAL_TYPE_LABELS[p.mealType] || p.mealType,
      time: p.time ?? null,
      subtext: p.subtext ?? null,
      linkedRecordId: p.linkedRecordId ?? '',
      isCompleted: p.status === 'COMPLETED',
      ...target,
      title: p.title ?? null,
      icon: p.icon ?? null,
      version: p.version
    };
  }
  /**
   * 正式控件输入解析：空值 → null（未填写），合法整数 → number，其余（非整数/非数字/超范围）一律失败。
   * 绝不使用 Number() 把 '12abc' 变成 NaN 再当 null，也不把非法值静默降级。
   */
  function parseOptionalIntegerInput(raw, { field, code, minimum, maximum }) {
    const text = raw === null || raw === undefined ? '' : String(raw).trim();
    if (text === '') return null;
    if (!/^-?\d+$/.test(text)) throw new ApiError(422, code, `${field}必须是整数，无法保存`);
    const value = Number(text);
    if (!Number.isInteger(value) || value < minimum || (maximum !== undefined && value > maximum))
      throw new ApiError(
        422,
        code,
        maximum === undefined ? `${field}不能小于 ${minimum}` : `${field}必须在 ${minimum} 到 ${maximum} 之间`
      );
    return value;
  }
  function parseRecipeCaloriesInput(raw) {
    return parseOptionalIntegerInput(raw, {
      field: '热量',
      code: 'RECIPE_CALORIES_INVALID',
      minimum: 50,
      maximum: 2000
    });
  }
  function parseRecordCaloriesInput(raw) {
    return parseOptionalIntegerInput(raw, { field: '摄入热量', code: 'RECORD_CALORIES_INVALID', minimum: 0 });
  }
  function parseRecordCostInput(raw) {
    return parseOptionalIntegerInput(raw, {
      field: '就餐消费',
      code: 'RECORD_COST_INVALID',
      minimum: 0,
      maximum: 9999
    });
  }
  /** 饱腹度：空值 → null，只接受正式档位 3/5/7/8/10，其余快速失败（不静默取整、不默认 8）。 */
  function parseRecordSatietyInput(raw) {
    const text = raw === null || raw === undefined ? '' : String(raw).trim();
    if (text === '') return null;
    if (!/^-?\d+$/.test(text)) throw new ApiError(422, 'RECORD_SATIETY_INVALID', '饱腹度必须是 3/5/7/8/10 之一');
    const value = Number(text);
    if (!SATIETY_LEVELS.has(value))
      throw new ApiError(422, 'RECORD_SATIETY_INVALID', '饱腹度必须是 3/5/7/8/10 之一，无法保存');
    return value;
  }
  function mapRecord(r) {
    const item = (r.items || [])[0];
    return {
      ...r,
      date: r.recordDate,
      slot: MEAL_TYPE_LABELS[r.mealType] || r.mealType,
      type: SOURCE_TYPE_LABELS[r.sourceType] || r.sourceType,
      icon: SOURCE_TYPE_ICONS[r.sourceType] || '🍱',
      title: r.title != null ? r.title : item?.customName || item?.recipe?.name || item?.store?.name || '',
      recipeId: r.recipeId ?? item?.recipeId ?? item?.recipe?.id ?? null,
      // 后端 nullable 营养字段原样保留 null：不伪造成 ''/undefined，也不补 500/8/0 默认值
      calories: r.calories ?? null,
      satiety: r.satiety ?? null,
      cost: r.cost ?? null,
      notes: r.notes ?? null,
      photos: Array.isArray(r.photos) ? r.photos.slice(0, 3) : r.imagePath ? [r.imagePath] : [],
      version: r.version
    };
  }
  function mapTool(t) {
    return { ...t, icon: t.icon ?? null, version: t.version };
  }
  function pageItems(data) {
    return Array.isArray(data) ? data : data?.items || [];
  }
  async function loadAll(path, seq, getSeq) {
    const first = await ApiClient.get(`${path}?page=1&pageSize=100`);
    const firstItems = pageItems(first);
    const totalPages = Number(
      first?.totalPages || (first?.total && first?.pageSize ? Math.ceil(first.total / first.pageSize) : 1)
    );
    const values = firstItems.slice();
    for (let page = 2; page <= totalPages; page += 1) {
      const next = await ApiClient.get(`${path}?page=${page}&pageSize=100`);
      values.push(...pageItems(next));
    }
    return getSeq() === seq ? values : null;
  }
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const canonicalOrAlias = (value, canonical, alias) =>
    own(value, canonical) ? value[canonical] : alias && own(value, alias) ? value[alias] : undefined;
  function normalizeStoreMenuItems(items) {
    if (!Array.isArray(items) || items.length > 100) throw new ApiError(422, 'STORE_MENU_INVALID', '菜单最多 100 项');
    const result = [];
    for (const item of items) {
      const name = typeof item?.name === 'string' ? item.name.trim() : '';
      const rawPrice = item?.price;
      const price = rawPrice == null || rawPrice === '' ? null : Number(rawPrice);
      const isSignature = item?.isSignature === true;
      if (!name && price === null && !isSignature) continue;
      if (!name || name.length > 100 || (price !== null && (!Number.isInteger(price) || price < 1 || price > 999)))
        throw new ApiError(422, 'STORE_MENU_INVALID', 'store menu item is invalid');
      const icon = item?.icon == null ? null : String(item.icon);
      const desc = item?.desc == null ? null : String(item.desc);
      if ((icon !== null && icon.length > 20) || (desc !== null && desc.length > 500))
        throw new ApiError(422, 'STORE_MENU_INVALID', 'store menu metadata is invalid');
      result.push({ name, price, icon, desc, isSignature, sortOrder: result.length });
    }
    return result;
  }
  function replaceStoreService(service) {
    let listSeq = 0;
    const reload = async () => {
      const seq = ++listSeq;
      const values = await loadAll('/stores', seq, () => listSeq);
      if (!values) return service.data;
      service.data = values.map(mapStore);
      emit('stores:changed');
      return service.data;
    };
    service.getAll = () => service.data;
    service.getById = (id) => service.data.find((x) => x.id === id);
    service.reload = reload;
    service.getByIdRemote = async (id) => {
      const mapped = mapStore(await ApiClient.get(`/stores/${encodeURIComponent(id)}`));
      service.data = service.data.some((x) => x.id === mapped.id)
        ? service.data.map((x) => (x.id === mapped.id ? mapped : x))
        : [mapped, ...service.data];
      emit('stores:changed');
      return mapped;
    };
    service.save = async (store) => {
      if (typeof store?.name !== 'string' || !store.name.trim())
        throw new ApiError(422, 'STORE_NAME_REQUIRED', '店铺名称不能为空');
      const isUpdate = Boolean(store.id);
      const existing = isUpdate ? service.data.find((item) => item.id === store.id) : null;
      if (isUpdate && !existing) throw new ApiError(404, 'STORE_NOT_FOUND', '编辑门店不存在');
      if (isUpdate && (!Number.isInteger(store.version ?? existing.version) || (store.version ?? existing.version) < 1))
        throw new ApiError(409, 'STORE_VERSION_REQUIRED', '编辑门店缺少有效版本');
      const version = store.version ?? existing?.version;
      const body = {};
      if (own(store, 'name')) body.name = store.name;
      const aliases = [
        ['address'],
        ['storeType'],
        ['cuisine', 'category'],
        ['averageCost', 'price'],
        ['supportsDineIn'],
        ['supportsTakeout'],
        ['contact', 'phone'],
        ['businessHours', 'hours'],
        ['rating'],
        ['recommendedDishes', 'dishes'],
        ['notes'],
        ['favorite'],
        ['imagePath'],
        ['avoidDishes'],
        ['tagsText'],
        ['mealTypes']
      ];
      for (const [canonical, alias] of aliases) {
        const value = canonicalOrAlias(store, canonical, alias);
        if (value !== undefined) body[canonical] = value;
      }
      if (own(store, 'menuItems')) body.menuItems = normalizeStoreMenuItems(store.menuItems);
      const dto = store.id
        ? await ApiClient.put(`/stores/${encodeURIComponent(store.id)}`, { ...body, version })
        : await ApiClient.post('/stores', body);
      const mapped = mapStore(dto);
      service.data = service.data.some((x) => x.id === mapped.id)
        ? service.data.map((x) => (x.id === mapped.id ? mapped : x))
        : [mapped, ...service.data];
      emit('stores:changed');
      emit('favorites:changed');
      window.BentoModal?.close(true);
      toast(store.id ? '店铺已更新' : '店铺已创建', 'success');
      return mapped;
    };
    service.delete = async (id) => {
      const item = service.getById(id);
      if (!item) return;
      await ApiClient.delete(`/stores/${encodeURIComponent(id)}`, { version: item.version });
      service.data = service.data.filter((x) => x.id !== id);
      emit('stores:changed');
      emit('favorites:changed');
      toast('店铺已删除', 'success');
    };
    service.toggleFavorite = async (id) => {
      const item = service.getById(id);
      if (!item) return;
      const mapped = mapStore(
        await ApiClient.post(`/stores/${encodeURIComponent(id)}/favorite`, {
          favorite: !item.favorite,
          version: item.version
        })
      );
      service.data = service.data.map((x) => (x.id === id ? mapped : x));
      emit('stores:changed');
      emit('favorites:changed');
      toast(mapped.favorite ? '已收藏店铺' : '已取消收藏店铺', 'success');
      return mapped;
    };
    return reload;
  }
  function replaceRecipeService(service) {
    let listSeq = 0;
    const reload = async () => {
      const seq = ++listSeq;
      const values = await loadAll('/recipes', seq, () => listSeq);
      if (!values) return service.data;
      service.data = values.map(mapRecipe);
      emit('recipes:changed');
      return service.data;
    };
    service.getAll = () => service.data;
    service.getById = (id) => service.data.find((x) => x.id === id);
    service.reload = reload;
    service.getByIdRemote = async (id) => {
      // 详情/编辑远端读取优先于并发列表 reload；递增序号使尚未完成的旧列表结果失效，避免把真实 DTO 覆盖回旧缓存。
      ++listSeq;
      const mapped = mapRecipe(await ApiClient.get(`/recipes/${encodeURIComponent(id)}`));
      service.data = service.data.some((x) => x.id === mapped.id)
        ? service.data.map((x) => (x.id === mapped.id ? mapped : x))
        : [mapped, ...service.data];
      emit('recipes:changed');
      return mapped;
    };
    service.save = async (recipe) => {
      const ingredients = (recipe.ingredients || []).map((i) => {
        const name = String(i.name || i.ingredientNameSnapshot || i.ingredientName || '').trim();
        const quantity = typeof i.quantity === 'number' ? i.quantity : null;
        // 只接受后端 QuantityUnit 枚举；中文/未知单位显式失败，不静默丢弃
        let unit = i.unit ?? null;
        if (unit !== null && unit !== '') {
          unit = toBackendUnit(unit);
          if (!unit)
            throw new ApiError(
              422,
              'RECIPE_INGREDIENT_UNIT_UNSUPPORTED',
              `食材「${name}」的计量单位无法映射到后端单位，无法保存`
            );
        } else {
          unit = null;
        }
        if (!name) throw new ApiError(422, 'RECIPE_INGREDIENT_NAME_UNSUPPORTED', '食材名称不能为空，无法保存');
        return {
          ingredientId: i.ingredientId ?? null,
          name,
          quantity,
          unit,
          amountText: i.amountText ?? null,
          optional: i.optional ?? null,
          isPrimary: i.isPrimary ?? null
        };
      });
      // 步骤正文是后端唯一必填字段；后端独立持久化 title 与 content，正文绝不拼接标题。
      // 无 content 的旧形状用 desc 兜底；仍为空显式失败，绝不伪造占位步骤
      const steps = (recipe.steps || []).map((s) => {
        const content = String(s.content ?? s.desc ?? '').trim();
        if (!content) throw new ApiError(422, 'RECIPE_STEP_CONTENT_UNSUPPORTED', '制作步骤内容不能为空，无法保存');
        return {
          content,
          title: s.title ?? null,
          timerMinutes: s.timerMinutes ?? null,
          imagePath: s.imagePath ?? null
        };
      });
      const body = {
        name: recipe.name,
        ...(Object.prototype.hasOwnProperty.call(recipe, 'category') && recipe.category !== undefined
          ? { category: recipe.category || null }
          : {}),
        imagePath: recipe.imagePath ?? null,
        ingredientsText: recipe.ingredientsText ?? null,
        cookingTimeMinutes: recipe.cookingTimeMinutes ?? recipe.cookTimeMinutes ?? null,
        difficulty: recipe.difficulty ?? null,
        spicyLevel: recipe.spicyLevel ?? null,
        servings: recipe.servings ?? null,
        // 热量：number → 原样保存；null/'' → 显式 null（清空，不写 320 之类的伪默认）；其余快速失败
        calories: parseRecipeCaloriesInput(recipe.calories),
        sourceNote: recipe.sourceNote ?? null,
        notes: recipe.notes ?? null,
        favorite: recipe.favorite ?? false,
        enabledForRecommendation: recipe.enabledForRecommendation ?? true,
        ingredients,
        steps,
        tags: Array.isArray(recipe.tags)
          ? recipe.tags.map((x) => (typeof x === 'string' ? x : (x?.tag?.name ?? x?.name ?? ''))).filter(Boolean)
          : [],
        // 餐次/餐位/工具严格按后端 enum 转换：UI 只送正式标签或已有枚举，非法值快速失败不静默丢弃
        // （可直接传后端枚举数组，也可传 UI 正式中文标签；列表形式兼容 legacy 的 mealTypes/mealRoles/toolIds）
        mealTypes: toBackendRecipeMealTypes(recipe.mealTypes ?? recipe.mealTypeKeys ?? []),
        mealRoles: toBackendRecipeMealRoles(recipe.mealRoles ?? recipe.mealRoleKeys ?? []),
        toolIds: toBackendRecipeTools(recipe.toolIds ?? recipe.toolKeys ?? [])
      };
      const dto = recipe.id
        ? await ApiClient.put(`/recipes/${encodeURIComponent(recipe.id)}`, { ...body, version: recipe.version })
        : await ApiClient.post('/recipes', body);
      const mapped = mapRecipe(dto);
      service.data = service.data.some((x) => x.id === mapped.id)
        ? service.data.map((x) => (x.id === mapped.id ? mapped : x))
        : [mapped, ...service.data];
      emit('recipes:changed');
      emit('favorites:changed');
      window.BentoModal?.close(true);
      toast(recipe.id ? '菜谱已更新' : '菜谱已创建', 'success');
      return mapped;
    };
    service.delete = async (id) => {
      const item = service.getById(id);
      if (!item) return;
      await ApiClient.delete(`/recipes/${encodeURIComponent(id)}?version=${encodeURIComponent(item.version)}`);
      service.data = service.data.filter((x) => x.id !== id);
      emit('recipes:changed');
      emit('favorites:changed');
      toast('菜谱已删除', 'success');
    };
    service.toggleFavorite = async (id) => {
      const item = service.getById(id);
      if (!item) return;
      const mapped = mapRecipe(
        await ApiClient.post(`/recipes/${encodeURIComponent(id)}/favorite`, {
          favorite: !item.favorite,
          version: item.version
        })
      );
      service.data = service.data.map((x) => (x.id === id ? mapped : x));
      emit('recipes:changed');
      emit('favorites:changed');
      toast(mapped.favorite ? '已收藏菜谱' : '已取消收藏菜谱', 'success');
      return mapped;
    };
    service.cookCheckin = async (idOrRecipe) => {
      const recipeId = typeof idOrRecipe === 'object' ? idOrRecipe?.id : idOrRecipe;
      if (!recipeId) return toast('菜谱不存在', 'error');
      try {
        const recipe = await service.getByIdRemote(recipeId);
        return window.BentoModal?.open('recordForm', { __cookRecipe: recipe });
      } catch (error) {
        return fail(error);
      }
    };
    service.addMissingIngredientsToShopping = async (id) => {
      const recipe = service.getById(id);
      if (!recipe) return false;
      const shopping = window.BentoService?.shopping;
      if (!shopping?.replenishRecipe) return toast();
      const pantry = window.BentoService?.pantry?.data || [];
      const items = [];
      for (const ing of recipe.ingredients || []) {
        const name = String(ing.name ?? '').trim();
        if (!name) continue;
        const rawAmount = String(ing.amountText ?? ing.amount ?? '').trim();
        // 严格库存匹配：有 ingredientId 只按 ID；无 ID 只按归一化精确同名且必须唯一命中。
        // 绝不用 includes 子串（「洋葱」不能命中「葱」），同名多条歧义也不当作库存充足。
        let matched = null;
        let ingredientId = null;
        if (ing.ingredientId) {
          matched = pantry.find((p) => p.id === ing.ingredientId) || null;
          // 库存中已不存在该 ID：视作未匹配，且不再绑定失效关联
          if (matched) ingredientId = ing.ingredientId;
        } else {
          const matches = pantry.filter((p) => normalizeShoppingName(p.name) === normalizeShoppingName(name));
          if (matches.length === 1) {
            matched = matches[0];
            ingredientId = matched.id ?? null;
          }
        }
        // 需求规格：优先结构化 quantity+unit（OTHER 视为自由规格），否则解析原文
        const structuredDemand =
          ing.quantity != null && Number(ing.quantity) > 0 && ing.unit && ing.unit !== 'OTHER'
            ? { quantity: Number(ing.quantity), unit: ing.unit }
            : null;
        const demand = structuredDemand || parseShoppingAmount(rawAmount);
        const stock = matched ? Number(matched.stock) : 0;
        let deficit = null;
        if (demand && matched && Number.isFinite(stock) && stock > 0) {
          const converted = convertQuantity(stock, matched.unitKey, demand.unit);
          if (converted != null) deficit = roundQuantity(demand.quantity - converted);
        }
        // 需求与库存同维且有正库存：差额 <= 0 表示充足，跳过；否则按差额补货
        if (deficit !== null && deficit <= 0) continue;
        if (demand) {
          const isDeficit = deficit !== null;
          const quantity = isDeficit ? deficit : demand.quantity;
          const standardText = `${demand.quantity}${UNIT_LABELS[demand.unit] ?? ''}`;
          items.push({
            ingredientId,
            ingredientName: name,
            quantity,
            unit: demand.unit,
            amountText: !isDeficit && rawAmount && rawAmount !== standardText ? rawAmount : null
          });
        } else {
          // 自由规格 / 不可换算 / 无库存：全量按原文补货，绝不静默漏买，也绝不拼括号进名称
          items.push({
            ingredientId,
            ingredientName: name,
            quantity: null,
            unit: null,
            amountText: rawAmount || '适量'
          });
        }
      }
      if (!items.length) {
        toast('菜谱食材均已在库，无需补货', 'success');
        return recipe;
      }
      await shopping.replenishRecipe(recipe.id, items);
      // 详情刷新失败不影响已成功的补货结果：错误只提示，不回滚、不误报失败
      try {
        await window.BentoModal?.open?.('recipeDetail', id);
      } catch {
        /* keep the successful replenish result visible */
      }
      toast(`已成功将 ${items.length} 项食材加入购物清单！`, 'success');
      return recipe;
    };
    return reload;
  }
  function replacePantryService(service) {
    let listSeq = 0;
    const reload = async () => {
      const seq = ++listSeq;
      const values = await loadAll('/ingredients', seq, () => listSeq);
      if (!values) return service.data;
      service.data = values.map(mapPantryItem);
      emit('pantry:changed');
      return service.data;
    };
    service.getAll = () => service.data;
    service.getById = (id) => service.data.find((x) => x.id === id);
    service.reload = reload;
    service.getByIdRemote = async (id) => {
      const mapped = mapPantryItem(await ApiClient.get(`/ingredients/${encodeURIComponent(id)}`));
      service.data = service.data.some((x) => x.id === mapped.id)
        ? service.data.map((x) => (x.id === mapped.id ? mapped : x))
        : [mapped, ...service.data];
      emit('pantry:changed');
      return mapped;
    };
    service.save = async (item) => {
      const unit = toBackendUnit(item.unitKey || item.unit);
      if (!unit) throw new ApiError(422, 'INGREDIENT_UNIT_UNSUPPORTED', '食材计量单位无法映射到后端单位，无法保存');
      if (item.id) {
        const existing = service.getById(item.id);
        if (
          (item.batches && item.batches.length) ||
          (item.storageLocation !== undefined && item.storageLocation !== (existing?.location || ''))
        )
          throw new ApiError(
            422,
            'INGREDIENT_BATCHES_UNSUPPORTED',
            '后端食材更新不支持修改批次信息（数量/存放位置/到期日），暂无法保存'
          );
        const body = {
          name: item.name,
          imagePath: item.imagePath || null,
          category: item.category || null,
          unit,
          minStock: item.minStock ?? null,
          maxStock: item.maxStock ?? null,
          notes: item.notes || null,
          version: item.version
        };
        const dto = await ApiClient.put(`/ingredients/${encodeURIComponent(item.id)}`, body);
        const mapped = mapPantryItem(dto);
        service.data = service.data.map((x) => (x.id === mapped.id ? mapped : x));
        emit('pantry:changed');
        window.BentoModal?.close(true);
        toast('食材已更新', 'success');
        return mapped;
      }
      const body = {
        name: item.name,
        imagePath: item.imagePath || null,
        category: item.category || null,
        unit,
        minStock: item.minStock ?? null,
        maxStock: item.maxStock ?? null,
        notes: item.notes || null,
        batches: [
          {
            quantity: Number(item.stock),
            unit,
            purchaseDate: item.purchaseDate || null,
            expiryDate:
              item.expireDaysLeft == null || item.expireDaysLeft === ''
                ? null
                : localDateKey(Math.round(Number(item.expireDaysLeft))),
            location: item.storageLocation || null,
            opened: !!item.opened,
            consumePriority: !!item.consumePriority,
            notes: null
          }
        ]
      };
      const dto = await ApiClient.post('/ingredients', body);
      const mapped = mapPantryItem(dto);
      service.data = [mapped, ...service.data];
      emit('pantry:changed');
      window.BentoModal?.close(true);
      toast('食材已录入', 'success');
      return mapped;
    };
    service.delete = async (id) => {
      const item = service.getById(id);
      if (!item) return;
      await ApiClient.delete(`/ingredients/${encodeURIComponent(id)}?version=${encodeURIComponent(item.version)}`);
      service.data = service.data.filter((x) => x.id !== id);
      emit('pantry:changed');
      toast('食材已删除', 'success');
    };
    const consumePromises = new Map();
    service.consume = (payload, amount) => {
      const id = typeof payload === 'object' ? payload?.id : payload;
      if (!id) return Promise.reject(new ApiError(422, 'INGREDIENT_ID_REQUIRED', '食材缺少真实 ID'));
      if (consumePromises.has(id)) return consumePromises.get(id);
      const item = typeof payload === 'object' ? payload : service.getById(id);
      const version = Number(item?.version);
      if (!Number.isInteger(version) || version < 1) return toast('食材版本已失效，请刷新后重试', 'error');
      const mode = amount === 'all' ? 'ALL' : 'QUANTITY';
      const body = { mode, ingredientVersion: version };
      if (mode === 'QUANTITY') {
        if (![100, 250].includes(amount))
          return Promise.reject(new ApiError(422, 'INGREDIENT_CONSUME_AMOUNT_INVALID', '扣减数量无效'));
        const unit =
          item?.unitKey || (Object.entries(UNIT_LABELS).find(([, label]) => label === item?.unit)?.[0] ?? null);
        if (unit !== 'GRAM') return toast('100g/250g 扣减仅适用于克（GRAM）食材', 'error');
        body.quantity = amount;
        body.unit = 'GRAM';
      }
      const promise = (async () => {
        const result = await ApiClient.post(`/ingredients/${encodeURIComponent(id)}/consume`, body);
        const mapped = mapPantryItem(result.ingredient);
        service.data = service.data.some((x) => x.id === mapped.id)
          ? service.data.map((x) => (x.id === mapped.id ? mapped : x))
          : [mapped, ...service.data];
        emit('pantry:changed');
        try {
          await service.getByIdRemote(id);
          await window.BentoModal?.open?.('ingredientDetail', id);
        } catch {
          toast('扣减已成功，但详情刷新失败，请稍后重试', 'warning');
        }
        toast(mode === 'ALL' ? '已全部消耗该食材' : `已消耗 ${amount}g`, 'success');
        return mapped;
      })();
      consumePromises.set(id, promise);
      promise.catch(async (error) => {
        if (error?.status === 409) {
          try {
            await service.getByIdRemote(id);
            await window.BentoModal?.open?.('ingredientDetail', id);
          } catch {
            // Keep the original conflict visible when refresh also fails.
          }
        }
        fail(error);
      });
      promise.finally(() => consumePromises.delete(id)).catch(() => undefined);
      return promise;
    };
    service.addToShopping = async (id) => {
      const item = service.getById(id);
      if (!item) return;
      const shopping = window.BentoService?.shopping;
      if (!shopping?.add) return toast();
      // OTHER/无展示单位（unitKey === 'OTHER' 或空字符串）派生不出标准规格：
      // 直接按自由规格「适量」加入，绝不生成裸「1」这种无单位字符串。
      const hasUnit = !!item.unit && item.unitKey !== 'OTHER';
      await shopping.add(
        {
          name: `${item.name} (手动补货)`,
          amount: hasUnit ? `1${item.unit}` : '适量',
          isChecked: false,
          source: '冰箱档案手动补货'
        },
        false
      );
      window.BentoModal?.close();
      toast(`已将「${item.name}」加入购物清单！`, 'success');
      return item;
    };
    return reload;
  }
  function parseShoppingAmount(amount) {
    const match = String(amount ?? '')
      .trim()
      .match(/^([0-9]+(?:\.[0-9]+)?)\s*(.*)$/);
    if (!match) return null;
    const quantity = Number(match[1]);
    const unit = toBackendUnit(match[2]);
    if (!Number.isFinite(quantity) || quantity <= 0 || !unit) return null;
    return { quantity, unit };
  }
  // 后端单位换算只覆盖无争议的同维度缩放；其他组合一律视为不可换算（不猜、不近似）。
  const UNIT_CONVERSION = {
    GRAM: { dimension: 'MASS', factor: 1 },
    KILOGRAM: { dimension: 'MASS', factor: 1000 },
    MILLILITER: { dimension: 'VOLUME', factor: 1 },
    LITER: { dimension: 'VOLUME', factor: 1000 }
  };
  function convertQuantity(value, fromUnit, toUnit) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return null;
    if (fromUnit === toUnit) return amount;
    const from = UNIT_CONVERSION[fromUnit];
    const to = UNIT_CONVERSION[toUnit];
    if (!from || !to || from.dimension !== to.dimension) return null;
    return (amount * from.factor) / to.factor;
  }
  function roundQuantity(value, digits = 4) {
    const rounded = Number(Number(value).toFixed(digits));
    return Number.isFinite(rounded) ? rounded : null;
  }
  function normalizeShoppingName(value) {
    return String(value ?? '')
      .trim()
      .toLocaleLowerCase();
  }
  function replaceShoppingService(service) {
    let list = null;
    let listSeq = 0;
    let ensuring = null;
    let checkinPromise = null;
    const pendingKey = 'dafan-shopping-checkin-pending';
    // fail-closed 读取：无法解析 / localStorage 读取抛错 / 结构不合法 一律返回 invalid，
    // 绝不退化成 null（否则会被当成“没有未决操作”，用新勾选覆盖尚未确认的旧操作）。
    const readPending = () => {
      let raw;
      try {
        raw = localStorage.getItem(pendingKey);
      } catch {
        return { status: 'invalid', value: null };
      }
      // 只有 null 才表示“没有未决操作”；空字符串是损坏记录，必须 invalid fail-closed
      if (raw === null) return { status: 'absent', value: null };
      if (raw === '') return { status: 'invalid', value: null };
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        return { status: 'invalid', value: null };
      }
      const valid =
        value &&
        typeof value.listId === 'string' &&
        value.listId.trim() !== '' &&
        Number.isInteger(value.version) &&
        value.version > 0 &&
        typeof value.operationId === 'string' &&
        // 与 server 的 operationId 正则可发送集合一致：本地先按同一契约拦截非法值
        /^[A-Za-z0-9._:-]{1,160}$/.test(value.operationId) &&
        Array.isArray(value.itemIds) &&
        value.itemIds.length > 0 &&
        // 空白/空 ID 都视为损坏：server 端不可能存在这种 item id
        value.itemIds.every((id) => typeof id === 'string' && id.trim() !== '') &&
        new Set(value.itemIds).size === value.itemIds.length;
      return valid
        ? {
            status: 'ok',
            value: {
              listId: value.listId,
              version: value.version,
              operationId: value.operationId,
              itemIds: [...value.itemIds]
            }
          }
        : { status: 'invalid', value: null };
    };
    const writePending = (value) => {
      try {
        localStorage.setItem(pendingKey, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    };
    const applyList = (dto) => {
      list = dto;
      service.data = (dto?.items || []).map(mapShoppingItem);
      emit('shopping:changed');
      return dto;
    };
    const ensureList = () => {
      if (list) return Promise.resolve(list);
      ensuring =
        ensuring ||
        (async () => {
          const active = await ApiClient.get('/shopping-lists?status=ACTIVE');
          if (Array.isArray(active) && active.length) return applyList(active[0]);
          return applyList(await ApiClient.post('/shopping-lists', { name: '购物补货清单' }));
        })();
      return ensuring.finally(() => {
        ensuring = null;
      });
    };
    const reload = async () => {
      const seq = ++listSeq;
      const active = await ApiClient.get('/shopping-lists?status=ACTIVE');
      if (seq !== listSeq) return service.data;
      if (Array.isArray(active) && active.length) {
        applyList(active[0]);
        return service.data;
      }
      applyList(await ApiClient.post('/shopping-lists', { name: '购物补货清单' }));
      return service.data;
    };
    service.getAll = () => service.data;
    service.getById = (id) => service.data.find((x) => x.id === id);
    service.reload = reload;
    const requireList = () => {
      if (!list) throw new ApiError(409, 'SHOPPING_LIST_NOT_LOADED', '购物清单尚未加载完成，请稍后重试');
      return list;
    };
    const validateStructured = (quantity, unit) => {
      if (quantity == null && unit == null) return { quantity: null, unit: null };
      if (quantity == null || unit == null)
        throw new ApiError(422, 'SHOPPING_ITEM_INVALID', '采购数量与单位必须同时提供或同时为空');
      const value = Number(quantity);
      if (!Number.isFinite(value) || value <= 0) throw new ApiError(422, 'SHOPPING_ITEM_INVALID', '采购数量必须大于 0');
      // OTHER 不是可写回的真实标准单位：只接受 11 种标准单位
      const backendUnit = toStandardShoppingUnit(unit);
      if (!backendUnit) throw new ApiError(422, 'SHOPPING_ITEM_INVALID', '采购单位无法映射到后端单位');
      return { quantity: value, unit: backendUnit };
    };
    service.add = async (item, notify = true) => {
      const name = String(item?.name ?? '').trim();
      const rawAmount = String(item?.amount ?? '').trim();
      // 名称与规格都必须非空：无规格的裸条目无法入库，直接快速失败而不是造默认量
      if (!name || !rawAmount) throw new ApiError(422, 'SHOPPING_ITEM_INVALID', '采购物品名称与数量规格不能为空');
      const parsed = parseShoppingAmount(rawAmount);
      const current = await ensureList();
      const sourceType = typeof item.source === 'string' && item.source.startsWith('菜谱:') ? 'RECIPE' : 'MANUAL';
      const body = {
        version: current.version,
        ingredientName: name,
        sourceType,
        sourceId: null,
        completed: !!item.isChecked
      };
      if (parsed) {
        body.quantity = parsed.quantity;
        body.unit = parsed.unit;
        // 只有用户原文与标准展示不一致时才保留原文（例如「200克」），标准写法不额外携带
        if (rawAmount !== `${parsed.quantity}${UNIT_LABELS[parsed.unit]}`) body.amountText = rawAmount;
      } else {
        // 自由规格（适量 / 2根 / 1勺）：保留原文，绝不伪映射成 OTHER 或默认 1 份
        body.quantity = null;
        body.unit = null;
        body.amountText = rawAmount;
      }
      // 分类只在调用方显式给出时透传，名称/规格契约不变
      if (item?.category !== undefined) body.category = item.category;
      const dto = await ApiClient.post(`/shopping-lists/${encodeURIComponent(current.id)}/items`, body);
      applyList(dto);
      if (notify !== false) toast(`已将「${name}」加入购物清单！`, 'success');
      return dto;
    };
    /**
     * 更新单条购物项（补量入库/结构化回写）。
     * - 未传 ingredientId 时保留后端既有关系（请求体不携带该字段）；
     * - 未传 amountText 且显式补填了结构化数量单位时让后端清空旧自由规格（不发送 amountText）。
     */
    service.updateItem = async (id, updates = {}) => {
      const target = service.getById(id);
      if (!target) throw new ApiError(404, 'SHOPPING_ITEM_NOT_FOUND', '购物清单项目不存在');
      const current = requireList();
      const body = { version: current.version };
      if (updates.completed !== undefined) body.completed = !!updates.completed;
      if (updates.quantity !== undefined || updates.unit !== undefined) {
        const structured = validateStructured(
          updates.quantity !== undefined ? updates.quantity : null,
          updates.unit !== undefined ? updates.unit : null
        );
        body.quantity = structured.quantity;
        body.unit = structured.unit;
      }
      if (updates.ingredientName !== undefined) {
        const nextName = String(updates.ingredientName ?? '').trim();
        if (!nextName) throw new ApiError(422, 'SHOPPING_ITEM_INVALID', '采购物品名称不能为空');
        body.ingredientName = nextName;
      }
      if (updates.amountText !== undefined) body.amountText = updates.amountText;
      // 白名单透传：仅在调用方显式给出时才发送，未给出时保持后端原值（尤其是 ingredientId 关联）
      if (updates.category !== undefined) body.category = updates.category;
      if (updates.ingredientId !== undefined) {
        if (updates.ingredientId !== null && typeof updates.ingredientId !== 'string')
          throw new ApiError(422, 'SHOPPING_ITEM_INVALID', '食材关联 ID 必须是字符串或 null');
        body.ingredientId = updates.ingredientId;
      }
      if (updates.sortOrder !== undefined) {
        if (!Number.isInteger(updates.sortOrder))
          throw new ApiError(422, 'SHOPPING_ITEM_INVALID', '排序值必须是整数');
        body.sortOrder = updates.sortOrder;
      }
      if (updates.notes !== undefined) body.notes = updates.notes;
      const dto = await ApiClient.put(`/shopping-list-items/${encodeURIComponent(target.id)}`, body);
      return applyList(dto);
    };
    service.clearCompleted = async () => {
      const current = requireList();
      const dto = await ApiClient.post(`/shopping-lists/${encodeURIComponent(current.id)}/clear-completed`, {
        version: current.version
      });
      // 后端返回 { list, cleared }：只有 list 才是清单 DTO
      const nextList = dto?.list ?? dto;
      applyList(nextList);
      const cleared = Number(dto?.cleared ?? 0);
      toast(cleared > 0 ? `已清理 ${cleared} 项已购物品` : '没有可清理的已购物品', 'success');
      return nextList;
    };
    // 菜谱缺料批量补齐（单事务）：同菜谱同食材对齐更新、跨菜谱/手动项保持独立行，整批只推进一次版本
    service.replenishRecipe = async (recipeId, items) => {
      const id = String(recipeId ?? '').trim();
      if (!id) throw new ApiError(422, 'SHOPPING_RECIPE_REQUIRED', '菜谱 ID 不能为空');
      if (!Array.isArray(items) || items.length === 0)
        throw new ApiError(422, 'SHOPPING_ITEM_INVALID', '补货项目不能为空');
      const current = await ensureList();
      const path = `/shopping-lists/${encodeURIComponent(current.id)}/replenish-recipe`;
      try {
        const dto = await ApiClient.post(path, { version: current.version, recipeId: id, items });
        return applyList(dto);
      } catch (error) {
        // 只在明确的版本冲突时用最新 version 重试一次；其余错误原样抛出，不做无界重试
        if (error?.status !== 409 || error?.code !== 'VERSION_CONFLICT') throw error;
        const latest = await fetchListById(current.id);
        applyList(latest);
        const dto = await ApiClient.post(path, { version: latest.version, recipeId: id, items });
        return applyList(dto);
      }
    };
    service.toggle = async (id) => {
      const item = service.getById(id);
      if (!item || !list) return;
      const dto = await ApiClient.put(`/shopping-list-items/${encodeURIComponent(item.id)}`, {
        version: list.version,
        completed: !item.isChecked
      });
      return applyList(dto);
    };
    service.delete = async (id) => {
      const item = service.getById(id);
      if (!item || !list) return;
      await ApiClient.delete(
        `/shopping-list-items/${encodeURIComponent(item.id)}?version=${encodeURIComponent(list.version)}`
      );
      const dto = await ApiClient.get(`/shopping-lists/${encodeURIComponent(list.id)}`);
      return applyList(dto);
    };
    // 回拉指定清单的最新 DTO（不使用 check-in 的幂等缓存响应，避免旧版本覆盖之后的改动）
    const fetchListById = (listId) => ApiClient.get(`/shopping-lists/${encodeURIComponent(listId)}`);
    // 入库完成后展示“当前 active 清单”；没有 active 清单时不得保持可能与本次入库无关的旧清单，
    // 也绝不为此创建新清单（原清单最新 DTO 已成功回拉应用时按事实保留该清单）
    const refreshActiveList = async (targetListId) => {
      const active = await ApiClient.get('/shopping-lists?status=ACTIVE');
      if (Array.isArray(active) && active.length) {
        applyList(active[0]);
        return true;
      }
      if (list && list.id === targetListId) return true;
      list = null;
      service.data = [];
      emit('shopping:changed');
      return true;
    };
    /**
     * 执行一次幂等入库。resume 非空时严格重放原 listId/version/operationId/itemIds；
     * 否则按传入的固定 ID 集合生成新 operation（排序后提交，保证同集合稳定）。
     */
    const checkinWith = (targetListId, selectedIds, resume) => {
      if (checkinPromise) return checkinPromise;
      const operationId = resume
        ? resume.operationId
        : crypto.randomUUID
          ? crypto.randomUUID()
          : `checkin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const payload = {
        version: resume ? resume.version : list.version,
        operationId,
        itemIds: resume ? [...resume.itemIds] : [...selectedIds].sort()
      };
      if (!writePending({ listId: targetListId, ...payload })) {
        toast('无法保存入库待处理操作，未执行入库', 'error');
        return Promise.resolve(false);
      }
      checkinPromise = (async () => {
        try {
          await ApiClient.post(`/shopping-lists/${encodeURIComponent(targetListId)}/check-in`, payload);
          let complete = true;
          // 幂等命中时服务端返回的是历史缓存 DTO，必须再取一次最新清单，避免旧版本覆盖之后的改动
          try {
            const latest = await fetchListById(targetListId);
            if (list && list.id === targetListId) applyList(latest);
          } catch {
            complete = false;
          }
          try {
            await refreshActiveList(targetListId);
          } catch {
            complete = false;
          }
          const refreshes = await Promise.allSettled([
            window.BentoService?.pantry?.reload?.(),
            window.BentoService?.dashboard?.reload?.()
          ]);
          if (refreshes.some((result) => result.status === 'rejected')) complete = false;
          if (complete) {
            // 只有本轮全部必要刷新都成功后才清除未决记录；
            // 否则保留原 operation，下一次点击仍按原 URL + 原 payload 幂等重放
            try {
              localStorage.removeItem(pendingKey);
            } catch {
              complete = false;
            }
          }
          // 入库已经真实成功：任何刷新/清理失败绝不误报为入库失败，也不自动新建 operation（pending 可幂等重放）
          if (complete) toast(`已将 ${payload.itemIds.length} 件采购食材入库冰箱`, 'success');
          else toast('已入库，刷新未完成', 'warning');
          return true;
        } catch (error) {
          if (error?.status >= 400 && error?.status < 500) {
            try {
              localStorage.removeItem(pendingKey);
            } catch {
              /* best effort */
            }
          }
          throw error;
        } finally {
          checkinPromise = null;
        }
      })();
      return checkinPromise;
    };
    /**
     * 校验补量弹窗回传的数据（HTML 也会校验，适配器这里不依赖上层）：
     * 每个缺量项必须且只能有一条合法更新，数量为有限正数，单位能映射到后端单位。
     */
    const normalizePromptUpdates = (updates, expectedIds) => {
      if (!Array.isArray(updates)) throw new ApiError(422, 'SHOPPING_CHECKIN_QUANTITY_INVALID', '补填数据格式无效');
      const byId = new Map();
      for (const update of updates) {
        const id = typeof update?.id === 'string' ? update.id.trim() : '';
        if (!id) throw new ApiError(422, 'SHOPPING_CHECKIN_QUANTITY_INVALID', '补填数据缺少条目 ID');
        const quantity = Number(update?.quantity);
        // 只接受 11 种真实标准单位：OTHER 等伪映射在这里直接 fail-closed
        const unit = toStandardShoppingUnit(update?.unit);
        if (!Number.isFinite(quantity) || quantity <= 0)
          throw new ApiError(422, 'SHOPPING_CHECKIN_QUANTITY_INVALID', '补填数量必须是大于 0 的数字');
        if (!unit) throw new ApiError(422, 'SHOPPING_CHECKIN_QUANTITY_INVALID', '补填单位不是受支持的单位');
        if (byId.has(id)) throw new ApiError(422, 'SHOPPING_CHECKIN_QUANTITY_INVALID', '同一条目不能重复补填');
        byId.set(id, { id, quantity, unit });
      }
      if (byId.size !== expectedIds.length)
        throw new ApiError(422, 'SHOPPING_CHECKIN_QUANTITY_INVALID', '存在未补填的缺量条目');
      return expectedIds.map((id) => {
        const next = byId.get(id);
        if (!next) throw new ApiError(422, 'SHOPPING_CHECKIN_QUANTITY_INVALID', '存在未补填的缺量条目');
        return next;
      });
    };
    service.importCheckedToPantry = async () => {
      if (checkinPromise) return checkinPromise;
      const pending = readPending();
      if (pending.status === 'invalid') {
        // fail-closed：本地有无法解析/无法读取的未决入库记录时，既不能重放也不能用新勾选覆盖
        toast(
          '检测到无法解析的入库待处理记录，已阻止本次入库以避免重复或遗漏；该记录已保留，请先排查后再重试',
          'error'
        );
        return false;
      }
      const resume = pending.status === 'ok' ? pending.value : null;
      if (!resume && !list) {
        toast('购物清单尚未加载完成，未执行入库', 'error');
        return false;
      }
      // pending 优先：即使当前清单不同、当前已无勾选、清单 version 已更新，也重放原 listId + 原 payload，
      // 绝不被新勾选或新弹窗改变。
      if (resume) return checkinWith(resume.listId, resume.itemIds, resume);
      const checked = service.data.filter((x) => x.isChecked);
      if (!checked.length) {
        toast('请先勾选已采购的物品再入库', 'error');
        return false;
      }
      // 本次点击的固定快照：后续补填/勾选变化都不改变要处理的 ID 集合
      const snapshotIds = checked.map((x) => x.id);
      const structuredIds = checked.filter((x) => x.hasStructuredQuantity).map((x) => x.id);
      const missing = checked.filter((x) => !x.hasStructuredQuantity);
      // 全部具备结构化数量单位：直接走既有幂等入库流程
      if (!missing.length) return checkinWith(list.id, snapshotIds, null);
      const openPrompt = window.openShoppingCheckinPrompt;
      if (typeof openPrompt !== 'function') {
        // 无补量弹窗 → fail-closed：不编造默认量、不直接 check-in（后端必 422）
        toast('补量入库弹窗不可用，已阻止本次入库；请先为缺量项补填数量与单位', 'error');
        return false;
      }
      const promptListId = list.id;
      const missingIds = missing.map((x) => x.id);
      /**
       * 弹窗回调执行前的统一闸门（AC2 硬性 pending 保护）：
       * - 有进行中的 check-in：复用同一 promise，绝不并发写入；
       * - pending 合法：严格按原 listId + 原 payload + 原 operationId 重放，绝不 PUT 补量、绝不覆盖 operation；
       * - pending 损坏/不可读：fail-closed，零写入且原记录原样保留；
       * - 无 pending 但当前清单已不是打开弹窗时那张：fail-closed，绝不把旧 snapshotIds 发向新清单。
       */
      const resolvePromptAttempt = () => {
        if (checkinPromise) return { status: 'busy', promise: checkinPromise };
        const pending = readPending();
        if (pending.status === 'invalid') return { status: 'invalid' };
        if (pending.status === 'ok') return { status: 'replay', promise: checkinWith(pending.value.listId, pending.value.itemIds, pending.value) };
        if (!list || list.id !== promptListId) return { status: 'list-changed' };
        return { status: 'fresh' };
      };
      const blockedByPromptGate = (attempt) => {
        if (attempt.status === 'invalid') {
          toast(
            '检测到无法解析的入库待处理记录，已阻止本次入库以避免重复或遗漏；该记录已保留，请先排查后再重试',
            'error'
          );
          return true;
        }
        if (attempt.status === 'list-changed') {
          toast('当前购物清单已切换，本次补量未提交；请重新选择条目后重试', 'error');
          return true;
        }
        return false;
      };
      try {
        const opened = await openPrompt({
          items: missing.map((x) => ({
            id: x.id,
            name: x.name,
            amount: x.amount,
            amountText: x.amountText,
            source: x.source
          })),
          hasStructuredItems: structuredIds.length > 0,
          onSubmit: async (updates) => {
            // 每次执行前先过闸：进行中/pending/清单切换优先于本次表单内容，
            // 合法 pending 必须严格重放原操作，不能被新输入覆盖。
            const attempt = resolvePromptAttempt();
            if (blockedByPromptGate(attempt)) return false;
            if (attempt.status !== 'fresh') return attempt.promise;
            const normalized = normalizePromptUpdates(updates, missingIds);
            // 按最新 version 依次回写结构化数量单位：不传 ingredientId（保留后端关系），
            // 不传 amountText（后端据此清空过期自由规格）。
            for (const update of normalized) {
              await service.updateItem(update.id, { quantity: update.quantity, unit: update.unit });
            }
            // 回写期间可能已产生未决入库/并发点击：再次过闸，绝不新建覆盖原 operation
            const after = resolvePromptAttempt();
            if (blockedByPromptGate(after)) return false;
            if (after.status !== 'fresh') return after.promise;
            return checkinWith(promptListId, snapshotIds, null);
          },
          onStructuredOnly: async () => {
            if (!structuredIds.length) return false;
            const attempt = resolvePromptAttempt();
            if (blockedByPromptGate(attempt)) return false;
            if (attempt.status !== 'fresh') return attempt.promise;
            return checkinWith(promptListId, structuredIds, null);
          }
        });
        // HTML 明确表示弹窗无法展示（缺 DOM/被拦截）时 fail-closed，绝不当成已打开
        if (opened === false) {
          toast('补量入库弹窗不可用，已阻止本次入库；请先为缺量项补填数量与单位', 'error');
          return false;
        }
      } catch (error) {
        // 弹窗渲染/校验异常：明确提示并保持零写入（pending 尚未创建，可重试）
        toast(error instanceof Error ? error.message : '补量入库弹窗打开失败，未执行入库', 'error');
        return false;
      }
      // 弹窗已打开：真实提交由 onSubmit / onStructuredOnly 异步完成，这里不得提前写 check-in pending
      return undefined;
    };
    return reload;
  }
  function replacePlanService(service) {
    let listSeq = 0;
    const reload = async () => {
      const seq = ++listSeq;
      const values = await ApiClient.get('/plans');
      if (seq !== listSeq) return service.data;
      service.data = (Array.isArray(values) ? values : []).map(mapPlan);
      emit('plans:changed');
      return service.data;
    };
    const planItemsFromTarget = (target) => {
      if (target?.targetType === 'recipe' && target.targetId)
        return [{ itemType: 'RECIPE', recipeId: target.targetId, sortOrder: 0 }];
      if (target?.targetType === 'store' && target.targetId)
        return [{ itemType: 'STORE', storeId: target.targetId, sortOrder: 0 }];
      throw new ApiError(422, 'PLAN_TARGET_UNSUPPORTED', '排餐目标无法映射到后端计划项目，无法保存');
    };
    const planBodyFromUi = (plan) => ({
      planDate: plan.date,
      mealType: (() => {
        const mealType = toBackendMealType(plan.slot);
        if (!mealType) throw new ApiError(422, 'PLAN_MEAL_TYPE_UNSUPPORTED', '餐次无法映射到后端枚举，无法保存');
        return mealType;
      })(),
      time: plan.time ?? null,
      title: plan.title ?? null,
      subtext: plan.subtext ?? null,
      icon: plan.icon ?? null,
      dinerCount: 1,
      items: planItemsFromTarget(plan)
    });
    service.getAll = () => service.data;
    service.getById = (id) => service.data.find((x) => x.id === id);
    service.reload = reload;
    service.add = async (plan) => {
      const body = planBodyFromUi(plan);
      const mapped = mapPlan(await ApiClient.post('/plans', body));
      service.data = [mapped, ...service.data];
      emit('plans:changed');
      toast(`已成功将排餐安排进【${mapped.slot}】！`, 'success');
      return true;
    };
    service.update = async (id, updates) => {
      const existing = service.getById(id);
      if (!existing) return false;
      const body = { version: existing.version, ...planBodyFromUi({ ...existing, ...updates }) };
      const mapped = mapPlan(await ApiClient.put(`/plans/${encodeURIComponent(id)}`, body));
      service.data = service.data.map((x) => (x.id === mapped.id ? mapped : x));
      emit('plans:changed');
      toast('排餐计划已成功更新！', 'success');
      return true;
    };
    service.delete = async (id) => {
      const item = service.getById(id);
      if (!item) return;
      await ApiClient.delete(`/plans/${encodeURIComponent(id)}?version=${encodeURIComponent(item.version)}`);
      service.data = service.data.filter((x) => x.id !== id);
      emit('plans:changed');
      toast('计划已安全移除', 'success');
    };
    service.remove = service.delete;
    service.checkin = async (id) => {
      const item = service.getById(id);
      if (!item || item.isCompleted) return;
      const result = await ApiClient.post(`/plans/${encodeURIComponent(id)}/complete`, { version: item.version });
      const mapped = mapPlan(result.plan);
      service.data = service.data.map((x) => (x.id === mapped.id ? mapped : x));
      const records = window.BentoService?.records;
      if (records && result.record) {
        const mappedRecord = mapRecord(result.record);
        records.data = records.data.some((x) => x.id === mappedRecord.id)
          ? records.data.map((x) => (x.id === mappedRecord.id ? mappedRecord : x))
          : [mappedRecord, ...records.data];
        emit('records:changed');
      }
      emit('plans:changed');
      toast(result.idempotent ? '打卡成功！已在日记中恢复就餐记录' : '打卡成功！已在日记中生成就餐记录', 'success');
      return mapped;
    };
    const uncheckinPromises = new Map();
    service.uncheckin = (id) => {
      if (uncheckinPromises.has(id)) return uncheckinPromises.get(id);
      const item = service.getById(id);
      if (!item) return false;
      const promise = (async () => {
        const result = await ApiClient.post(`/plans/${encodeURIComponent(id)}/uncomplete`, { version: item.version });
        const mapped = mapPlan(result.plan);
        service.data = service.data.map((x) => (x.id === mapped.id ? mapped : x));
        const records = window.BentoService?.records;
        if (records && result.removedRecord?.id) {
          records.data = records.data.filter((x) => x.id !== result.removedRecord.id);
          emit('records:changed');
        }
        emit('plans:changed');
        toast(result.idempotent ? '计划已是未打卡状态' : '已取消打卡', 'success');
        return mapped;
      })();
      uncheckinPromises.set(id, promise);
      // Inline legacy onclick handlers do not await this promise. Attach the
      // same user-visible failure path here while preserving rejection for
      // callers that do await it.
      promise.catch(fail);
      promise.finally(() => uncheckinPromises.delete(id)).catch(() => undefined);
      return promise;
    };
    service.toggleCheckin = async (id) => {
      const item = service.getById(id);
      if (!item) return;
      if (item.isCompleted) return service.uncheckin(id);
      return service.checkin(id);
    };
    return reload;
  }
  const recordPhotoSlots = [null, null, null];
  const recordPhotoGenerations = [0, 0, 0];
  const recordPhotoUploadCache = [null, null, null];
  function dataUrlToJpegFile(dataUrl, slot) {
    const match = /^data:([^;,]+);base64,(.*)$/.exec(String(dataUrl || ''));
    if (!match || match[1].toLowerCase() !== 'image/jpeg') return null;
    const binary = atob(match[2]);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new File([bytes], `record-${slot + 1}.jpg`, { type: 'image/jpeg' });
  }
  async function uploadRecordPhoto(file, slot, generation) {
    if (!(file instanceof Blob) || file.type !== 'image/jpeg')
      throw new ApiError(422, 'RECORD_PHOTO_INVALID', '照片必须是 JPEG');
    const cached = recordPhotoUploadCache[slot];
    if (cached && cached.generation === generation && cached.file === file) return cached.url;
    const form = new FormData();
    form.append('file', file, `record-${slot + 1}.jpg`);
    const asset = await ApiClient.request('/uploads/images', { method: 'POST', body: form });
    if (recordPhotoGenerations[slot] !== generation) throw new ApiError(409, 'RECORD_PHOTO_CHANGED', '照片已被替换');
    recordPhotoUploadCache[slot] = { generation, file, url: asset.url };
    return asset.url;
  }
  async function resolveRecordPhotos(photos) {
    const entries = (Array.isArray(photos) ? photos : [])
      .slice(0, 3)
      .map((entry, index) => (typeof entry === 'object' ? entry : { value: entry, slot: index }))
      .filter(({ value }) => Boolean(value));
    const result = [];
    for (const { value, slot } of entries) {
      if (typeof value === 'string' && value.startsWith('/uploads/')) {
        result.push(value);
        continue;
      }
      const generation = recordPhotoGenerations[slot];
      const file = value instanceof Blob ? value : recordPhotoSlots[slot] || dataUrlToJpegFile(value, slot);
      if (!file) throw new ApiError(422, 'RECORD_PHOTO_INVALID', '照片必须是 JPEG');
      const uploaded = await uploadRecordPhoto(file, slot, generation);
      result.push(uploaded);
    }
    return result;
  }
  async function compressRecordPhoto(file, slot) {
    if (!(file instanceof Blob)) return null;
    if (typeof window.compressImage === 'function') {
      const result = await window.compressImage(file);
      if (typeof result === 'string') return dataUrlToJpegFile(result, slot);
      if (result instanceof Blob) {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error('photo read failed'));
          reader.readAsDataURL(result);
        });
        return dataUrlToJpegFile(data, slot);
      }
    }
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('photo read failed'));
      reader.readAsDataURL(file);
    });
    if (String(data).startsWith('data:image/jpeg')) return dataUrlToJpegFile(data, slot);
    if (typeof Image === 'undefined' || typeof document?.createElement !== 'function') return null;
    const image = await new Promise((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = reject;
      node.src = data;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return dataUrlToJpegFile(canvas.toDataURL('image/jpeg', 0.86), slot);
  }
  function resetRecordPhotoState(photos = []) {
    for (let slot = 0; slot < 3; slot += 1) {
      recordPhotoGenerations[slot] += 1;
      recordPhotoSlots[slot] = null;
      recordPhotoUploadCache[slot] = null;
      const value = photos[slot];
      if (typeof value === 'string' && value.startsWith('/uploads/')) recordPhotoSlots[slot] = value;
    }
  }
  function installRecordPhotoCapture() {
    if (window.__google2RecordPhotoCapture) return;
    const original = window.onRecordFileSelected;
    const originalTrigger = window.triggerRecordPhoto;
    if (typeof original !== 'function') return;
    if (typeof originalTrigger === 'function') {
      window.triggerRecordPhoto = (slot) => {
        window.__google2CurrentUploadSlot = slot;
        return originalTrigger(slot);
      };
    }
    window.onRecordFileSelected = async (event) => {
      const slot = Number(window.__google2CurrentUploadSlot ?? 0);
      const file = event?.target?.files?.[0];
      if (!file) return false;
      if (event.target) event.target.value = '';
      recordPhotoGenerations[slot] += 1;
      const generation = recordPhotoGenerations[slot];
      try {
        const compressed = await compressRecordPhoto(file, slot);
        if (!compressed) throw new ApiError(422, 'RECORD_PHOTO_INVALID', '照片必须是 JPEG');
        const preview = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error('photo read failed'));
          reader.readAsDataURL(compressed);
        });
        if (recordPhotoGenerations[slot] !== generation) return false;
        recordPhotoSlots[slot] = compressed;
        recordPhotoUploadCache[slot] = null;
        const view = document.getElementById(`photoSlotView-${slot}`);
        if (view) {
          const image = document.createElement('img');
          image.src = preview;
          image.className = 'w-full h-full object-cover rounded-xl';
          view.replaceChildren(image);
          view.parentElement?.querySelector('button')?.classList.remove('hidden');
        }
        return true;
      } catch (error) {
        if (recordPhotoGenerations[slot] === generation) fail(error);
        return false;
      }
    };
    const originalRemove = window.removeRecordPhoto;
    if (typeof originalRemove === 'function') {
      window.removeRecordPhoto = async (event, slot) => {
        const before = recordPhotoSlots[slot];
        const result = await originalRemove(event, slot);
        if (
          recordPhotoSlots[slot] === before &&
          document.getElementById(`photoSlotView-${slot}`)?.querySelector('img') == null
        ) {
          recordPhotoGenerations[slot] += 1;
          recordPhotoSlots[slot] = null;
          recordPhotoUploadCache[slot] = null;
        }
        return result;
      };
    }
    window.__google2RecordPhotoCapture = true;
  }
  const recordMealType = (slot) => {
    const mealType = toBackendMealType(slot);
    if (!mealType) throw new ApiError(422, 'RECORD_MEAL_TYPE_UNSUPPORTED', '餐次无法映射到后端枚举，无法保存');
    return mealType;
  };
  const recordSourceType = (type) => {
    const sourceType =
      SOURCE_TYPE_TO_BACKEND[type] || (Object.values(SOURCE_TYPE_TO_BACKEND).includes(type) ? type : null);
    if (!sourceType) throw new ApiError(422, 'RECORD_SOURCE_TYPE_UNSUPPORTED', '就餐类型无法映射到后端枚举，无法保存');
    return sourceType;
  };
  function replaceRecordService(service) {
    let listSeq = 0;
    const reload = async () => {
      const seq = ++listSeq;
      const values = await loadAll('/records', seq, () => listSeq);
      if (!values) return service.data;
      service.data = values.map(mapRecord);
      emit('records:changed');
      return service.data;
    };
    service.getAll = () => service.data;
    service.getById = (id) => service.data.find((x) => x.id === id);
    service.reload = reload;
    service.add = async (rec) => {
      const title = String(rec?.title ?? '').trim();
      if (!title) throw new ApiError(422, 'RECORD_TITLE_REQUIRED', '饮食记录标题不能为空');
      const body = {
        recordDate: rec.date || localDateKey(0),
        mealType: recordMealType(rec.slot),
        sourceType: recordSourceType(rec.type),
        rating: typeof rec.rating === 'number' ? rec.rating : null,
        // 营养字段：真实 number 原样送，空/null 显式 null；非法值快速失败，不污染成 550/0/8
        calories: parseRecordCaloriesInput(rec.calories),
        cost: parseRecordCostInput(rec.cost),
        satiety: parseRecordSatietyInput(rec.satiety),
        notes: rec.notes || null,
        title,
        imagePath: (rec.photos || [])[0] || null,
        ...(Array.isArray(rec.photos) ? { photos: rec.photos.slice(0, 3) } : {}),
        items: [{ itemType: 'CUSTOM', customName: title, sortOrder: 0 }]
      };
      const mapped = mapRecord(await ApiClient.post('/records', body));
      service.data = [mapped, ...service.data];
      emit('records:changed');
      toast('饮食日记已成功入账并同步至统计看板！', 'success');
      return mapped;
    };
    service.update = async (id, updates) => {
      const existing = service.getById(id);
      if (!existing) return;
      if (updates.title !== undefined && !String(updates.title ?? '').trim())
        throw new ApiError(422, 'RECORD_TITLE_REQUIRED', '饮食记录标题不能为空');
      const body = { version: existing.version };
      if (updates.slot) body.mealType = recordMealType(updates.slot);
      if (updates.type) body.sourceType = recordSourceType(updates.type);
      if (updates.title !== undefined) body.title = String(updates.title).trim();
      if (updates.rating !== undefined) body.rating = typeof updates.rating === 'number' ? updates.rating : null;
      if (updates.notes !== undefined) body.notes = updates.notes || null;
      if (updates.photos !== undefined) {
        body.photos = Array.isArray(updates.photos) ? updates.photos.slice(0, 3) : [];
        body.imagePath = body.photos[0] || null;
      }
      // 省略字段 → 不发送（后端保留现有值）；显式 null/'' → 发送 null（真实清空）；非法值快速失败
      if (updates.calories !== undefined) body.calories = parseRecordCaloriesInput(updates.calories);
      if (updates.cost !== undefined) body.cost = parseRecordCostInput(updates.cost);
      if (updates.satiety !== undefined) body.satiety = parseRecordSatietyInput(updates.satiety);
      if (updates.date !== undefined) {
        const date = String(updates.date ?? '').trim();
        if (!parseBusinessDate(date)) throw new ApiError(422, 'RECORD_DATE_INVALID', '饮食记录日期无效');
        body.recordDate = date;
      }
      const mapped = mapRecord(await ApiClient.put(`/records/${encodeURIComponent(id)}`, body));
      service.data = service.data.map((x) => (x.id === mapped.id ? mapped : x));
      emit('records:changed');
      toast('饮食日记已更新并同步重算！', 'success');
      return mapped;
    };
    service.delete = async (id) => {
      const item = service.getById(id);
      if (!item) return;
      await ApiClient.delete(`/records/${encodeURIComponent(id)}?version=${encodeURIComponent(item.version)}`);
      service.data = service.data.filter((x) => x.id !== id);
      emit('records:changed');
      toast('该餐记录已删除，月度看板已重算', 'success');
    };
    service.remove = service.delete;
    service.buildFromPlan = () => toast();
    return reload;
  }
  function replaceToolService(service) {
    let listSeq = 0;
    const reload = async () => {
      const seq = ++listSeq;
      const values = await ApiClient.get('/tools');
      if (seq !== listSeq) return service.data;
      service.data = (Array.isArray(values) ? values : []).map(mapTool);
      emit('tools:changed');
      return service.data;
    };
    const toolBody = (tool) => ({
      name: tool.name,
      icon: tool.icon ?? null,
      category: tool.category || null,
      status: tool.status || null,
      notes: tool.notes || null
    });
    service.getAll = () => service.data;
    service.getById = (id) => service.data.find((x) => x.id === id);
    service.reload = reload;
    service.save = async (tool) => {
      const existing = tool.id ? service.getById(tool.id) : null;
      const dto = existing
        ? await ApiClient.put(`/tools/${encodeURIComponent(tool.id)}`, { ...toolBody(tool), version: existing.version })
        : await ApiClient.post('/tools', toolBody(tool));
      const mapped = mapTool(dto);
      service.data = service.data.some((x) => x.id === mapped.id)
        ? service.data.map((x) => (x.id === mapped.id ? mapped : x))
        : [mapped, ...service.data];
      emit('tools:changed');
      toast(existing ? '设备已更新' : `设备「${mapped.name}」已成功收录！`, 'success');
      return mapped;
    };
    service.delete = async (id) => {
      const item = service.getById(id);
      if (!item) return;
      await ApiClient.delete(`/tools/${encodeURIComponent(id)}?version=${encodeURIComponent(item.version)}`);
      service.data = service.data.filter((x) => x.id !== id);
      emit('tools:changed');
    };
    return reload;
  }
  function sanitizeStaticBusinessState() {
    [
      'currentDate',
      'tip',
      'branding',
      'greetingTitle',
      'todayRecordsCount',
      'inventory-totalIngredients',
      'inventory-expiringSoon',
      'inventory-insufficient',
      'weeklyStat-recordedDays',
      'weeklyStat-totalMeals',
      'weeklyStat-averageRating',
      'weeklyStat-consumedIngredientCount',
      'streakDays'
    ].forEach((binding) => setBinding(binding, ''));
    document.querySelectorAll('[data-binding="recommendedRecipes"] > div').forEach((card) => {
      card.hidden = true;
      card.onclick = null;
      card.querySelectorAll('[data-business-value]').forEach((node) => {
        node.textContent = '';
      });
    });
    document.querySelectorAll('[data-binding="todayRecords"] [data-binding^="todayRecord-"]').forEach((slot) => {
      slot.hidden = true;
      slot.querySelectorAll('[data-business-value]').forEach((node) => {
        node.textContent = '';
      });
    });
    document
      .querySelectorAll(
        '[data-binding="calendarDays"] [data-binding^="calendarDay-"], .mobile-week-calendar-list [data-binding^="mobileCalendarDay-"]'
      )
      .forEach((day) => {
        day.hidden = true;
        day.onclick = null;
        delete day.dataset.date;
        delete day.dataset.status;
        day.querySelectorAll('[data-business-value]').forEach((node) => {
          node.textContent = '';
        });
      });
    document.querySelectorAll('[data-binding^="expiringIngredient-"]').forEach((row) => {
      row.hidden = true;
      row.onclick = null;
      delete row.dataset.ingredientId;
      row.querySelectorAll('[data-business-value]').forEach((node) => {
        node.textContent = '';
      });
    });
  }
  const MONTH_DAY_LIMITS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  // 业务日期 YYYY-MM-DD 只做字面量与日历合法性校验：不走 Date 的 UTC 解析，避免时区漂移
  const parseBusinessDate = (value) => {
    const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12) return null;
    const maxDay = month === 2 && isLeapYear(year) ? 29 : MONTH_DAY_LIMITS[month - 1];
    if (day < 1 || day > maxDay) return null;
    return { year, month, day };
  };
  function mapDashboard(dto) {
    const data = dto || {};
    sanitizeStaticBusinessState();
    setBinding('branding', data.branding?.appName || '');
    setBinding('currentDate', data.currentDate || '');
    setBinding('tip', data.greetingText || data.tip || '');
    setBinding('greetingTitle', data.greetingTitle || '');
    document.querySelectorAll('[data-binding="recommendedRecipes"] > div').forEach((card, i) => {
      const value = (data.recommendedRecipes || [])[i];
      card.hidden = !value;
      if (value) {
        card.onclick = () => window.BentoModal?.open('recipeDetail', value.id);
        const nameNode = card.querySelector('[data-business-value="name"]');
        const tagsNode = card.querySelector('[data-business-value="tags"]');
        const timeNode = card.querySelector('[data-business-value="time"]');
        const ratingNode = card.querySelector('[data-business-value="rating"]');
        if (nameNode) nameNode.textContent = value.name || '';
        if (tagsNode) tagsNode.textContent = (value.tags || []).join('、');
        if (timeNode)
          timeNode.textContent = value.cookingTimeMinutes == null ? '' : `⏱ ${value.cookingTimeMinutes}分钟`;
        if (ratingNode) ratingNode.textContent = value.rating == null ? '' : `★ ${value.rating}`;
      }
    });
    const records = data.todayRecords || [];
    document.querySelectorAll('[data-binding="todayRecords"] [data-binding^="todayRecord-"]').forEach((slot, i) => {
      const value = records[i];
      slot.hidden = !value;
      if (value) {
        setText('[data-business-value="title"]', value.title || value.summary || '', slot);
        setText('[data-business-value="status"]', value.recorded ? '已完成' : '未记录', slot);
      }
    });
    setBinding('todayRecordsCount', `${records.filter((x) => x.recorded).length}/${records.length || 3} 餐`);
    const inventory = data.inventory || {};
    setBinding('inventory-totalIngredients', inventory.totalIngredients ?? '');
    setBinding('inventory-expiringSoon', inventory.expiringSoon ?? '');
    setBinding('inventory-insufficient', inventory.insufficient ?? '');
    const stats = data.weeklyStats || {};
    setBinding('weeklyStat-recordedDays', stats.recordedDays == null ? '' : `${stats.recordedDays}/7 天`);
    setBinding('weeklyStat-totalMeals', stats.totalMeals ?? '');
    setBinding('weeklyStat-averageRating', stats.averageRating == null ? '' : stats.averageRating);
    setBinding(
      'weeklyStat-consumedIngredientCount',
      stats.consumedIngredientCount == null ? '' : stats.consumedIngredientCount
    );
    setBinding('streakDays', stats.streakDays == null ? '' : stats.streakDays);
    const days = data.calendarDays || [];
    const todayRecorded = (data.todayRecords || []).filter((x) => x.recorded).length;
    const fillWeekRow = (row, value) => {
      const setValue = (slot, text) => {
        const node = row.querySelector(`[data-business-value="${slot}"]`);
        if (node) node.textContent = text;
      };
      row.hidden = !value;
      if (!value) {
        row.onclick = null;
        delete row.dataset.date;
        delete row.dataset.status;
        return;
      }
      const weekdayText = value.isToday ? '今天' : `周${value.weekday || ''}`;
      const monthDay = /-(\d{2})-(\d{2})$/.exec(value.date || '');
      const dateBadge = monthDay ? `${weekdayText} ${Number(monthDay[1])}/${Number(monthDay[2])}` : weekdayText;
      let statusText;
      let statusPill;
      if (value.isToday) {
        statusText = todayRecorded > 0 ? `${todayRecorded}餐已记录` : '今天还没有记录';
        statusPill = todayRecorded > 0 ? `${todayRecorded}餐 ✓` : '去打卡 +';
      } else if (value.status === 'recorded') {
        statusText = '已记录';
        statusPill = '已记录 ✓';
      } else if (value.status === 'planned') {
        statusText = '已排餐';
        statusPill = '已排餐';
      } else {
        statusText = '';
        statusPill = '未记录';
      }
      setValue('weekday', weekdayText);
      setValue('dayOfMonth', value.dayOfMonth == null ? '' : String(value.dayOfMonth));
      setValue('label', statusText);
      setValue('dateBadge', dateBadge);
      setValue('statusText', statusText);
      setValue('statusPill', statusPill);
      row.dataset.date = value.date || '';
      row.dataset.status = value.status || '';
      // BentoModal.setupDailyDiary 解构 { year, month, day }：业务日期先按日历校验，再解构成数字传入；
      // 非法/缺失日期 fail-closed 不绑定入口，绝不把字符串日期或 undefined 传进 Modal
      const diaryDate = parseBusinessDate(value.date);
      row.onclick = diaryDate
        ? () =>
            window.BentoModal?.open('dailyDiary', {
              year: diaryDate.year,
              month: diaryDate.month,
              day: diaryDate.day
            })
        : null;
    };
    // 桌面网格与移动列表是两套并行视图：各自独立按 days[i] 索引，不能合并成一个循环
    document
      .querySelectorAll('[data-binding="calendarDays"] [data-binding^="calendarDay-"]')
      .forEach((row, i) => fillWeekRow(row, days[i]));
    document
      .querySelectorAll('.mobile-week-calendar-list [data-binding^="mobileCalendarDay-"]')
      .forEach((row, i) => fillWeekRow(row, days[i]));
    const expiring = inventory.expiringIngredients || [];
    document.querySelectorAll('[data-binding^="expiringIngredient-"]').forEach((row, i) => {
      const value = expiring[i];
      row.hidden = !value;
      if (value) {
        setText('[data-business-value="name"]', value.name || '', row);
        setText(
          '[data-business-value="expiry"]',
          (() => {
            const days = value.expireDaysLeft ?? daysUntil(value.expiryDate);
            return days == null ? '' : `${days}天后到期`;
          })(),
          row
        );
        row.dataset.ingredientId = value.id || '';
        row.onclick = () => window.BentoModal?.open('ingredientDetail', value.id);
      }
    });
    return data;
  }
  async function loadDashboard() {
    try {
      return mapDashboard(await ApiClient.get('/dashboard'));
    } catch (error) {
      sanitizeStaticBusinessState();
      throw error;
    }
  }
  /**
   * 首页聚合刷新：只复用既有 loadDashboard()，在「返回首页」或「首页可见期间相关业务写成功」时触发。
   * 事件源限定为 adapter 写入方法成功后的 dashboard:dirty，避免列表 reload 造成无谓刷新。
   * 事件源限定为「adapter 真实写成功后」发出的 dashboard:dirty，列表 reload 等读取路径不触发，避免无谓刷新。
   * 不轮询、不引入 WebSocket 或状态管理；同一时刻只允许一次刷新在途，期间的后续请求合并为一次收尾刷新。
   */
  const DASHBOARD_DIRTY_EVENT = 'dashboard:dirty';
  const DASHBOARD_WRITE_METHODS = {
    stores: ['save', 'delete', 'toggleFavorite'],
    recipes: ['save', 'delete', 'toggleFavorite', 'addMissingIngredientsToShopping'],
    pantry: ['save', 'delete', 'consume'],
    shopping: ['add', 'toggle', 'delete', 'clearCompleted', 'updateItem', 'replenishRecipe'],
    plans: ['save', 'delete', 'remove', 'checkin', 'uncheckin'],
    records: ['save', 'delete', 'remove'],
    tools: ['save', 'delete']
  };
  function markDashboardDirty() {
    emit(DASHBOARD_DIRTY_EVENT);
  }
  function wrapDashboardWriteMethods(service) {
    Object.entries(DASHBOARD_WRITE_METHODS).forEach(([key, names]) => {
      const target = service[key];
      if (!target) return;
      names.forEach((name) => {
        const original = target[name];
        if (typeof original !== 'function' || original.__dafanDashboardWrite) return;
        const wrapped = function (...args) {
          const result = original.apply(this, args);
          if (result && typeof result.then === 'function') {
            return result.then((value) => {
              if (value !== false) markDashboardDirty();
              return value;
            });
          }
          if (result !== false) markDashboardDirty();
          return result;
        };
        wrapped.__dafanDashboardWrite = true;
        target[name] = wrapped;
      });
    });
  }
  let dashboardRefreshRunning = null;
  let dashboardRefreshQueued = false;
  function isHomeVisible() {
    if (document.visibilityState && document.visibilityState !== 'visible') return false;
    const panel = document.getElementById('page-home');
    return !!panel && panel.classList.contains('active');
  }
  function refreshDashboard() {
    if (!isHomeVisible()) return Promise.resolve(false);
    if (dashboardRefreshRunning) {
      dashboardRefreshQueued = true;
      return dashboardRefreshRunning;
    }
    const task = loadDashboard()
      .then(() => true)
      .catch((error) => {
        fail(error);
        return false;
      })
      .finally(() => {
        dashboardRefreshRunning = null;
        if (dashboardRefreshQueued) {
          dashboardRefreshQueued = false;
          refreshDashboard();
        }
      });
    dashboardRefreshRunning = task;
    return task;
  }
  function installDashboardRefresh() {
    // 按「当前」总线/入口实例幂等安装：总线与 switchPage 由页面脚本提供，若已被本页安装过则跳过，
    // 重复安装会造成同一事件多次刷新。
    const bus = window.BentoBus;
    if (bus && typeof bus.on === 'function' && !bus.__dafanDashboardRefresh) {
      bus.on(DASHBOARD_DIRTY_EVENT, () => refreshDashboard());
      bus.__dafanDashboardRefresh = true;
    }
    const originalSwitchPage = window.switchPage;
    if (typeof originalSwitchPage === 'function' && !originalSwitchPage.__dafanDashboardRefresh) {
      const wiredSwitchPage = function (pageId, ...args) {
        const result = originalSwitchPage.call(this, pageId, ...args);
        if (pageId === 'home') refreshDashboard();
        return result;
      };
      wiredSwitchPage.__dafanDashboardRefresh = true;
      window.switchPage = wiredSwitchPage;
    }
    // 可见性监听只注册一次，但始终派发到最近一次安装的刷新函数，避免重复监听或旧闭包。
    window.__dafanDashboardRefreshFn = refreshDashboard;
    if (!window.__dafanDashboardVisibilityBound) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') window.__dafanDashboardRefreshFn?.();
      });
      window.__dafanDashboardVisibilityBound = true;
    }
  }
  async function loadSettings() {
    return ApiClient.get('/settings');
  }
  async function exportBackup(button) {
    button.disabled = true;
    try {
      const blob = await ApiClient.requestBlob('/backups/export');
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = 'dafan-backup.zip';
      anchor.click();
      URL.revokeObjectURL(href);
      toast('备份下载已开始', 'success');
    } catch (error) {
      fail(error);
    } finally {
      button.disabled = false;
    }
  }
  function setRestoreState(state) {
    const node = document.getElementById('google2RestoreState');
    if (node) node.textContent = state || '';
  }
  let restoreDialogVersion = 0;
  function closeRestoreDialog() {
    restoreDialogVersion += 1;
    document.getElementById('modalBackupRestore')?.classList.add('hidden');
    const input = document.getElementById('google2RestorePin');
    const confirmation = document.getElementById('google2RestoreConfirmation');
    const file = document.getElementById('google2RestoreFile');
    const submit = document.getElementById('google2RestoreSubmit');
    if (input) input.value = '';
    if (confirmation) confirmation.checked = false;
    if (file) file.value = '';
    if (submit) submit.disabled = false;
    setRestoreState('');
  }
  async function openRestoreDialog(file) {
    const version = ++restoreDialogVersion;
    const name = document.getElementById('google2RestoreFileName');
    const size = document.getElementById('google2RestoreFileSize');
    const pinGroup = document.getElementById('google2RestorePinGroup');
    const confirmGroup = document.getElementById('google2RestoreConfirmGroup');
    const submit = document.getElementById('google2RestoreSubmit');
    if (name) name.textContent = file.name;
    if (size) size.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
    if (pinGroup) pinGroup.classList.add('hidden');
    if (confirmGroup) confirmGroup.classList.add('hidden');
    if (submit) submit.disabled = true;
    document.getElementById('modalBackupRestore')?.classList.remove('hidden');
    setRestoreState('正在读取本地安全设置…');
    try {
      const settings = await loadSettings();
      if (version !== restoreDialogVersion) return;
      const pinEnabled = settings?.pinEnabled === true;
      if (pinGroup) pinGroup.classList.toggle('hidden', !pinEnabled);
      if (confirmGroup) confirmGroup.classList.toggle('hidden', pinEnabled);
      if (submit) submit.disabled = false;
      setRestoreState('');
    } catch (error) {
      if (version !== restoreDialogVersion) return;
      setRestoreState(error?.message || '无法读取本地安全设置，请稍后重试');
    }
  }
  async function authorizeRestore(pinEnabled) {
    if (pinEnabled) {
      const pin = document.getElementById('google2RestorePin')?.value || '';
      if (!/^\d{4,8}$/.test(pin)) throw new ApiError(422, 'PIN_INVALID', '请输入 4～8 位数字 PIN');
      const result = await ApiClient.post('/settings/high-risk/authorize', { action: 'RESTORE', pin });
      if (!result?.token) throw new ApiError(401, 'HIGH_RISK_AUTHORIZATION_INVALID', 'PIN 授权失败');
      return result.token;
    }
    const confirmed = document.getElementById('google2RestoreConfirmation');
    if (!confirmed?.checked) throw new ApiError(422, 'RESTORE_CONFIRMATION_REQUIRED', '请先勾选恢复确认项');
    const challenge = await ApiClient.post('/settings/high-risk/authorize', { action: 'RESTORE' });
    if (!challenge?.challenge) throw new ApiError(401, 'HIGH_RISK_AUTHORIZATION_INVALID', '恢复确认已失效，请重试');
    const result = await ApiClient.post('/settings/high-risk/authorize', {
      action: 'RESTORE',
      challenge: challenge.challenge,
      confirmation: 'RESTORE_LOCAL_DATA'
    });
    if (!result?.token) throw new ApiError(401, 'HIGH_RISK_AUTHORIZATION_INVALID', '恢复授权失败');
    return result.token;
  }
  async function restoreBackupFromDialog() {
    const file = document.getElementById('google2RestoreFile')?.files?.[0];
    if (!file || !file.name.toLowerCase().endsWith('.zip')) {
      setRestoreState('请选择 ZIP 备份文件');
      return;
    }
    const button = document.getElementById('google2RestoreSubmit');
    let restored = false;
    if (button) button.disabled = true;
    try {
      setRestoreState('正在读取设置并申请高风险授权…');
      const settings = await ApiClient.get('/settings');
      const token = await authorizeRestore(settings?.pinEnabled === true);
      const form = new FormData();
      form.append('file', file, file.name);
      setRestoreState('正在隔离校验并恢复，请勿关闭页面…');
      await ApiClient.request('/backups/restore', {
        method: 'POST',
        body: form,
        headers: { 'X-High-Risk-Token': token },
        _skipPinRetry: true
      });
      restored = true;
      localStorage.removeItem(PIN_KEY);
      closeRestoreDialog();
      toast('本地备份已恢复，正在重新加载数据', 'success');
      await syncPinSession();
      await Promise.allSettled([
        loadSettings(),
        window.DafanDashboardAdapter?.refreshDashboard?.(),
        window.BentoService?.stores?.reload?.(),
        window.BentoService?.recipes?.reload?.(),
        window.BentoService?.pantry?.reload?.(),
        window.BentoService?.shopping?.reload?.(),
        window.BentoService?.plans?.reload?.(),
        window.BentoService?.records?.reload?.(),
        window.BentoService?.tools?.reload?.()
      ]);
    } catch (error) {
      if (restored) toast(`备份已恢复，会话尚未同步：${error?.message || '请稍后重新解锁'}`, 'warning');
      else setRestoreState(error?.message || '恢复失败，请检查备份文件');
    } finally {
      if (button) button.disabled = false;
    }
  }
  const SETTINGS_ROW_TITLES = { backup: '数据备份与导出', taboo: '食用者忌口偏好' };
  const TABOO_BLOCKED_MESSAGE = 'Google 2.0 暂无可用的忌口编辑入口';
  const settingsRowButton = (title) => {
    const row = Array.from(document.querySelectorAll('#page-settings h4')).find(
      (node) => node.textContent?.trim() === title
    )?.parentElement?.parentElement;
    return row?.querySelector('button') || null;
  };
  async function wireSettings() {
    await loadSettings();
    // 已知正式 settings 契约只有 GET /settings（DTO 无忌口字段；忌口 text 只存在于 Diner，Settings 无目标 id 可取），
    // 所以只按自身 h4 标题精确定位两行，绝不按整卡文本或按钮文案模糊匹配
    const backupButton = settingsRowButton(SETTINGS_ROW_TITLES.backup);
    if (backupButton && !backupButton.dataset.backupBound) {
      backupButton.dataset.backupBound = 'true';
      backupButton.removeAttribute('onclick');
      backupButton.addEventListener('click', () => exportBackup(backupButton));
    }
    const restoreButton = document.getElementById('google2RestoreButton');
    const restoreInput = document.getElementById('google2RestoreFile');
    if (restoreButton && restoreInput && !restoreButton.dataset.restoreBound) {
      restoreButton.dataset.restoreBound = 'true';
      restoreButton.addEventListener('click', () => restoreInput.click());
      restoreInput.addEventListener('change', () => {
        const file = restoreInput.files?.[0];
        if (file) void openRestoreDialog(file);
      });
    }
    const restoreSubmit = document.getElementById('google2RestoreSubmit');
    if (restoreSubmit && !restoreSubmit.dataset.restoreBound) {
      restoreSubmit.dataset.restoreBound = 'true';
      restoreSubmit.addEventListener('click', () => void restoreBackupFromDialog());
    }
    const restoreCancel = document.getElementById('google2RestoreCancel');
    const restoreClose = document.getElementById('google2RestoreClose');
    [restoreCancel, restoreClose].forEach((button) => {
      if (button && !button.dataset.restoreBound) {
        button.dataset.restoreBound = 'true';
        button.addEventListener('click', closeRestoreDialog);
      }
    });
    const tabooButton = settingsRowButton(SETTINGS_ROW_TITLES.taboo);
    if (tabooButton && !tabooButton.dataset.tabooBound) {
      tabooButton.dataset.tabooBound = 'true';
      tabooButton.removeAttribute('onclick');
      // 无正式忌口编辑能力：保留点击交互形态，但诚实提示未接通，不发任何写请求、不宣称已修改
      tabooButton.addEventListener('click', () => toast(TABOO_BLOCKED_MESSAGE, 'warning'));
    }
  }
  function blockUnconnectedWrites() {
    const service = window.BentoService;
    if (!service) return;
    const methods = {
      pantry: ['save', 'delete'],
      plans: [],
      records: ['buildFromPlan']
    };
    Object.entries(methods).forEach(([key, names]) => {
      const store = service[key];
      if (!store) return;
      store.data = [];
      names.forEach((name) => {
        store[name] = () => toast();
      });
      store.getAll = () => [];
    });
    window.__dafanGoogle2WritesBlocked = true;
  }
  function clearMockState() {
    const service = window.BentoService;
    if (service)
      Object.keys(service).forEach((key) => {
        if (service[key] && Array.isArray(service[key].data)) service[key].data = [];
      });
    window.__dafanGoogle2BootCleared = true;
  }
  const submitGuardPending = new WeakMap();
  function withSubmitGuard(event, task) {
    const form = event?.currentTarget?.tagName === 'FORM' ? event.currentTarget : event?.target?.closest?.('form');
    const key = form || event?.currentTarget || event?.target || document;
    if (submitGuardPending.has(key)) return submitGuardPending.get(key);
    const button = event?.submitter || form?.querySelector?.('button[type="submit"]');
    if (button) {
      button.dataset.submitting = 'true';
      button.disabled = true;
    }
    const pending = Promise.resolve()
      .then(task)
      .finally(() => {
        submitGuardPending.delete(key);
        if (button) {
          button.dataset.submitting = 'false';
          button.disabled = false;
        }
      });
    submitGuardPending.set(key, pending);
    return pending;
  }
  function businessDateParts(year, month, day) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
  }
  function daysInBusinessMonth(year, month) {
    if (month === 2) return isLeapYear(year) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }
  function localDateParts(date = new Date()) {
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  }
  /** 近 7 天 = 今天及前 6 天的连续本地业务日期（不是自然周）。 */
  function lastSevenBusinessDays(date = new Date()) {
    const end = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    start.setDate(start.getDate() - 6);
    return {
      start: businessDateParts(start.getFullYear(), start.getMonth() + 1, start.getDate()),
      end: businessDateParts(end.year, end.month, end.day)
    };
  }
  /** 本月 = 当前自然月的 1 日至最后一日。 */
  function currentBusinessMonth(date = new Date()) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    return {
      start: businessDateParts(year, month, 1),
      end: businessDateParts(year, month, daysInBusinessMonth(year, month))
    };
  }
  /**
   * 原版固定估算口径（项目无个人目标系统，按用户批准的“沿用原版公式”执行）：
   * - 2000 kcal：原版通用每日热量参考基准（不是个人目标）
   * - 24 元/顿：原版“外卖均价36 − 自烹原料均价12”的固定对比差额，只用于预估节约
   */
  const CALORIE_REFERENCE_KCAL = 2000;
  const HOMEMADE_COMPARISON_PER_MEAL = 24;
  function installLegacyDataViews() {
    const originalCalendar = window.renderCalendar;
    let calendarRequest = 0;
    let statisticsRequest = 0;
    const calendarState = {
      year: Number(window.currentCalendarYear) || 2026,
      month: Number(window.currentCalendarMonth) || 9
    };
    const setStat = (id, value, empty = '') => {
      const node = document.getElementById(id);
      if (node) node.textContent = value == null ? empty : String(value);
    };
    const loadMonthRecords = async (year, month) => {
      const last = daysInBusinessMonth(year, month);
      const all = [];
      let page = 1;
      let totalPages = 1;
      do {
        const payload = await ApiClient.get(
          `/records?from=${businessDateParts(year, month, 1)}&to=${businessDateParts(year, month, last)}&status=CONFIRMED&page=${page}&pageSize=100`
        );
        all.push(
          ...pageItems(payload)
            .filter((record) => record?.deletedAt == null)
            .map(mapRecord)
        );
        totalPages = Number(
          payload?.totalPages || (payload?.total && payload?.pageSize ? Math.ceil(payload.total / payload.pageSize) : 1)
        );
        page += 1;
      } while (page <= totalPages);
      return all;
    };
    const renderRealCalendar = async () => {
      const seq = ++calendarRequest;
      const { year, month } = calendarState;
      const label = document.getElementById('calendarCurrentMonthLabel');
      const grid = document.getElementById('calendarDaysGrid');
      if (label) label.textContent = `${year}年 ${month}月`;
      if (!grid) return;
      grid.setAttribute('aria-busy', 'true');
      try {
        const records = await loadMonthRecords(year, month);
        if (seq !== calendarRequest) return;
        const dates = new Set(records.map((record) => record.date).filter(Boolean));
        const today = localDateParts();
        const offset = new Date(year, month - 1, 1).getDay();
        let html = Array.from(
          { length: offset },
          () =>
            '<div class="aspect-square h-auto rounded-xl sm:rounded-2xl bg-transparent border-0 pointer-events-none"></div>'
        ).join('');
        for (let day = 1; day <= daysInBusinessMonth(year, month); day += 1) {
          const date = businessDateParts(year, month, day);
          const isToday = year === today.year && month === today.month && day === today.day;
          const hasRecord = dates.has(date);
          html += `<div class="relative aspect-square h-auto rounded-xl sm:rounded-2xl border p-1 sm:p-1.5 flex items-center justify-center text-center cursor-pointer transition-all ${isToday ? 'bg-[#FFF0ED] border-[#FF6B57] shadow-sm font-black' : hasRecord ? 'bg-white border-[#F0E8DC]' : 'bg-[#FAF7F2] border-transparent text-stone-400'}" onclick="BentoModal.open('dailyDiary', { year: ${year}, month: ${month}, day: ${day} })"><div class="calendar-day-content w-full flex flex-col items-center justify-center text-center leading-none gap-0.5"><span class="${isToday ? 'text-[#FF6B57] font-black' : ''} text-[10px] sm:text-[11px] font-bold leading-none">${day}</span>${hasRecord ? '<div class="text-[8px] sm:text-[9px] font-black text-amber-600 truncate leading-tight mt-0.5">🍱 已打卡</div>' : ''}</div></div>`;
        }
        grid.innerHTML = html;
      } catch (error) {
        if (seq === calendarRequest) {
          grid.innerHTML = '<div class="col-span-7 p-6 text-center text-red-500">日历加载失败，请稍后重试</div>';
          fail(error);
        }
      } finally {
        if (seq === calendarRequest) grid.removeAttribute('aria-busy');
      }
    };
    // Keep the original SVG geometry and palette, with the requested period's real aggregates.
    const renderCalorieChart = (trend, message = '暂无热量数据') => {
      const wrap = document.getElementById('chartCalorieTrendWrap');
      if (!wrap) return;
      // 2000 kcal 是原版固定通用参考基准（不是个人目标，也不写入任何目标系统）；说明文案常驻。
      const reference = wrap.previousElementSibling?.querySelector(':scope > span');
      if (reference) reference.hidden = false;
      const points = Array.isArray(trend) ? trend : [];
      const valid = points.filter((point) => point.calories != null);
      if (
        points.some(
          (point) =>
            !/^\d{4}-\d{2}-\d{2}$/.test(point.date) ||
            (point.calories != null && (!Number.isFinite(point.calories) || point.calories < 0))
        )
      )
        throw new Error('统计热量数据无效');
      if (!valid.length) {
        wrap.innerHTML = `<div class="p-4 text-center text-stone-400">${message}</div>`;
        return;
      }
      const w = 480;
      const h = 150;
      const step = (w - 20) / points.length;
      const barWidth = Math.min(26, step * 0.55);
      // 比例尺必须同时容纳真实柱形与 2000 kcal 参考线，参考线与柱形共用同一 maxCal。
      const maxCal = Math.max(
        Math.max(1, ...valid.map((point) => point.calories)) * 1.15,
        CALORIE_REFERENCE_KCAL * 1.1
      );
      const labelGap = Math.ceil(58 / step);
      const labels = [];
      const addLabel = (index) => {
        if (labels.every((other) => Math.abs(index - other) >= labelGap)) labels.push(index);
      };
      points.forEach((point, index) => {
        if (point.calories != null) addLabel(index);
      });
      addLabel(0);
      addLabel(points.length - 1);
      points.forEach((_, index) => addLabel(index));
      let svg = `<svg viewBox="0 0 ${w} ${h}" class="w-full h-full text-stone-500" role="img" aria-label="每日卡路里摄入柱状图"><title>按日期显示已记录热量；未记录日期不绘制柱形；虚线为 ${CALORIE_REFERENCE_KCAL} kcal 通用参考基准</title>`;
      // 原版固定 2000 kcal 参考线：与柱形共用同一 maxCal 比例尺，明确标为参考基准而非个人目标。
      const referenceY = h - (CALORIE_REFERENCE_KCAL / maxCal) * (h - 45) - 22;
      svg += `<line data-reference-kcal="${CALORIE_REFERENCE_KCAL}" x1="10" y1="${referenceY}" x2="${w - 10}" y2="${referenceY}" stroke="#FF6B57" stroke-dasharray="4,4" stroke-opacity="0.4" stroke-width="1.5" /><text x="${w - 12}" y="12" fill="#FF6B57" font-size="9" font-weight="900" text-anchor="end">${CALORIE_REFERENCE_KCAL} kcal 参考线</text>`;
      points.forEach((point, index) => {
        const x = 10 + index * step + step / 2;
        const textX = Math.max(24, Math.min(w - 24, x));
        if (point.calories != null) {
          const barH = (point.calories / maxCal) * (h - 45);
          const y = h - barH - 22;
          // 原版比较表现：高于参考基准的柱形改用对比色
          const fill = point.calories > CALORIE_REFERENCE_KCAL ? '#FF8575' : '#6ABF69';
          svg += `<rect data-date="${point.date}" data-calories="${point.calories}" x="${x - barWidth / 2}" y="${y}" width="${barWidth}" height="${barH}" rx="${Math.min(6, barWidth / 2)}" fill="${fill}" opacity="0.85"><title>${point.date}: ${point.calories} kcal</title></rect>`;
          if (labels.includes(index))
            svg += `<text x="${textX}" y="${y - 4}" fill="currentColor" font-size="10" font-weight="bold" text-anchor="middle">${point.calories}</text>`;
        }
        if (labels.includes(index))
          svg += `<text x="${textX}" y="${h - 6}" fill="currentColor" font-size="10" font-weight="bold" text-anchor="middle">${point.date.slice(5)}</text>`;
      });
      wrap.innerHTML = svg + '</svg>';
    };
    const renderSourceChart = (breakdown, message = '暂无就餐渠道数据') => {
      const wrap = document.getElementById('chartChannelDonutWrap');
      const legend = document.getElementById('statPctCook')?.parentElement?.parentElement;
      if (!wrap || !legend) return;
      const categories = [
        { key: 'HOMEMADE', label: '自烹', color: '#6ABF69', textColor: '#2E7D32', id: 'statPctCook' },
        { key: 'TAKEOUT', label: '外卖', color: '#FFC53D', textColor: '#D97706', id: 'statPctTakeout' },
        { key: 'DINE_IN', label: '堂食', color: '#B388FF', textColor: '#7C3AED', id: 'statPctDineIn' },
        { key: 'CUSTOM', label: '其他', color: '#A8A29E', textColor: '#78716C', id: 'statPctCustom' }
      ];
      const values = breakdown || {};
      if (
        Object.entries(values).some(
          ([key, count]) =>
            !categories.some((category) => category.key === key) || !Number.isSafeInteger(count) || count < 0
        )
      )
        throw new Error('统计来源数据无效');
      const rows = categories.map((category) => ({ ...category, count: values[category.key] ?? 0 }));
      const total = rows.reduce((sum, row) => sum + row.count, 0);
      legend.innerHTML = rows
        .filter((row) => row.key !== 'CUSTOM' || row.count > 0)
        .map((row) => {
          const pct = total ? `${Math.round((row.count / total) * 1000) / 10}%` : '—';
          return `<span style="color:${row.textColor}">● ${row.label} <span id="${row.id}">${pct}</span></span>`;
        })
        .join('');
      if (!total) {
        wrap.innerHTML = `<div class="p-4 text-center text-stone-400">${message}</div>`;
        return;
      }
      const r = 50;
      const c = 2 * Math.PI * r;
      let offset = 0;
      let svg = `<svg viewBox="0 0 140 140" class="w-32 h-32 text-stone-700" role="img" aria-label="就餐渠道构成环形图"><circle cx="70" cy="70" r="${r}" fill="none" stroke="#F5EFE6" stroke-width="16" />`;
      rows.forEach((row) => {
        if (!row.count) return;
        const length = (row.count / total) * c;
        const pct = Math.round((row.count / total) * 1000) / 10;
        svg += `<circle data-source="${row.key}" data-count="${row.count}" cx="70" cy="70" r="${r}" fill="none" stroke="${row.color}" stroke-width="16" stroke-dasharray="${length} ${c - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)" stroke-linecap="round"><title>${row.label}: ${row.count} 次 (${pct}%)</title></circle>`;
        offset += length;
      });
      const cookPct = Math.round((rows[0].count / total) * 1000) / 10;
      svg += `<text x="70" y="66" text-anchor="middle" font-size="11" font-weight="900" fill="currentColor">下厨率</text><text x="70" y="82" text-anchor="middle" font-size="14" font-weight="900" fill="#6ABF69">${cookPct}%</text></svg>`;
      wrap.innerHTML = svg;
    };
    // 饱腹条统一口径：颜色、图例、百分比全部来自后端 satietySummary 的 category/percent，
    // 分母固定为同一周期的 recordedCount；空记录时不画任何比例段。
    const SATIETY_SEGMENTS = [
      {
        category: 'COMFORTABLE',
        color: '#6ABF69',
        textColor: '#2E7D32',
        label: '七八分饱舒适刚好',
        percentKey: 'comfortablePercent'
      },
      { category: 'LOW', color: '#FFC53D', textColor: '#D97706', label: '三五分饱偏少', percentKey: 'lowPercent' },
      { category: 'OVER', color: '#FF6B57', textColor: '#FF6B57', label: '十分饱偏撑', percentKey: 'overPercent' }
    ];
    const renderSatiety = (satiety) => {
      const bar = document.getElementById('satietyBarContainer');
      const legend = bar?.nextElementSibling;
      const recorded = Number(satiety?.recordedCount) || 0;
      if (!bar) return;
      if (!recorded) {
        bar.innerHTML = '<div class="w-full text-center text-xs text-stone-400">暂无饱腹数据</div>';
        if (legend) legend.textContent = '';
        setStat('statSatietyScore', null);
        return;
      }
      const segments = SATIETY_SEGMENTS.map((segment) => ({
        ...segment,
        count: (satiety.distribution || [])
          .filter((bucket) => bucket.category === segment.category)
          .reduce((sum, bucket) => sum + bucket.count, 0)
      }));
      bar.innerHTML = segments
        .filter((segment) => segment.count > 0)
        .map(
          (segment) =>
            `<div data-satiety-category="${segment.category}" data-satiety-count="${segment.count}" title="${segment.label} ${segment.count}次" style="width:${(segment.count / recorded) * 100}%;background:${segment.color}" class="h-full"></div>`
        )
        .join('');
      if (legend) {
        legend.innerHTML = segments
          .map((segment) => {
            const percent = satiety[segment.percentKey];
            const text = percent == null ? `${Math.round((segment.count / recorded) * 1000) / 10}%` : `${percent}%`;
            return `<span data-satiety-legend="${segment.category}" style="color:${segment.textColor}">● ${segment.label} (${text})</span>`;
          })
          .join('');
      }
      const comfortablePercent = satiety.comfortablePercent;
      setStat(
        'statSatietyScore',
        comfortablePercent == null ? `已记录 ${recorded} 次` : `舒适达标 ${comfortablePercent}% · 已记录 ${recorded} 次`
      );
    };
    const renderRealStatistics = async () => {
      const seq = ++statisticsRequest;
      const range = window.__dafanStatisticsRange === 'week' ? 'week' : 'month';
      // 卡片与图表共用同一次 /statistics 请求：近 7 天=今天及前 6 天，本月=自然月
      const period = range === 'week' ? lastSevenBusinessDays() : currentBusinessMonth();
      const panel = document.getElementById('page-statistics');
      panel?.setAttribute('aria-busy', 'true');
      try {
        const dto = await ApiClient.get(`/statistics?start=${period.start}&end=${period.end}`);
        if (seq !== statisticsRequest) return;
        const cost = dto?.costSummary;
        if (!cost) throw new Error('统计成本数据缺失');
        const average = (total, count) => (count > 0 && total != null ? Math.round(total / count) : null);
        setStat('statTotalExpense', cost.totalCost == null ? null : `¥ ${cost.totalCost}`);
        setStat('statTakeoutExpense', cost.takeoutCost == null ? null : `¥ ${cost.takeoutCost}`);
        setStat('statDineInExpense', cost.dineInCost == null ? null : `¥ ${cost.dineInCost}`);
        const takeoutAverage = average(cost.takeoutCost, cost.takeoutRecordCount);
        const dineInAverage = average(cost.dineInCost, cost.dineInRecordCount);
        setStat(
          'statTakeoutCount',
          cost.takeoutRecordCount == null
            ? null
            : `共 ${cost.takeoutRecordCount} 顿外卖${takeoutAverage == null ? '' : ` (均¥${takeoutAverage})`}`
        );
        setStat(
          'statDineInCount',
          cost.dineInRecordCount == null
            ? null
            : `共 ${cost.dineInRecordCount} 次堂食${dineInAverage == null ? '' : ` (均¥${dineInAverage})`}`
        );
        // 自烹次数绑定真实 homemadeRecordCount；预估节约按原版固定 24 元/顿对比差额计算，
        // 绝不把自烹成本 homemadeCost 当成节约金额展示
        if (Number.isSafeInteger(cost.homemadeRecordCount) && cost.homemadeRecordCount >= 0) {
          setStat('statSavedExpense', `¥ ${cost.homemadeRecordCount * HOMEMADE_COMPARISON_PER_MEAL}`);
          setStat('statCookCount', `自烹 ${cost.homemadeRecordCount} 顿 (对标外卖预估)`);
        } else {
          setStat('statSavedExpense', null);
          setStat('statCookCount', null);
        }
        renderCalorieChart(dto?.calorieTrend);
        renderSourceChart(dto?.sourceBreakdown);
        renderSatiety(dto?.satietySummary);
      } catch (error) {
        if (seq === statisticsRequest) {
          setStat('statTotalExpense', null);
          setStat('statTakeoutExpense', null);
          setStat('statDineInExpense', null);
          setStat('statTakeoutCount', null);
          setStat('statDineInCount', null);
          setStat('statSavedExpense', null);
          setStat('statCookCount', null);
          renderSatiety(null);
          renderCalorieChart([], '统计加载失败，请稍后重试');
          renderSourceChart({}, '统计加载失败，请稍后重试');
          fail(error);
        }
      } finally {
        if (seq === statisticsRequest) panel?.removeAttribute('aria-busy');
      }
    };
    window.renderCalendar = renderRealCalendar;
    window.renderStatistics = renderRealStatistics;
    window.changeCalendarMonth = (delta) => {
      const date = new Date(calendarState.year, calendarState.month - 1 + delta, 1);
      calendarState.year = date.getFullYear();
      calendarState.month = date.getMonth() + 1;
      window.renderCalendar();
    };
    window.switchStatsRange = (range) => {
      window.__dafanStatisticsRange = range === 'week' ? 'week' : 'month';
      document.getElementById('btnStatsRangeMonth')?.classList.toggle('active', range !== 'week');
      document.getElementById('btnStatsRangeWeek')?.classList.toggle('active', range === 'week');
      window.renderStatistics();
    };
    window.__dafanRealViewsInstalled = true;
    // inline 的 DOMContentLoaded 会先用已清空的 mock 画一次统计区（含原版写死的演示柱形）。
    // 安装真实视图后立即清掉这些展示位：不发请求、不弹错误，等真实数据渲染或诚实留空。
    [
      'statTotalExpense',
      'statTakeoutExpense',
      'statDineInExpense',
      'statTakeoutCount',
      'statDineInCount',
      'statSavedExpense',
      'statCookCount',
      'statSatietyScore'
    ].forEach((id) => setStat(id, null));
    const satietyDisplay = document.getElementById('satietyBarContainer');
    if (satietyDisplay) satietyDisplay.innerHTML = '';
    if (satietyDisplay?.nextElementSibling) satietyDisplay.nextElementSibling.textContent = '';
    const calorieDisplay = document.getElementById('chartCalorieTrendWrap');
    if (calorieDisplay) calorieDisplay.innerHTML = '';
    const donutDisplay = document.getElementById('chartChannelDonutWrap');
    if (donutDisplay) donutDisplay.innerHTML = '';
    originalCalendar?.();
  }
  function wireLegacyEntryPoints() {
    const modal = window.BentoModal;
    if (!modal || typeof modal.open !== 'function' || modal.__google2Wired) return;
    // Bind existing buttons to the real services without relying on inline lexical globals.
    document.querySelectorAll('#modalIngredientDetail button[onclick*="pantry.consume"]').forEach((button) => {
      const source = button.getAttribute('onclick') || '';
      const amount = source.includes("'all'") ? 'all' : source.includes(', 250') ? 250 : 100;
      button.onclick = () => {
        Promise.resolve(window.BentoService.pantry.consume(modal.currentPayload, amount)).catch(() => undefined);
      };
    });
    document.querySelectorAll('#modalRecipeDetail button[onclick*="cookCheckin"]').forEach((button) => {
      button.onclick = () => window.BentoService.recipes.cookCheckin(modal.currentPayload);
    });
    // Remote detail payloads are DTO objects; legacy setup methods look up by id.
    // Keep the DTO in currentPayload for actions, normalize only the setup lookup.
    for (const method of ['setupStoreDetail', 'setupRecipeDetail', 'setupIngredientDetail']) {
      if (typeof modal[method] !== 'function') continue;
      const setup = modal[method].bind(modal);
      modal[method] = (payload) => setup(payload && typeof payload === 'object' ? payload.id : payload);
    }
    const originalOpen = modal.open.bind(modal);
    const originalClose = typeof modal.close === 'function' ? modal.close.bind(modal) : null;
    let currentDiaryDate = null;
    let recordFormContext = null;
    const originalSetupDailyDiary =
      typeof modal.setupDailyDiary === 'function' ? modal.setupDailyDiary.bind(modal) : null;
    if (originalSetupDailyDiary) {
      modal.setupDailyDiary = (payload) => {
        currentDiaryDate =
          payload && parseBusinessDate(businessDateParts(payload.year, payload.month, payload.day))
            ? businessDateParts(payload.year, payload.month, payload.day)
            : null;
        const result = originalSetupDailyDiary(payload);
        const date = currentDiaryDate;
        const records =
          window.BentoService?.records?.data?.filter(
            (record) => record.date === date && window.isRecordActive?.(record) !== false
          ) || [];
        document.querySelectorAll('#dailyDiaryMealsList > div').forEach((card, index) => {
          const record = records[index];
          if (!record) return;
          const lines = card.querySelectorAll('span, div');
          const calories = Array.from(lines).find((node) => /kcal$/.test(node.textContent.trim()));
          if (calories && record.calories == null) calories.textContent = '';
          const satiety = Array.from(lines).find((node) => node.textContent.includes('饱腹感：'));
          if (satiety && record.satiety == null) satiety.textContent = '';
          const notes = Array.from(lines).find((node) => node.classList.contains('text-stone-500'));
          if (notes && record.notes == null) notes.textContent = '';
        });
        if (records.some((record) => record.calories == null || record.satiety == null || record.notes == null))
          document.querySelectorAll('#dailyDiaryMealsList *').forEach((node) => {
            if (node.children.length === 0 && node.textContent?.includes('null'))
              node.textContent = node.textContent.replaceAll('null', '');
          });
        return result;
      };
    }
    modal.open = async (name, payload = null, opener = null) => {
      modal.__google2CookContext = null;
      if (name === 'recordForm') {
        recordFormContext = payload && typeof payload === 'object' ? payload : null;
        if (recordFormContext?.__cookRecipe) {
          recordFormContext = {
            ...recordFormContext,
            recipeId: recordFormContext.__cookRecipe.id,
            recipe: recordFormContext.__cookRecipe,
            date: currentDiaryDate || localDateKey(0),
            mealConfirmed: false
          };
        }
        resetRecordPhotoState(Array.isArray(recordFormContext?.photos) ? recordFormContext.photos : []);
      } else if (name !== 'recordForm') {
        recordFormContext = null;
      }
      const remoteService =
        name === 'storeDetail'
          ? window.BentoService?.stores
          : name === 'recipeDetail'
            ? window.BentoService?.recipes
            : name === 'ingredientDetail'
              ? window.BentoService?.pantry
              : null;
      if (
        (name === 'storeDetail' || name === 'recipeDetail' || name === 'ingredientDetail') &&
        payload &&
        remoteService
      ) {
        try {
          payload = await remoteService.getByIdRemote(typeof payload === 'object' ? payload.id : payload);
          const top = modal.getTop?.();
          const topId = typeof top?.payload === 'object' ? top.payload?.id : top?.payload;
          // Refresh the current detail instead of stacking another copy of it.
          if (top?.name === name && topId === payload.id) originalClose?.(true);
        } catch (error) {
          fail(error);
          return false;
        }
      }
      // 详情页编辑按钮传入 currentPayload 对象；表单 setup 入口只接受 id。
      // 先用远端 DTO 刷新 service，再把规范化 id 交给既有 modal setup，避免空表单。
      if ((name === 'storeForm' || name === 'recipeForm') && payload && typeof payload === 'object') {
        const service = name === 'storeForm' ? window.BentoService?.stores : window.BentoService?.recipes;
        if (!service?.getByIdRemote || !payload.id) {
          toast('编辑对象缺少真实 ID，无法打开表单', 'error');
          return false;
        }
        try {
          const remote = await service.getByIdRemote(payload.id);
          payload = remote.id;
        } catch (error) {
          fail(error);
          return false;
        }
      }
      const result =
        opener == null
          ? originalOpen(name, payload?.__cookRecipe ? null : payload)
          : originalOpen(name, payload, opener);
      if (name === 'recordForm' && recordFormContext?.__cookRecipe) {
        const recipe = recordFormContext.__cookRecipe;
        const title = document.getElementById('formRecordTitle');
        if (title) title.value = recipe.name || '';
        const date = currentDiaryDate || localDateKey(0);
        recordFormContext = { ...recordFormContext, recipeId: recipe.id, recipe, date, mealConfirmed: false };
        modal.__google2CookContext = recordFormContext;
        document.getElementById('formRecordId')?.setAttribute('value', '');
        const slot = document.getElementById('formRecordSlot');
        if (slot) slot.value = '';
      }
      return result;
    };
    if (originalClose) {
      modal.close = (...args) => {
        const result = originalClose(...args);
        recordFormContext = null;
        modal.__google2CookContext = null;
        resetRecordPhotoState([]);
        return result;
      };
    }
    if (modal.handleRecipeFormSubmit)
      modal.handleRecipeFormSubmit = (event) =>
        withSubmitGuard(event, async () => {
          event.preventDefault();
          // 正式页面严格限定在菜谱弹窗；兼容无弹窗容器的 adapter 单元 fixture。
          const form = document.querySelector('#modalRecipeForm') || document;
          const read = (id) => form?.querySelector(`#${id}`);
          const value = (id) => read(id)?.value ?? '';
          const id = String(value('formRecipeId')).trim();
          const existing = id ? modalRecipeService().getById(id) : null;
          const calories = value('formRecipeCalories');
          const timeValue = String(value('formRecipeTime')).trim();
          const time = timeValue === '' ? null : Number(timeValue);
          if (
            (!id && (time === null || !Number.isInteger(time) || time < 1 || time > 240)) ||
            (id && time !== null && (!Number.isInteger(time) || time < 0 || time > 240))
          )
            throw new ApiError(422, 'RECIPE_TIME_INVALID', '制作时间必须是新建 1-240 分钟、编辑 0-240 分钟的整数');
          return modalRecipeService().save({
            id: id || undefined,
            version: existing?.version,
            name: String(value('formRecipeName')).trim(),
            category:
              read('formRecipeCategory')?.dataset.valueState === 'unrepresentable'
                ? undefined
                : value('formRecipeCategory').trim() || null,
            cookingTimeMinutes: time,
            difficulty: value('formRecipeDifficulty').trim() || null,
            calories,
            imagePath: existing?.imagePath ?? null,
            ingredientsText: existing?.ingredientsText ?? null,
            favorite: existing?.favorite ?? false,
            spicyLevel: existing?.spicyLevel ?? null,
            servings: existing?.servings ?? null,
            sourceNote: existing?.sourceNote ?? null,
            notes: existing?.notes ?? null,
            enabledForRecommendation: existing?.enabledForRecommendation ?? true,
            ingredients: (() => {
              const rows = Array.from(document.querySelectorAll('#formRecipeIngList .recipe-ing-row'));
              if (!rows.length) return existing?.ingredients || [];
              return rows
                .map((row) => {
                  const name = row.querySelector('.recipe-ing-name')?.value.trim() || '';
                  const amount = row.querySelector('.recipe-ing-amount')?.value.trim() || '';
                  // 行身份优先：ingredientRowId 是菜谱食材行自身 ID，与库存 ingredientId 语义不同
                  // （两个 ID 可以不同）。旧行查找先按行自身 ID 精确匹配，再按库存 ID 兜底，
                  // 最后仅按原始名称兼容旧行；新增行不按位置继承已删除行的 ingredientId/flags。
                  const old =
                    (row.dataset.ingredientRowId
                      ? existing?.ingredients?.find((ingredient) => ingredient.id === row.dataset.ingredientRowId)
                      : undefined) ??
                    (row.dataset.ingredientId
                      ? existing?.ingredients?.find(
                          (ingredient) => (ingredient.id ?? ingredient.ingredientId) === row.dataset.ingredientId
                        )
                      : undefined) ??
                    (row.dataset.originalName
                      ? existing?.ingredients?.find(
                          (ingredient) =>
                            String(ingredient.name ?? ingredient.originalName ?? '').trim() === row.dataset.originalName
                        )
                      : undefined);
                  // 未改动的行原样沿用后端既有数量/单位（后端枚举 OTHER 等无法从展示文案反推，避免静默丢失）。
                  // 新增行没有 originalName，绝不按位置继承被删除旧行的身份与 flags。
                  const oldName = String(row.dataset.originalName ?? old?.name ?? old?.originalName ?? '').trim();
                  const renamed = !!old && name !== oldName;
                  if (old && amount === (old.amount ?? '')) {
                    return {
                      ingredientId: renamed ? null : (old.ingredientId ?? null),
                      name: name || old.name || '',
                      quantity: typeof old.quantity === 'number' ? old.quantity : null,
                      unit: old.unit ?? null,
                      amountText: old.amountText ?? null,
                      optional: !!old.optional,
                      isPrimary: !!old.isPrimary
                    };
                  }
                  // 用户改写过的用量是自由文本（占位提示含「300g / 半个 / 适量」）：只有整段输入可完整解释
                  // 且可无损还原才写结构化 quantity/unit——即后端单位能反推出与原文完全一致的单位文案
                  // （UNIT_TO_BACKEND 把「根」「块」等多个中文单位合并进 OTHER 且 OTHER 无展示标签，
                  // 保存后再读回会退化为纯数字，因此这类有损映射必须整段保留 amountText）。
                  const match = amount.match(/^([0-9]+(?:\.[0-9]+)?)\s*(.*)$/);
                  const parsedUnit = match ? toBackendUnit(match[2]) : null;
                  const losslesslyRepresentable =
                    !!match && (match[2] === '' || (parsedUnit !== null && UNIT_LABELS[parsedUnit] === match[2]));
                  return {
                    ingredientId: old && !renamed ? (old.ingredientId ?? null) : null,
                    name,
                    quantity: losslesslyRepresentable ? Number(match[1]) : null,
                    unit: losslesslyRepresentable ? parsedUnit : null,
                    amountText: losslesslyRepresentable ? null : amount || null,
                    optional: old ? !!old.optional : false,
                    isPrimary: old ? !!old.isPrimary : false
                  };
                })
                .filter((item) => item.name);
            })(),
            steps: (() => {
              const rows = Array.from(document.querySelectorAll('#formRecipeStepList .recipe-step-row'));
              if (!rows.length) return existing?.steps || [];
              // 未改动的行原样沿用后端既有 content：避免把 UI 合成标题（"步骤 N"）回写进正文造成漂移。
              // 正文只来自做法输入（后端 title/content 独立存储，正文绝不拼入标题），连续编辑不累积旧标题。
              return (
                rows
                  .map((row, index) => {
                    const title = row.querySelector('.recipe-step-title')?.value.trim() || '';
                    const desc = row.querySelector('.recipe-step-desc')?.value.trim() || '';
                    const old = row.dataset.stepId
                      ? existing?.steps?.find((step) => step.id === row.dataset.stepId)
                      : existing?.steps?.[index];
                    const oldTitle = old?.title ?? '';
                    const oldDesc = old?.desc || old?.content || '';
                    const untouched = old && title === oldTitle && desc === oldDesc;
                    const content = untouched ? String(old.content ?? old.desc ?? '') : desc;
                    return {
                      content,
                      title: title || null,
                      timerMinutes: (() => {
                        const raw = row.querySelector('.recipe-step-timer')?.value.trim() || '';
                        return raw === '' ? (old?.timerMinutes ?? null) : Number(raw);
                      })(),
                      imagePath: old?.imagePath ?? null
                    };
                  })
                  // 只有标题没有正文的行保留下来交给 save 显式失败（提示补正文），绝不静默丢步骤、也绝不拿标题冒充正文
                  .filter((item) => item.content || item.title)
              );
            })(),
            // 关系字段从既有记录派生（已映射键优先，兼容 legacy 形状），再按后端 enum 严格转换
            ...recipeRelationFields(existing)
          });
        }).catch(fail);
    if (modal.handleStoreFormSubmit)
      modal.handleStoreFormSubmit = (event) =>
        withSubmitGuard(event, async () => {
          event.preventDefault();
          const form = document.querySelector('#modalStoreForm');
          const read = (id) => form?.querySelector(`#${id}`);
          const value = (id) => read(id)?.value ?? '';
          const id = String(value('formStoreId')).trim();
          const existing = id ? window.BentoService.stores.getById(id) : null;
          if (id && (!existing || !Number.isInteger(existing.version) || existing.version < 1))
            throw new ApiError(409, 'STORE_VERSION_REQUIRED', '编辑门店缺少有效版本');
          const name = String(value('formStoreName')).trim();
          if (!name) throw new ApiError(422, 'STORE_NAME_REQUIRED', '请输入门店名称');
          const rawPrice = String(value('formStorePrice')).trim();
          const price = rawPrice === '' ? null : Number(rawPrice);
          if (price !== null && (!Number.isInteger(price) || price < 0 || price > 999))
            throw new ApiError(422, 'STORE_PRICE_INVALID', '平均价格无效');
          const menuItems = Array.from(form?.querySelectorAll('.store-dish-row') || []).map((row, index) => {
            const input = (selector) => row.querySelector(selector);
            const itemName = input('.store-dish-name')?.value?.trim() || '';
            const raw = input('.store-dish-price')?.value?.trim() || '';
            const flag = input('.store-dish-sig');
            const item = {
              name: itemName,
              price: raw === '' ? null : Number(raw),
              isSignature: !!flag?.checked,
              sortOrder: index
            };
            if (row.dataset.menuIcon != null) item.icon = row.dataset.menuIcon;
            if (row.dataset.menuDesc != null) item.desc = row.dataset.menuDesc;
            return item;
          });
          return window.BentoService.stores.save({
            id: id || undefined,
            version: existing?.version,
            name,
            category: (() => {
              const category = String(value('formStoreCategory')).trim();
              const state = read('formStoreCategory')?.dataset.valueState;
              return state === 'unrepresentable' ? undefined : category || null;
            })(),
            price,
            phone: String(value('formStorePhone')).trim() || null,
            hours: String(value('formStoreHours')).trim() || null,
            address: String(value('formStoreAddress')).trim() || null,
            supportsDineIn: !!read('formStoreDineIn')?.checked,
            supportsTakeout: !!read('formStoreTakeout')?.checked,
            notes: String(value('formStoreNotes')).trim() || null,
            menuItems
          });
        }).catch(fail);
    if (modal.handleIngredientFormSubmit)
      modal.handleIngredientFormSubmit = (event) =>
        withSubmitGuard(event, async () => {
          event.preventDefault();
          return window.BentoService.pantry.save({
            name: document.getElementById('formIngName')?.value.trim() || '',
            category: document.getElementById('formIngCategory')?.value || '',
            storageLocation: document.getElementById('formIngLocation')?.value || '',
            stock: Number(document.getElementById('formIngStockNum')?.value) || null,
            unit: document.getElementById('formIngStockUnit')?.value || '',
            expireDaysLeft: document.getElementById('formIngExpireDays')?.value.trim() || null
          });
        }).catch(fail);
    if (modal.handleShoppingFormSubmit)
      modal.handleShoppingFormSubmit = (event) =>
        withSubmitGuard(event, async () => {
          event.preventDefault();
          return window.BentoService.shopping.add({
            name: document.getElementById('formShopName')?.value.trim() || '',
            category: document.getElementById('formShopCategory')?.value || '',
            amount: document.getElementById('formShopAmount')?.value.trim() || '1份',
            isChecked: false,
            source: '手动备忘'
          });
        })
          .then((result) => {
            if (result) window.BentoModal?.close(true);
            return result;
          })
          .catch(fail);
    if (modal.handlePlanPickerSubmit)
      modal.handlePlanPickerSubmit = (event) =>
        withSubmitGuard(event, async () => {
          event.preventDefault();
          const id = document.getElementById('formPlanId')?.value.trim() || '';
          const targetVal = document.getElementById('planPickerSelectTarget')?.value || '';
          const parts = targetVal.split(':');
          const targetType = parts[0] === 'store' ? 'store' : parts[0] === 'recipe' ? 'recipe' : '';
          const targetId = parts[1] || '';
          const date =
            document.getElementById('planPickerDateVal')?.value ||
            document.getElementById('planPickerCustomDate')?.value ||
            '';
          const time =
            document.getElementById('planPickerTimeVal')?.value ||
            document.getElementById('planPickerCustomTime')?.value ||
            '';
          const slot = document.getElementById('planPickerSlotVal')?.value || '';
          const target =
            targetType === 'recipe'
              ? window.BentoService?.recipes?.getById(targetId)
              : window.BentoService?.stores?.getById(targetId);
          const title =
            targetType === 'recipe'
              ? `${target?.name || '自烹便当'}配白米饭`
              : `${target?.name || '外卖店铺'} · ${parts[2] || '招牌特色套餐'}`;
          const subtext =
            targetType === 'recipe'
              ? `自烹营养餐 · 预估 ${target?.calories ?? ''} kcal`
              : `${target?.category || '品质餐饮'} · 人均 ¥${target?.price ?? ''}`;
          const payload = {
            date,
            time,
            slot,
            title,
            subtext,
            icon: target?.icon || (targetType === 'recipe' ? '🥘' : '🛵'),
            targetType,
            targetId
          };
          if (!payload.targetType || !payload.targetId)
            throw new ApiError(422, 'PLAN_TARGET_UNSUPPORTED', '请先选择排餐菜品或外卖店铺！');
          if (id) return window.BentoService.plans.update(id, payload);
          return window.BentoService.plans.add(payload);
        })
          .then((result) => {
            if (result) window.BentoModal?.close(true);
            return result;
          })
          .catch(fail);
    if (modal.handleRecordFormSubmit)
      modal.handleRecordFormSubmit = (event) =>
        withSubmitGuard(event, async () => {
          event.preventDefault();
          const id = document.getElementById('formRecordId')?.value.trim() || '';
          const readValue = (fieldId) => document.getElementById(fieldId)?.value ?? '';
          // 若既有评分（如 4.5）在 5/4/3/2 四个选项里表达不出来，回填时已标记 unrepresentable：
          // 省略 rating 让后端保留原值，绝不静默改成别的档位
          const ratingState = document.getElementById('formRecordRating')?.dataset.valueState;
          const slotState = document.getElementById('formRecordSlot')?.dataset.valueState;
          const title = readValue('formRecordTitle');
          const slot = readValue('formRecordSlot');
          const payload = {
            // 餐次表达不了（如后端 SOUP）时不传，编辑时保留后端原值、新建时明确报错，不猜一个别的餐次
            slot: slotState === 'unrepresentable' && slot === '' ? undefined : slot,
            type: readValue('formRecordType'),
            // 控件无值就是真实未填写 → null（后端 nullable），不再拼「好好吃饭，心满意足。」这类字面默认
            title: title.trim(),
            date: id ? undefined : currentDiaryDate || undefined,
            calories: readValue('formRecordCalories'),
            cost: readValue('formRecordCost'),
            // 饱腹感回填时若后端值不在 5 档内（unrepresentable），与 rating 同样省略字段保留后端原值，
            // 绝不因为控件表达不了就静默写成 null
            satiety:
              document.getElementById('formRecordSatiety')?.dataset.valueState === 'unrepresentable'
                ? undefined
                : readValue('formRecordSatiety'),
            rating: (() => {
              if (ratingState === 'unrepresentable') return undefined;
              const raw = readValue('formRecordRating').trim();
              if (raw === '') return null;
              const value = Number(raw);
              if (!Number.isFinite(value) || value < 0 || value > 5)
                throw new ApiError(422, 'RECORD_RATING_INVALID', '美味度评分必须在 0 到 5 之间');
              return value;
            })(),
            notes: readValue('formRecordNotes').trim(),
            photos: [0, 1, 2]
              .map(
                (slot) =>
                  recordPhotoSlots[slot] ||
                  document.getElementById(`photoSlotView-${slot}`)?.querySelector('img')?.getAttribute('src')
              )
              .map((value, slot) => ({ value, slot }))
              .filter(({ value }) => Boolean(value))
          };
          payload.photos = await resolveRecordPhotos(payload.photos);
          const cookContext = recordFormContext || modal.__google2CookContext;
          if (cookContext?.recipeId && !id) {
            const cookPayload = {
              recordDate: cookContext.date || currentDiaryDate || localDateKey(0),
              mealType: recordMealType(payload.slot),
              sourceType: recordSourceType(payload.type),
              title: payload.title || null,
              photos: payload.photos.length ? payload.photos : null,
              calories: parseRecordCaloriesInput(payload.calories),
              cost: parseRecordCostInput(payload.cost),
              satiety: parseRecordSatietyInput(payload.satiety),
              rating: payload.rating,
              notes: payload.notes || null
            };
            const result = await ApiClient.post(
              `/recipes/${encodeURIComponent(cookContext.recipeId)}/cook-checkin`,
              cookPayload
            );
            const mapped = mapRecord(result.record);
            mapped.recipeId = cookContext.recipeId;
            const records = window.BentoService.records;
            records.data = records.data.some((x) => x.id === mapped.id)
              ? records.data.map((x) => (x.id === mapped.id ? mapped : x))
              : [mapped, ...records.data];
            emit('records:changed');
            emit('recipes:changed');
            window.BentoModal?.close(true);
            toast('已记录，未扣库存', 'success');
            return mapped;
          }
          if (id) return window.BentoService.records.update(id, payload);
          return window.BentoService.records.add(payload);
        })
          .then((result) => {
            if (result) window.BentoModal?.close(true);
            return result;
          })
          .catch(fail);
    if (typeof window.handleToolFormSubmit === 'function' && !window.handleToolFormSubmit.__google2Wired) {
      const wiredToolFormSubmit = (event) =>
        withSubmitGuard(event, async () => {
          event.preventDefault();
          return window.BentoService.tools.save({
            name: document.getElementById('formToolName')?.value.trim() || '',
            icon: document.getElementById('formToolIcon')?.value || '',
            category: document.getElementById('formToolCategory')?.value || '',
            status: document.getElementById('formToolStatus')?.value || '',
            notes: document.getElementById('formToolNotes')?.value.trim() || ''
          });
        })
          .then((result) => {
            if (result) window.BentoModal?.close(true);
            return result;
          })
          .catch(fail);
      wiredToolFormSubmit.__google2Wired = true;
      window.handleToolFormSubmit = wiredToolFormSubmit;
    }
    modal.__google2Wired = true;
    const originalRenderRecords = window.renderRecords;
    if (typeof originalRenderRecords === 'function' && !originalRenderRecords.__google2Wired) {
      const renderRecords = function (...args) {
        const result = originalRenderRecords.apply(this, args);
        const records = window.BentoService?.records?.getAll?.() || [];
        document.querySelectorAll('#recordsListContainer > .neo-card').forEach((card, index) => {
          const record = records[index];
          if (!record) return;
          const calories = card.querySelector('.flex.items-center.justify-between.text-xs span.font-extrabold');
          if (calories && record.calories == null) calories.textContent = '';
          const footer = card.querySelector('.border-t.border-stone-100');
          if (footer) {
            const [satiety, rating] = footer.querySelectorAll('span');
            if (satiety && record.satiety == null) satiety.textContent = '';
            if (rating && (record.rating == null || record.rating === 0)) rating.textContent = '';
          }
          const notes = card.querySelector('.text-stone-600.bg-\\[\\#FAF7F2\\]');
          if (notes && record.notes == null) notes.textContent = '';
          // inline 模板先把 nullable 值插入成字面 null；清理真实 null，不补任何展示默认值。
          if (record.calories == null || record.notes == null || record.satiety == null) {
            card.querySelectorAll('*').forEach((node) => {
              if (node.children.length === 0 && node.textContent?.includes('null'))
                node.textContent = node.textContent.replaceAll('null', '');
            });
          }
        });
        return result;
      };
      renderRecords.__google2Wired = true;
      window.renderRecords = renderRecords;
    }
    installLegacyDataViews();
  }
  function modalRecipeService() {
    return window.BentoService.recipes;
  }
  /**
   * 从 service 现有记录里取关系字段：优先已映射键（mapRecipe 产物），
   * 回退兼容 legacy 直接形状（本地/旧数据里可能是中文标签或字符串工具名），
   * 转换时仍由 save 严格按后端 enum 校验，非法值快速失败。
   */
  function recipeRelationFields(existing) {
    const source = existing || {};
    const names = (values) =>
      (values || []).map((x) => (typeof x === 'string' ? x : (x?.tag?.name ?? x?.name ?? ''))).filter(Boolean);
    return {
      tags: source.tagNames ?? names(source.tags),
      mealTypeKeys: source.mealTypeKeys ?? source.mealTypes ?? [],
      mealRoleKeys: source.mealRoleKeys ?? source.mealRoles ?? [],
      toolKeys: source.toolKeys ?? names(source.toolIds).map((name) => ({ toolId: null, name, required: true }))
    };
  }
  function wireDomain() {
    const service = window.BentoService;
    if (!service || !service.stores || !service.recipes) return;
    const loadStores = replaceStoreService(service.stores);
    const loadRecipes = replaceRecipeService(service.recipes);
    service.stores.reload = loadStores;
    service.recipes.reload = loadRecipes;
    let loadShopping;
    if (service.shopping) {
      loadShopping = replaceShoppingService(service.shopping);
      service.shopping.reload = loadShopping;
    }
    let loadPantry;
    if (service.pantry) {
      loadPantry = replacePantryService(service.pantry);
      service.pantry.reload = loadPantry;
    }
    let loadPlans;
    if (service.plans) {
      loadPlans = replacePlanService(service.plans);
      service.plans.reload = loadPlans;
    }
    let loadRecords;
    if (service.records) {
      loadRecords = replaceRecordService(service.records);
      service.records.reload = loadRecords;
    }
    let loadTools;
    if (service.tools) {
      loadTools = replaceToolService(service.tools);
      service.tools.reload = loadTools;
    }
    installRecordPhotoCapture();
    // 真实写成功后才标记首页数据过期；读取/reload 路径不触发刷新
    wrapDashboardWriteMethods(service);
    wireLegacyEntryPoints();
    loadStores().catch(fail);
    loadRecipes().catch(fail);
    loadShopping?.().catch(fail);
    loadPantry?.().catch(fail);
    loadPlans?.().catch(fail);
    loadRecords?.().catch(fail);
    loadTools?.().catch(fail);
  }
  async function syncPinSession() {
    try {
      const session = await request('/settings/pin/session', { _skipPinRetry: true });
      if (session?.valid === true && session.token) localStorage.setItem(PIN_KEY, session.token);
      return session;
    } catch (error) {
      if (error?.status === 401 && error?.code === 'UNAUTHORIZED') return ensurePinUnlock();
      throw error;
    }
  }
  function boot() {
    clearMockState();
    // 只有正式入口存在解锁界面时才启动会话探测；单元 fixture/嵌入式片段不应凭空占用业务请求序列。
    if (document.getElementById('modalPinUnlock')) void syncPinSession().catch(fail);
    blockUnconnectedWrites();
    installDashboardRefresh();
    wireDomain();
    loadDashboard().catch(fail);
    wireSettings().catch(fail);
  }
  function wheelRecommendationBody(mode) {
    const body = {};
    if (mode === 'cook') body.sourceTypes = ['RECIPE'];
    else if (mode === 'dinein') {
      body.sourceTypes = ['STORE'];
      body.acquisitionModes = ['DINE_IN'];
    } else if (mode === 'takeout') {
      body.sourceTypes = ['STORE'];
      body.acquisitionModes = ['TAKEOUT'];
    }
    return body;
  }
  async function resolveWheelTargetIndex(mode) {
    const items = window.getDynamicWheelItems ? window.getDynamicWheelItems() : [];
    if (!items.length) {
      toast('转盘候选为空，先去添加菜谱或店铺吧', 'info');
      return null;
    }
    let payload;
    try {
      payload = await ApiClient.post('/recommendations/random', wheelRecommendationBody(mode));
    } catch (error) {
      fail(error);
      return null;
    }
    const results = payload?.results || [];
    // 本轮已排除项不得通过远程推荐重新进入结果：按排除集合过滤后取第一个有效结果
    const isExcluded = (item) => (window.isWheelItemExcluded ? window.isWheelItemExcluded(item) : false);
    const pick = results.find(
      (result) =>
        !isExcluded({
          type: result.resultType === 'STORE' ? 'store' : 'recipe',
          id: result.resultId,
          title: result.title || result.name || ''
        })
    );
    if (!pick) {
      toast(
        results.length ? '剩余候选均已被排除，可切换分类或稍后再试' : '暂无符合条件的真实推荐结果，稍后再试',
        'info'
      );
      return null;
    }
    const expectedType = pick.resultType === 'STORE' ? 'store' : 'recipe';
    let index = items.findIndex((item) => item && item.type === expectedType && item.id === pick.resultId);
    if (index >= 0) return index;
    // 真实推荐结果不在当前扇区时，将其映射进当前候选扇区（替换最后一个扇区，扇区数与设计不变）
    const mappedCandidate = items.find(
      (item) => item && item.type === expectedType && item.title === (pick.title || pick.name || '')
    );
    if (mappedCandidate && isExcluded(mappedCandidate)) {
      toast('推荐结果已被排除，暂不落到该扇区', 'info');
      return null;
    }
    const remoteService = pick.resultType === 'STORE' ? window.BentoService?.stores : window.BentoService?.recipes;
    const cached = remoteService?.getById ? remoteService.getById(pick.resultId) : null;
    if (!cached) {
      toast('推荐结果无法映射到当前转盘候选', 'error');
      return null;
    }
    const sector =
      pick.resultType === 'STORE'
        ? {
            id: cached.id,
            title: cached.name,
            type: 'store',
            sub: [cached.category, cached.price ? `人均¥${cached.price}` : null].filter(Boolean).join(' · '),
            icon: cached.icon || '🍜',
            supportsDineIn: !!cached.supportsDineIn,
            supportsTakeout: !!cached.supportsTakeout
          }
        : {
            id: cached.id,
            title: cached.name,
            type: 'recipe',
            sub: [
              cached.cuisine,
              cached.cookTimeMinutes !== undefined && cached.cookTimeMinutes !== null && cached.cookTimeMinutes !== ''
                ? `${cached.cookTimeMinutes}分钟`
                : null
            ]
              .filter(Boolean)
              .join(' · '),
            icon: cached.icon || '🍱'
          };
    items[items.length - 1] = sector;
    window.renderWheelSlices?.();
    return items.length - 1;
  }
  sanitizeStaticBusinessState();
  window.DafanApiClient = ApiClient;
  window.DafanPinAdapter = { ensurePinUnlock, cancelPinUnlock, syncPinSession };
  window.DafanDashboardAdapter = {
    mapDashboard,
    loadDashboard,
    refreshDashboard,
    isHomeVisible,
    installDashboardRefresh
  };
  window.DafanSettingsAdapter = { loadSettings, wireSettings };
  window.DafanWheelAdapter = {
    resolveTargetIndex: resolveWheelTargetIndex,
    recommendationBody: wheelRecommendationBody
  };
  window.DafanDomainAdapter = {
    mapStore,
    mapRecipe,
    mapPantryItem,
    mapShoppingItem,
    mapPlan,
    mapRecord,
    mapTool,
    normalizeList: pageItems,
    replaceStoreService,
    replaceRecipeService,
    replacePantryService,
    replaceShoppingService,
    replacePlanService,
    replaceRecordService,
    replaceToolService,
    wireLegacyEntryPoints,
    withSubmitGuard,
    wireDomain
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', boot, { once: true, capture: true });
  else boot();
})();

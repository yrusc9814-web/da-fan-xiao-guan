(() => {
  'use strict';
  const API_BASE = '/api/v1';
  const PIN_KEY = 'dafan-pin-token';
  const BLOCKED_MESSAGE = '该功能尚未接通真实后端';
  class ApiError extends Error {
    constructor(status, code, message, details) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }
  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    const hasBody = options.body !== undefined && options.body !== null;
    if (
      hasBody &&
      !(options.body instanceof FormData) &&
      !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
    )
      headers['Content-Type'] = 'application/json';
    const token = localStorage.getItem(PIN_KEY);
    if (token) headers['X-App-Pin-Token'] = token;
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok || !payload || payload.success !== true) {
      const error = payload?.error || {};
      throw new ApiError(
        response.status,
        error.code || (response.status === 503 ? 'MAINTENANCE' : 'HTTP_ERROR'),
        error.message || `请求失败（${response.status}）`,
        error.details
      );
    }
    return payload.data;
  }
  const ApiClient = {
    request,
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
      category: s.cuisine || s.storeType || '',
      price: s.averageCost ?? '',
      rating: s.rating ?? '',
      phone: s.contact || '',
      hours: s.businessHours || '',
      dishes: s.recommendedDishes || '',
      icon: s.imagePath || '🍱',
      version: s.version
    };
  }
  function mapIngredient(i) {
    const name = i.ingredientName || i.name || '';
    return { ...i, name, amount: i.quantity == null ? '' : `${i.quantity}${i.unit || ''}`, pantryKeyword: name };
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
  const UNIT_TO_BACKEND = {
    g: 'GRAM',
    kg: 'KILOGRAM',
    个: 'PIECE',
    根: 'OTHER',
    块: 'OTHER',
    盒: 'BOX',
    份: 'PORTION',
    瓶: 'BOTTLE',
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
  function toBackendUnit(unit) {
    if (!unit) return null;
    if (BACKEND_UNITS.has(unit)) return unit;
    return UNIT_TO_BACKEND[unit] || null;
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
    return {
      ...item,
      unitKey: item.unit,
      unit: unitLabel,
      name: item.ingredientNameSnapshot || '',
      amount: `${item.quantity}${unitLabel}`,
      category: '',
      isChecked: !!item.completed,
      source: SHOPPING_SOURCE_LABELS[item.sourceType] || '备忘'
    };
  }
  function mapRecipe(r) {
    return {
      ...r,
      category: (r.tags || []).join('、') || (r.mealTypes || [])[0] || '',
      icon: r.imagePath || '🥘',
      cookTimeMinutes: r.cookingTimeMinutes ?? '',
      ingredients: (r.ingredients || []).map(mapIngredient),
      steps: (r.steps || []).map((s, i) => ({
        ...s,
        stepIndex: s.stepNo || i + 1,
        title: s.title || `步骤 ${s.stepNo || i + 1}`,
        desc: s.desc || s.content || '',
        timerMinutes: s.timerMinutes || 0
      })),
      version: r.version
    };
  }
  const MEAL_TYPE_TO_BACKEND = {
    早餐: 'BREAKFAST',
    午餐: 'LUNCH',
    晚餐: 'DINNER',
    下午茶: 'AFTERNOON_TEA',
    汤品: 'SOUP'
  };
  const MEAL_TYPE_LABELS = {
    BREAKFAST: '早餐',
    LUNCH: '午餐',
    DINNER: '晚餐',
    AFTERNOON_TEA: '下午茶',
    SOUP: '汤品'
  };
  function toBackendMealType(slot) {
    return MEAL_TYPE_TO_BACKEND[slot] || null;
  }
  const SOURCE_TYPE_TO_BACKEND = { 自烹: 'HOMEMADE', 外卖: 'TAKEOUT', 堂食: 'DINE_IN' };
  const SOURCE_TYPE_LABELS = { HOMEMADE: '自烹', DINE_IN: '堂食', TAKEOUT: '外卖', CUSTOM: '其他' };
  const SOURCE_TYPE_ICONS = { HOMEMADE: '🍳', DINE_IN: '🍽️', TAKEOUT: '🛵', CUSTOM: '🍱' };
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
    return {
      ...p,
      date: p.planDate,
      slot: MEAL_TYPE_LABELS[p.mealType] || p.mealType,
      time: '',
      subtext: '',
      linkedRecordId: '',
      isCompleted: p.status === 'COMPLETED',
      ...mapPlanItemTarget((p.items || [])[0]),
      version: p.version
    };
  }
  function mapRecord(r) {
    const item = (r.items || [])[0];
    return {
      ...r,
      date: r.recordDate,
      slot: MEAL_TYPE_LABELS[r.mealType] || r.mealType,
      type: SOURCE_TYPE_LABELS[r.sourceType] || r.sourceType,
      icon: SOURCE_TYPE_ICONS[r.sourceType] || '🍱',
      title: item?.customName || item?.recipe?.name || item?.store?.name || '',
      calories: '',
      satiety: undefined,
      cost: '',
      photos: r.imagePath ? [r.imagePath] : [],
      version: r.version
    };
  }
  function mapTool(t) {
    return { ...t, icon: t.imagePath || '🍲', version: t.version };
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
      if (store.menuItems?.length)
        throw new ApiError(422, 'STORE_MENU_UNSUPPORTED', '门店菜单没有后端实体，暂不支持保存');
      const body = {
        name: store.name,
        address: store.address || null,
        storeType: store.storeType || null,
        cuisine: store.cuisine || store.category || null,
        averageCost: store.averageCost ?? (store.price === '' ? null : Number(store.price)),
        supportsDineIn: !!store.supportsDineIn,
        supportsTakeout: !!store.supportsTakeout,
        contact: store.contact ?? store.phone ?? null,
        businessHours: store.businessHours ?? store.hours ?? null,
        rating: store.rating ?? null,
        recommendedDishes: store.recommendedDishes ?? store.dishes ?? null,
        notes: store.notes || null,
        favorite: !!store.favorite
      };
      const dto = store.id
        ? await ApiClient.put(`/stores/${encodeURIComponent(store.id)}`, { ...body, version: store.version })
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
      const mapped = mapRecipe(await ApiClient.get(`/recipes/${encodeURIComponent(id)}`));
      service.data = service.data.some((x) => x.id === mapped.id)
        ? service.data.map((x) => (x.id === mapped.id ? mapped : x))
        : [mapped, ...service.data];
      emit('recipes:changed');
      return mapped;
    };
    service.save = async (recipe) => {
      if (recipe.calories !== undefined && recipe.calories !== null && recipe.calories !== '')
        throw new ApiError(422, 'RECIPE_CALORIES_UNSUPPORTED', '后端菜谱不支持 calories 字段，无法保存');
      const ingredients = (recipe.ingredients || []).map((i) => ({
        ingredientId: i.ingredientId ?? null,
        name: i.name || i.ingredientName || '',
        quantity: typeof i.quantity === 'number' ? i.quantity : null,
        unit: i.unit || null,
        optional: !!i.optional,
        isPrimary: !!i.isPrimary
      }));
      const steps = (recipe.steps || [])
        .map((s) => ({
          content: s.content || [s.title, s.desc].filter(Boolean).join('：'),
          imagePath: s.imagePath || null
        }))
        .filter((s) => s.content);
      const body = {
        name: recipe.name,
        imagePath: recipe.imagePath || null,
        ingredientsText: recipe.ingredientsText || null,
        cookingTimeMinutes: recipe.cookingTimeMinutes ?? recipe.cookTimeMinutes ?? null,
        difficulty: recipe.difficulty || null,
        spicyLevel: recipe.spicyLevel ?? null,
        servings: recipe.servings ?? null,
        sourceNote: recipe.sourceNote || null,
        notes: recipe.notes || null,
        favorite: !!recipe.favorite,
        enabledForRecommendation: recipe.enabledForRecommendation !== false,
        ingredients,
        steps,
        tags: Array.isArray(recipe.tags)
          ? recipe.tags.map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean)
          : [],
        mealTypes: recipe.mealTypes || [],
        mealRoles: recipe.mealRoles || [],
        toolIds: recipe.toolIds || []
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
    service.cookCheckin = () => toast();
    service.addMissingIngredientsToShopping = async (id) => {
      const recipe = service.getById(id);
      if (!recipe) return false;
      const shopping = window.BentoService?.shopping;
      if (!shopping?.add) return toast();
      const pantry = window.BentoService?.pantry?.data || [];
      const missing = (recipe.ingredients || []).filter(
        (ing) => !pantry.some((p) => p.name.includes(ing.pantryKeyword || ing.name) || ing.name.includes(p.name))
      );
      if (!missing.length) {
        toast('菜谱食材均已在库，无需补货', 'success');
        return recipe;
      }
      const items = missing.map((ing) => {
        const amount = String(ing.amount ?? '').trim();
        if (!parseShoppingAmount(amount))
          throw new ApiError(
            422,
            'SHOPPING_AMOUNT_UNSUPPORTED',
            `食材「${ing.name}」的数量单位无法映射到采购单位，无法加入清单`
          );
        return { name: `${ing.name} (${amount})`, amount, isChecked: false, source: `菜谱: ${recipe.name}` };
      });
      for (const item of items) await shopping.add(item, false);
      window.BentoModal?.open('recipeDetail', id);
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
    service.consume = () => toast();
    service.addToShopping = async (id) => {
      const item = service.getById(id);
      if (!item) return;
      const shopping = window.BentoService?.shopping;
      if (!shopping?.add) return toast();
      await shopping.add(
        {
          name: `${item.name} (手动补货)`,
          amount: `1${item.unit || ''}`,
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
  function replaceShoppingService(service) {
    let list = null;
    let listSeq = 0;
    let ensuring = null;
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
    service.add = async (item, notify = true) => {
      const name = String(item?.name ?? '').trim();
      if (!name) throw new ApiError(422, 'SHOPPING_ITEM_INVALID', '采购物品名称不能为空');
      const parsed = parseShoppingAmount(item.amount);
      if (!parsed)
        throw new ApiError(422, 'SHOPPING_AMOUNT_UNSUPPORTED', '采购数量/单位无法映射到后端单位，无法加入清单');
      const current = await ensureList();
      const sourceType = typeof item.source === 'string' && item.source.startsWith('菜谱:') ? 'RECIPE' : 'MANUAL';
      const dto = await ApiClient.post(`/shopping-lists/${encodeURIComponent(current.id)}/items`, {
        version: current.version,
        ingredientName: name,
        quantity: parsed.quantity,
        unit: parsed.unit,
        sourceType,
        sourceId: null,
        completed: !!item.isChecked
      });
      applyList(dto);
      if (notify !== false) toast(`已将「${name}」加入购物清单！`, 'success');
      return dto;
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
    service.importCheckedToPantry = async () => {
      const checked = (list ? service.data : []).filter((x) => x.isChecked);
      if (!checked.length) {
        toast('请先勾选已采购的物品再入库', 'error');
        return false;
      }
      for (const item of checked) {
        if (item.ingredientId) continue;
        const unit = BACKEND_UNITS.has(item.unitKey) ? item.unitKey : null;
        if (!unit) throw new ApiError(422, 'SHOPPING_UNIT_UNSUPPORTED', '采购项计量单位无法映射到后端单位，无法入库');
        const name = item.name.replace(/\(.*\)/, '').trim() || item.name.trim();
        await ApiClient.post('/ingredients', {
          name,
          imagePath: null,
          category: null,
          unit,
          minStock: null,
          maxStock: null,
          notes: null,
          batches: [
            {
              quantity: item.quantity,
              unit,
              purchaseDate: null,
              expiryDate: null,
              location: null,
              opened: false,
              consumePriority: false,
              notes: null
            }
          ]
        });
      }
      for (const item of checked) {
        applyList(
          await ApiClient.put(`/shopping-list-items/${encodeURIComponent(item.id)}`, {
            version: list.version,
            completed: true
          })
        );
      }
      const cleared = await ApiClient.post(`/shopping-lists/${encodeURIComponent(list.id)}/clear-completed`, {
        version: list.version
      });
      applyList(cleared.list);
      toast(`已将 ${checked.length} 件采购食材入库冰箱`, 'success');
      return true;
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
    service.uncheckin = () => toast();
    service.toggleCheckin = async (id) => {
      const item = service.getById(id);
      if (!item) return;
      if (item.isCompleted) return service.uncheckin(id);
      return service.checkin(id);
    };
    return reload;
  }
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
    const recordMealType = (slot) => {
      const mealType = toBackendMealType(slot);
      if (!mealType) throw new ApiError(422, 'RECORD_MEAL_TYPE_UNSUPPORTED', '餐次无法映射到后端枚举，无法保存');
      return mealType;
    };
    const recordSourceType = (type) => {
      const sourceType = SOURCE_TYPE_TO_BACKEND[type];
      if (!sourceType)
        throw new ApiError(422, 'RECORD_SOURCE_TYPE_UNSUPPORTED', '就餐类型无法映射到后端枚举，无法保存');
      return sourceType;
    };
    const rejectExtraFields = (rec) => {
      if (
        [rec.calories, rec.cost, rec.satiety].some(
          (value) => value !== undefined && value !== null && String(value).trim() !== ''
        )
      )
        throw new ApiError(
          422,
          'RECORD_EXTRA_FIELDS_UNSUPPORTED',
          '后端饮食记录不支持卡路里/花费/饱腹度字段，请清空后保存'
        );
    };
    service.getAll = () => service.data;
    service.getById = (id) => service.data.find((x) => x.id === id);
    service.reload = reload;
    service.add = async (rec) => {
      rejectExtraFields(rec);
      const body = {
        recordDate: rec.date || localDateKey(0),
        mealType: recordMealType(rec.slot),
        sourceType: recordSourceType(rec.type),
        rating: typeof rec.rating === 'number' ? rec.rating : null,
        notes: rec.notes || null,
        imagePath: (rec.photos || [])[0] || null,
        items: [{ itemType: 'CUSTOM', customName: rec.title || '就餐记录', sortOrder: 0 }]
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
      rejectExtraFields({ ...existing, ...updates });
      const body = { version: existing.version };
      if (updates.slot) body.mealType = recordMealType(updates.slot);
      if (updates.type) body.sourceType = recordSourceType(updates.type);
      if (updates.title !== undefined)
        body.items = [{ itemType: 'CUSTOM', customName: updates.title || existing.title || '就餐记录', sortOrder: 0 }];
      if (updates.rating !== undefined) body.rating = typeof updates.rating === 'number' ? updates.rating : null;
      if (updates.notes !== undefined) body.notes = updates.notes || null;
      if (updates.photos && updates.photos.length) body.imagePath = updates.photos[0];
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
      imagePath: null,
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
      'weeklyStat-consumedIngredientCount'
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
    setBinding('weeklyStat-averageRating', stats.averageRating ?? '');
    setBinding('weeklyStat-consumedIngredientCount', stats.consumedIngredientCount ?? '');
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
      row.onclick = () => window.BentoModal?.open('dailyDiary', value.date);
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
          value.expireDaysLeft == null ? '' : `${value.expireDaysLeft}天后到期`,
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
  async function loadSettings() {
    return ApiClient.get('/settings');
  }
  async function exportBackup(button) {
    button.disabled = true;
    try {
      const response = await fetch(`${API_BASE}/backups/export`, {
        headers: { 'X-App-Pin-Token': localStorage.getItem(PIN_KEY) || '' }
      });
      if (!response.ok)
        throw new ApiError(response.status, 'BACKUP_EXPORT_FAILED', `备份导出失败（${response.status}）`);
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(await response.blob());
      anchor.download = 'dafan-backup.zip';
      anchor.click();
      URL.revokeObjectURL(anchor.href);
      toast('备份下载已开始', 'success');
    } catch (error) {
      fail(error);
    } finally {
      button.disabled = false;
    }
  }
  async function wireSettings() {
    await loadSettings();
    document.querySelectorAll('#page-settings button').forEach((button) => {
      const owner = button.parentElement?.parentElement;
      const isBackup = /数据备份|下载|备份/.test(`${owner?.textContent || ''}${button.textContent || ''}`);
      button.removeAttribute('onclick');
      if (isBackup && !button.dataset.backupBound) {
        button.dataset.backupBound = 'true';
        button.addEventListener('click', () => exportBackup(button));
      }
    });
  }
  function blockUnconnectedWrites() {
    const service = window.BentoService;
    if (!service) return;
    const methods = {
      pantry: ['save', 'consume', 'delete'],
      plans: ['uncheckin'],
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
  function withSubmitGuard(event, task) {
    const button = event.submitter || event.currentTarget?.querySelector?.('button[type="submit"]');
    if (button?.dataset.submitting === 'true') return Promise.resolve(false);
    if (button) {
      button.dataset.submitting = 'true';
      button.disabled = true;
    }
    return Promise.resolve()
      .then(task)
      .finally(() => {
        if (button) {
          button.dataset.submitting = 'false';
          button.disabled = false;
        }
      });
  }
  function wireLegacyEntryPoints() {
    const modal = window.BentoModal;
    if (!modal || typeof modal.open !== 'function' || modal.__google2Wired) return;
    const originalOpen = modal.open.bind(modal);
    modal.open = async (name, payload = null, opener = null) => {
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
        } catch (error) {
          fail(error);
          return false;
        }
      }
      return opener == null ? originalOpen(name, payload) : originalOpen(name, payload, opener);
    };
    if (modal.handleRecipeFormSubmit)
      modal.handleRecipeFormSubmit = (event) =>
        withSubmitGuard(event, async () => {
          event.preventDefault();
          const id = document.getElementById('formRecipeId')?.value.trim() || '';
          const existing = id ? modalRecipeService().getById(id) : null;
          const calories = document.getElementById('formRecipeCalories')?.value.trim() || '';
          if (calories)
            throw new ApiError(422, 'RECIPE_CALORIES_UNSUPPORTED', '后端菜谱不支持 calories 字段，无法保存');
          return modalRecipeService().save({
            id: id || undefined,
            version: existing?.version,
            name: document.getElementById('formRecipeName')?.value.trim() || '',
            category: document.getElementById('formRecipeCategory')?.value || '',
            cookingTimeMinutes: Number(document.getElementById('formRecipeTime')?.value) || null,
            difficulty: document.getElementById('formRecipeDifficulty')?.value || null,
            imagePath: existing?.imagePath ?? null,
            spicyLevel: existing?.spicyLevel ?? null,
            servings: existing?.servings ?? null,
            sourceNote: existing?.sourceNote ?? null,
            notes: existing?.notes ?? null,
            enabledForRecommendation: existing?.enabledForRecommendation ?? true,
            ingredients: (() => {
              const rows = Array.from(document.querySelectorAll('#formRecipeIngList .recipe-ing-row'));
              if (!rows.length) return existing?.ingredients || [];
              return rows
                .map((row, index) => {
                  const name = row.querySelector('.recipe-ing-name')?.value.trim() || '';
                  const amount = row.querySelector('.recipe-ing-amount')?.value.trim() || '';
                  const match = amount.match(/^([0-9]+(?:\\.[0-9]+)?)\\s*(.*)$/);
                  const old = existing?.ingredients?.[index];
                  return {
                    ingredientId: old?.ingredientId ?? null,
                    name,
                    quantity: match ? Number(match[1]) : (old?.quantity ?? null),
                    unit: match ? match[2] || null : (old?.unit ?? null),
                    optional: !!old?.optional,
                    isPrimary: !!old?.isPrimary
                  };
                })
                .filter((item) => item.name);
            })(),
            steps: (() => {
              const rows = Array.from(document.querySelectorAll('#formRecipeStepList .recipe-step-row'));
              if (!rows.length) return existing?.steps || [];
              return rows
                .map((row, index) => {
                  const title = row.querySelector('.recipe-step-title')?.value.trim() || '';
                  const content = row.querySelector('.recipe-step-desc')?.value.trim() || title;
                  const old = existing?.steps?.[index];
                  return { content, imagePath: old?.imagePath || null };
                })
                .filter((item) => item.content);
            })(),
            tags: existing?.tags || [],
            mealTypes: existing?.mealTypes || [],
            mealRoles: existing?.mealRoles || [],
            toolIds: existing?.toolIds || [],
            favorite: existing?.favorite || false
          });
        }).catch(fail);
    if (modal.handleStoreFormSubmit)
      modal.handleStoreFormSubmit = (event) =>
        withSubmitGuard(event, async () => {
          event.preventDefault();
          const id = document.getElementById('formStoreId')?.value.trim() || '';
          const existing = id ? window.BentoService.stores.getById(id) : null;
          return window.BentoService.stores.save({
            id: id || undefined,
            version: existing?.version,
            name: document.getElementById('formStoreName')?.value.trim() || '',
            category: document.getElementById('formStoreCategory')?.value || '',
            price: Number(document.getElementById('formStorePrice')?.value) || null,
            phone: document.getElementById('formStorePhone')?.value.trim() || null,
            hours: document.getElementById('formStoreHours')?.value.trim() || null,
            address: document.getElementById('formStoreAddress')?.value.trim() || null,
            supportsDineIn: !!document.getElementById('formStoreDineIn')?.checked,
            supportsTakeout: !!document.getElementById('formStoreTakeout')?.checked,
            notes: document.getElementById('formStoreNotes')?.value.trim() || null,
            favorite: existing?.favorite || false
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
          const payload = {
            date:
              document.getElementById('planPickerDateVal')?.value ||
              document.getElementById('planPickerCustomDate')?.value ||
              '',
            slot: document.getElementById('planPickerSlotVal')?.value || '午餐',
            targetType: parts[0] === 'store' ? 'store' : parts[0] === 'recipe' ? 'recipe' : '',
            targetId: parts[1] || ''
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
          const payload = {
            slot: document.getElementById('formRecordSlot')?.value || '',
            type: document.getElementById('formRecordType')?.value || '',
            title: document.getElementById('formRecordTitle')?.value.trim() || '',
            calories: document.getElementById('formRecordCalories')?.value.trim() || '',
            cost: document.getElementById('formRecordCost')?.value.trim() || '',
            satiety: document.getElementById('formRecordSatiety')?.value.trim() || '',
            rating: Number(document.getElementById('formRecordRating')?.value) || null,
            notes: document.getElementById('formRecordNotes')?.value.trim() || '',
            photos: [0, 1, 2]
              .map((slot) =>
                document.getElementById(`photoSlotView-${slot}`)?.querySelector('img')?.getAttribute('src')
              )
              .filter(Boolean)
          };
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
  }
  function modalRecipeService() {
    return window.BentoService.recipes;
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
    wireLegacyEntryPoints();
    loadStores().catch(fail);
    loadRecipes().catch(fail);
    loadShopping?.().catch(fail);
    loadPantry?.().catch(fail);
    loadPlans?.().catch(fail);
    loadRecords?.().catch(fail);
    loadTools?.().catch(fail);
  }
  function boot() {
    clearMockState();
    blockUnconnectedWrites();
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
    const pick = (payload?.results || [])[0];
    if (!pick) {
      toast('暂无符合条件的真实推荐结果，稍后再试', 'info');
      return null;
    }
    const expectedType = pick.resultType === 'STORE' ? 'store' : 'recipe';
    let index = items.findIndex((item) => item && item.type === expectedType && item.id === pick.resultId);
    if (index >= 0) return index;
    // 真实推荐结果不在当前扇区时，将其映射进当前候选扇区（替换最后一个扇区，扇区数与设计不变）
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
  window.DafanDashboardAdapter = { mapDashboard, loadDashboard };
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

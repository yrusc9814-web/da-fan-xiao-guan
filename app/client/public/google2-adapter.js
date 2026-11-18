(() => {
  'use strict';
  const API_BASE = '/api/v1';
  const LEGACY_PIN_KEY = 'dafan-pin-token';
  const PIN_KEY = 'dafan_google2_pin_token';
  function readPinToken() {
    const token = localStorage.getItem(PIN_KEY);
    const legacyToken = localStorage.getItem(LEGACY_PIN_KEY);
    if (legacyToken !== null) {
      if (!token && legacyToken) localStorage.setItem(PIN_KEY, legacyToken);
      localStorage.removeItem(LEGACY_PIN_KEY);
    }
    return token || legacyToken;
  }
  function storePinToken(token) {
    localStorage.setItem(PIN_KEY, token);
    localStorage.removeItem(LEGACY_PIN_KEY);
  }
  function clearPinToken() {
    localStorage.removeItem(PIN_KEY);
    localStorage.removeItem(LEGACY_PIN_KEY);
  }
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
    '/settings/pin',
    '/settings/pin/verify',
    '/settings/pin/session',
    '/settings/high-risk/authorize',
    '/backups/restore'
  ];
  let pinUnlockPromise = null;
  let pinUnlockResolve = null;
  let pinUnlockReject = null;
  let pinUnlockVerifying = false;
  // 每次创建/取消解锁会话都递增代次：在途 verify 只对自己发起时的代次生效，
  // 过期响应不得写 token、关闭新弹窗、改新弹窗错误或重置新请求的在途锁
  let pinUnlockGeneration = 0;
  // 冷却截止时间在模块级共享：取消/关闭弹窗都不能绕过 429 冷却
  let pinCooldownUntil = 0;
  let pinCooldownTimer = null;
  let pinSettingsMode = null;
  let pinSettingsRequestToken = 0;
  let pinSettingsPending = false;
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
  function pinCooldownSeconds() {
    const remaining = pinCooldownUntil - Date.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }
  function stopPinCooldownTimer() {
    if (pinCooldownTimer) {
      clearInterval(pinCooldownTimer);
      pinCooldownTimer = null;
    }
  }
  /** 冷却状态只由服务端 429 决定，取消/关闭弹窗都不清零，重开窗口会继续倒计时。 */
  function renderPinCooldown() {
    const remaining = pinCooldownSeconds();
    if (remaining <= 0) {
      pinCooldownUntil = 0;
      stopPinCooldownTimer();
      return 0;
    }
    const dialog = pinDialog();
    if (dialog.submit) dialog.submit.disabled = true;
    if (dialog.root && !dialog.root.classList.contains('hidden'))
      setPinDialogError(`尝试次数过多，请 ${remaining} 秒后再试`);
    const settings = pinSettingsDialog();
    if (settings.submit) settings.submit.disabled = true;
    if (settings.root && !settings.root.classList.contains('hidden'))
      setPinSettingsError(`尝试次数过多，请 ${remaining} 秒后再试`);
    if (!pinCooldownTimer) {
      pinCooldownTimer = setInterval(() => {
        if (pinCooldownSeconds() > 0) {
          renderPinCooldown();
          return;
        }
        pinCooldownUntil = 0;
        stopPinCooldownTimer();
        const unlock = pinDialog();
        if (unlock.submit && !pinUnlockVerifying) unlock.submit.disabled = false;
        if (unlock.root && !unlock.root.classList.contains('hidden')) setPinDialogError('可以再次尝试验证');
        const modal = pinSettingsDialog();
        if (modal.submit && !pinSettingsPending) modal.submit.disabled = false;
        if (modal.root && !modal.root.classList.contains('hidden')) setPinSettingsError('可以再次尝试验证');
      }, 1000);
    }
    return remaining;
  }
  function startPinCooldown(error) {
    const fromDetails = Number(error?.details?.retryAfter);
    const fromHeader = Number(error?.retryAfter);
    const seconds =
      Math.max(
        Number.isFinite(fromDetails) && fromDetails > 0 ? fromDetails : 0,
        Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 0
      ) || 30;
    pinCooldownUntil = Date.now() + seconds * 1000;
    renderPinCooldown();
  }
  function closePinUnlockDialog() {
    const { root, input } = pinDialog();
    root?.classList.add('hidden');
    if (input) input.value = '';
    // 不在这里停冷却计时器：settings 弹窗可能同时展示同一冷却；计时器到期会自行清理
    const remaining = pinCooldownSeconds();
    setPinDialogError(remaining > 0 ? `尝试次数过多，请 ${remaining} 秒后再试` : '');
  }
  function pinUnlockStale(generation) {
    return generation !== pinUnlockGeneration;
  }
  function finishPinUnlock(token, generation) {
    if (!token || !pinUnlockResolve || pinUnlockStale(generation)) return;
    storePinToken(token);
    const resolve = pinUnlockResolve;
    pinUnlockPromise = pinUnlockResolve = pinUnlockReject = null;
    pinUnlockVerifying = false;
    closePinUnlockDialog();
    resolve(token);
  }
  function cancelPinUnlock() {
    if (!pinUnlockReject) return;
    const reject = pinUnlockReject;
    // 取消即换代：取消时仍在途的 verify 响应属于旧会话，不得落到之后重开的弹窗
    pinUnlockGeneration += 1;
    pinUnlockPromise = pinUnlockResolve = pinUnlockReject = null;
    pinUnlockVerifying = false;
    closePinUnlockDialog();
    reject(pinUnlockError());
  }
  async function verifyPinFromDialog() {
    if (pinUnlockVerifying) return;
    const { input, submit } = pinDialog();
    const pin = input?.value || '';
    if (renderPinCooldown()) return;
    if (!/^\d{4,8}$/.test(pin)) {
      setPinDialogError('请输入 4～8 位数字 PIN');
      input?.focus();
      return;
    }
    // 本次提交只属于自己的解锁会话：取消/重开会让代次前进，过期响应一律丢弃
    const generation = pinUnlockGeneration;
    pinUnlockVerifying = true;
    if (submit) submit.disabled = true;
    setPinDialogError('正在验证…');
    try {
      const result = await request('/settings/pin/verify', {
        method: 'POST',
        body: JSON.stringify({ pin }),
        _pinRetried: true
      });
      // 弹窗可能在请求期间被取消/重开：此时丢弃结果，不写 token、不关新弹窗
      if (pinUnlockStale(generation) || !pinUnlockResolve) return;
      if (result?.valid !== true || typeof result.token !== 'string' || !result.token) {
        setPinDialogError(result?.required === true ? 'PIN 不正确，请重试' : '当前未启用 PIN，请刷新后重试');
        if (input) input.value = '';
        return;
      }
      finishPinUnlock(result.token, generation);
    } catch (error) {
      // 429 是服务端按 IP 的真实冷却：即使响应已过期也要落到共享 deadline，避免提前重试；
      // 但过期响应不得改新弹窗的错误提示与在途锁
      if (error?.status === 429 && error?.code === 'PIN_ATTEMPTS_EXCEEDED') startPinCooldown(error);
      if (pinUnlockStale(generation)) return;
      if (!(error?.status === 429 && error?.code === 'PIN_ATTEMPTS_EXCEEDED'))
        setPinDialogError('PIN 验证失败，请稍后重试');
    } finally {
      // 过期请求不得重置新会话的 verifying，否则会放开按钮造成并发提交
      if (!pinUnlockStale(generation)) {
        pinUnlockVerifying = false;
        const dialog = pinDialog();
        if (dialog.submit && !dialog.root?.classList.contains('hidden') && pinCooldownSeconds() <= 0)
          dialog.submit.disabled = false;
      }
    }
  }
  function ensurePinUnlock() {
    if (pinUnlockPromise) return pinUnlockPromise;
    // 新会话换代：此前任何在途 verify 都变为过期响应
    pinUnlockGeneration += 1;
    pinUnlockPromise = new Promise((resolve, reject) => {
      pinUnlockResolve = resolve;
      pinUnlockReject = reject;
      pinUnlockVerifying = false;
      const { root, form, input, cancel, submit } = pinDialog();
      if (!root || !form || !input) {
        pinUnlockPromise = pinUnlockResolve = pinUnlockReject = null;
        reject(pinUnlockError('PIN 解锁界面不可用'));
        return;
      }
      root.classList.remove('hidden');
      input.value = '';
      setPinDialogError('');
      // 已生效的 429 冷却不会被取消/重开绕过
      const coolingDown = renderPinCooldown() > 0;
      if (submit && !coolingDown) submit.disabled = false;
      if (!form.dataset.pinUnlockBound) {
        form.dataset.pinUnlockBound = 'true';
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          void verifyPinFromDialog();
        });
      }
      if (cancel && !cancel.dataset.pinUnlockBound) {
        cancel.dataset.pinUnlockBound = 'true';
        cancel.addEventListener('click', cancelPinUnlock);
      }
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
    const token = readPinToken();
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
    const token = readPinToken();
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
  // ---------------------------------------------------------------------------
  // 【菜谱封面与纯文本图标解耦】
  // 只有受控 /uploads/ 图片路径才允许进入 <img src>；历史裸占位文件名（如 steamed-fish.png）
  // 与任意注入载荷一律降级为纯文本 Emoji，绝不把原值写进 src 或事件属性。
  // ---------------------------------------------------------------------------
  function isSafeUploadedCoverUrl(value) {
    if (typeof value !== 'string') return false;
    if (value.includes('..') || value.includes('\\')) return false;
    // 与 safeImageSource 保持一致：拒绝协议相对地址（//）与含当前目录段（/./）的路径
    if (value.includes('//') || value.includes('/./')) return false;
    return /^\/uploads\/[A-Za-z0-9._/-]+\.(?:jpe?g|png|webp)$/i.test(value);
  }
  function isLegacyPlaceholderImageFilename(value) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!text || text.startsWith('/uploads/')) return false;
    // 历史脏数据是「裸文件名」（steamed-fish.png / shrimp.png），不含任何路径分隔符；
    // 带目录的相对路径（如 /cover.jpg）不属于本类，未触碰时原样保留，避免误清真实旧值。
    // 任务原始建议的字符类含 `/`，此处收窄为不含 `/`：既有 adapter 契约测试要求未触碰的
    // '/cover.jpg' 原样提交（google2-adapter.test.ts），且带目录路径已被 isImageLikePathText
    // 拦在纯文本槽位之外，不会以文件名形式外漏，故不影响 XSS/expectInert 断言强度。
    return /^[A-Za-z0-9._-]+\.(?:jpe?g|png|webp|gif|svg|bmp|ico)$/i.test(text);
  }
  /** 任意「像图片路径」的文本（含目录）都不得进入纯文本图标槽位。 */
  function isImageLikePathText(value) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!text) return false;
    return /^[A-Za-z0-9._/-]+\.(?:jpe?g|png|webp|gif|svg|bmp|ico)$/i.test(text);
  }
  const RECIPE_CATEGORY_ICONS = {
    快手家常: '🍳',
    暖胃炖菜: '🥘',
    清爽时蔬: '🥦',
    鲜美水产: '🐟',
    肉禽鲜香: '🥩',
    减脂轻食: '🥗',
    滋补靓汤: '🍲'
  };
  function recipeCategoryIcon(category) {
    const key = typeof category === 'string' ? category.trim() : '';
    return RECIPE_CATEGORY_ICONS[key] || '🥘';
  }
  // ---------------------------------------------------------------------------
  // 【冰箱食材 7 大分类与图标派生（T-006B）】
  // 后端 Ingredient 没有 icon 字段（只有 imagePath，无 migration）：显式 Emoji 图标按既有
  // imagePath 协议原样存储，/uploads/ 上传封面继续保留；读取时按
  // 「显式合法 Emoji → 名称关键词 → 7 大分类默认图标」派生，历史空/旧分类按名称兜底。
  // ---------------------------------------------------------------------------
  const INGREDIENT_CATEGORIES = ['蔬菜', '肉禽', '水产', '蛋奶豆制', '主食粮油', '调味', '其他'];
  const INGREDIENT_CATEGORY_ICONS = {
    蔬菜: '🥬',
    肉禽: '🥩',
    水产: '🐟',
    蛋奶豆制: '🥚',
    主食粮油: '🍚',
    调味: '🧂',
    其他: '📦'
  };
  // 与后端 app/server/src/modules/ingredients/categories.ts 的 LEGACY_CATEGORY_MAP 保持一致
  const LEGACY_INGREDIENT_CATEGORY = {
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
  // 顺序即优先级：调味词必须排在蔬菜「椒」之前，与后端 NAME_RULES 一致
  const INGREDIENT_NAME_RULES = [
    ['其他', ['牛油果', '苹果', '香蕉', '葡萄', '橙', '柚', '水果']],
    [
      '调味',
      ['盐', '糖', '酱', '醋', '料酒', '蚝油', '胡椒', '花椒', '味精', '鸡精', '香料', '调味', '葱', '姜', '蒜']
    ],
    ['蔬菜', ['土豆', '玉米', '毛豆', '豌豆', '豆角', '四季豆', '黄豆芽', '绿豆芽']],
    ['蛋奶豆制', ['蛋', '奶', '乳', '豆腐', '豆浆', '豆干', '腐竹', '奶酪', '黄油', '酸奶', '豆']],
    ['水产', ['虾', '蟹', '鱼', '贝', '蛤', '鱿', '鲍', '海参', '海带', '紫菜', '花甲']],
    ['肉禽', ['排骨', '猪', '牛', '羊', '鸡', '鸭', '鹅', '火腿', '香肠', '培根', '肉']],
    ['主食粮油', ['大米', '糯米', '米', '面', '粉', '馒头', '燕麦', '杂粮', '挂面', '面包', '食用油', '淀粉']],
    ['蔬菜', ['菜', '瓜', '茄', '菇', '菌', '笋', '萝卜', '椒', '番茄', '西红柿']]
  ];
  const INGREDIENT_NAME_ICONS = [
    [/牛油果|苹果|香蕉|梨|桃|葡萄|橙|水果/, '🍎'],
    [/盐|糖|酱|醋|胡椒|花椒|鸡精|味精|调味/, '🧂'],
    [/蛋/, '🥚'],
    [/奶|乳/, '🥛'],
    [/玉米/, '🌽'],
    [/土豆/, '🥔'],
    [/豆角|四季豆|毛豆|豌豆|豆芽/, '🥬'],
    [/虾|蟹/, '🦐'],
    [/鱼/, '🐟'],
    [/排骨|猪|牛|羊|肉/, '🥩'],
    [/鸡|鸭/, '🍗'],
    [/豆腐|豆/, '🧈'],
    [/米|面|粉/, '🍚'],
    [/胡萝卜/, '🥕'],
    [/香菇|菇|菌/, '🍄'],
    [/黄瓜/, '🥒'],
    [/番茄|西红柿/, '🍅'],
    [/生菜|青菜|西兰花|菜/, '🥬'],
    [/油|椒|葱|姜|蒜/, '🧂']
  ];
  function inferIngredientCategoryByName(name) {
    const text = name == null ? '' : String(name).trim();
    if (!text) return null;
    for (const [category, keywords] of INGREDIENT_NAME_RULES) {
      if (keywords.some((keyword) => text.includes(keyword))) return category;
    }
    return null;
  }
  /** 分类归一：标准 7 类原样；旧名映射；否则按名称推断，最终兜底「其他」。 */
  function normalizeIngredientCategory(value, name) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (INGREDIENT_CATEGORIES.includes(text)) return text;
    const mapped = LEGACY_INGREDIENT_CATEGORY[text];
    if (mapped) return mapped;
    return inferIngredientCategoryByName(name) || inferIngredientCategoryByName(text) || '其他';
  }
  let ingredientEmojiPattern = null;
  /** 显式图标合法性：单个（含组合）Emoji；文件名/路径/HTML 特殊字符一律不合法。 */
  function isIngredientEmoji(value) {
    const text = value == null ? '' : String(value).trim();
    if (!text || text.length > 8) return false;
    if (/^[A-Za-z0-9./_\\-]+$/.test(text)) return false;
    if (/[<>"'`&\s]/.test(text)) return false;
    if (!ingredientEmojiPattern) {
      try {
        ingredientEmojiPattern = new RegExp(
          '^\\p{Extended_Pictographic}(?:\\uFE0F|\\u200D\\p{Extended_Pictographic}|[\\u{1F3FB}-\\u{1F3FF}])*$',
          'u'
        );
      } catch {
        // 无 Unicode property escapes 时按码点范围判断（不写代理对字符类，避免 no-misleading-character-class）
        ingredientEmojiPattern = false;
      }
    }
    if (ingredientEmojiPattern) return ingredientEmojiPattern.test(text);
    return Array.from(text).every((char) => {
      const code = char.codePointAt(0);
      return (
        (code >= 0x2600 && code <= 0x27bf) ||
        (code >= 0x2b00 && code <= 0x2bff) ||
        (code >= 0x1f000 && code <= 0x1faff) ||
        code === 0xfe0f ||
        code === 0x200d
      );
    });
  }
  /** 读取侧图标派生：显式合法 Emoji → 名称关键词 → 分类默认图标。 */
  function deriveIngredientIcon(icon, category, name) {
    const explicit = icon == null ? '' : String(icon).trim();
    if (isIngredientEmoji(explicit)) return explicit;
    const text = name == null ? '' : String(name).trim();
    for (const [pattern, emoji] of INGREDIENT_NAME_ICONS) {
      if (pattern.test(text)) return emoji;
    }
    return INGREDIENT_CATEGORY_ICONS[normalizeIngredientCategory(category, name)];
  }
  /** 写入侧协议：Emoji 与受控 /uploads/ 路径原样写入 imagePath；其余清空。 */
  function ingredientImagePath(item) {
    const icon = item?.icon == null ? '' : String(item.icon).trim();
    if (isSafeUploadedCoverUrl(icon)) return icon;
    if (isIngredientEmoji(icon)) return icon;
    const original = item?.imagePath == null ? '' : String(item.imagePath).trim();
    if (isSafeUploadedCoverUrl(original) || isIngredientEmoji(original)) return original;
    return null;
  }
  /** 纯文本/图标槽位：上传路径与历史占位文件名绝不外漏，其余文本（含注入载荷）原样作为纯文本。 */
  function textIcon(value, fallback) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return fallback;
    if (isImageLikePathText(text)) return fallback;
    return text;
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
      // 纯文本图标槽位：/uploads/... 与历史裸文件名不参与文本渲染
      icon: textIcon(s.imagePath, '🍱'),
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
    const category = normalizeIngredientCategory(i.category, i.name);
    return {
      ...i,
      unitKey: i.unit,
      unit: UNIT_LABELS[i.unit] ?? (i.unit || ''),
      // 7 大分类归一：历史空/旧分类按名称兜底，保证「全部(N)」恒等于各分类计数之和
      category,
      // 图标派生：显式 Emoji → 名称关键词 → 分类默认；历史裸文件名/上传路径绝不当文本渲染
      explicitIcon: isIngredientEmoji(i.imagePath) ? String(i.imagePath).trim() : null,
      icon: deriveIngredientIcon(i.imagePath, category, i.name),
      imagePath: isSafeUploadedCoverUrl(i.imagePath) ? i.imagePath : null,
      minStock: i.minStock ?? null,
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
      category: normalizeIngredientCategory(item.category, item.ingredientNameSnapshot),
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
      // 封面与图标解耦：coverUrl 只接受受控 /uploads/ 路径；icon 永远是纯文本 Emoji
      coverUrl: isSafeUploadedCoverUrl(r.imagePath) ? r.imagePath : null,
      icon: textIcon(r.imagePath, recipeCategoryIcon(r.category)),
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
        coverUrl: isSafeUploadedCoverUrl(item.recipe.imagePath) ? item.recipe.imagePath : null,
        icon: textIcon(item.recipe.imagePath, '🥘')
      };
    if (item?.itemType === 'STORE' && item.store) {
      const channel = item.store.supportsTakeout === false && item.store.supportsDineIn ? 'dinein' : 'takeout';
      return {
        targetType: 'store',
        channel,
        type: channel,
        targetId: item.store.id,
        title: item.store.name || '',
        coverUrl: isSafeUploadedCoverUrl(item.store.imagePath) ? item.store.imagePath : null,
        icon: textIcon(item.store.imagePath, channel === 'dinein' ? '🍽️' : '🛵')
      };
    }
    return {
      targetType: 'custom',
      channel: 'cook',
      type: 'cook',
      targetId: '',
      title: item?.customName || '',
      coverUrl: null,
      icon: '🍱'
    };
  }
  function mapPlan(p) {
    const item = (p.items || [])[0];
    const target = mapPlanItemTarget(item);
    const targetImagePath = item?.recipe?.imagePath ?? item?.store?.imagePath;
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
      // 计划自带 icon 为 null 时保持 null（后端 nullable 契约）；但目标是历史裸占位文件名
      // （steamed-fish.png 等）时用目标推导的干净 Emoji 兜底，绝不把文件名字符串当图标
      icon: p.icon == null && isLegacyPlaceholderImageFilename(targetImagePath) ? target.icon : textIcon(p.icon, null),
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
      // 记录状态只归一为后端既定两态：仅显式 DRAFT 视为草稿，其余按后端默认 CONFIRMED 处理。
      // isDraft 供视图层直接判断，不再自行猜测 status 大小写或缺失。
      status: r.status === 'DRAFT' ? 'DRAFT' : 'CONFIRMED',
      isDraft: r.status === 'DRAFT',
      // 计划关联关系：sourceMealPlanId（唯一来源）与 relatedPlanId（兼容旧关联）都保留，刷新后仍可追溯
      sourceMealPlanId: r.sourceMealPlanId ?? null,
      relatedPlanId: r.relatedPlanId ?? null,
      confirmedAt: r.confirmedAt ?? null,
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
      emit('favorites:changed');
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
      emit('favorites:changed');
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
    service.save = async (recipe, options) => {
      // 可选局部提交策略：默认（无 options）保持既有行为——成功即关闭弹窗并提示。
      // 菜谱表单传入 shouldClose/shouldNotify，由「本次提交是否仍拥有当前表单」在完成时求值，
      // 避免旧请求关闭用户已重开的新表单或把 toast 弹到新会话上。
      const policy = options && typeof options === 'object' ? options : null;
      const allowed = (name) => {
        const rule = policy ? policy[name] : undefined;
        if (typeof rule === 'function') return rule() !== false;
        if (typeof rule === 'boolean') return rule;
        return true;
      };
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
      // 写入已经到达服务端，不能假装取消；这里只控制后续 UI：不属于当前表单会话的请求不再关窗/提示。
      // 两个判断都在任何 UI 副作用之前求值：close 本身会重置表单会话，不能让它影响随后的 toast 判断。
      const closeOwned = allowed('shouldClose');
      const notifyOwned = allowed('shouldNotify');
      if (closeOwned) window.BentoModal?.close(true);
      if (notifyOwned) toast(recipe.id ? '菜谱已更新' : '菜谱已创建', 'success');
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
      // 收藏端点仅返回基础字段；保留已加载的配料/步骤等关系，响应中显式返回的值仍优先。
      const dto = await ApiClient.post(`/recipes/${encodeURIComponent(id)}/favorite`, {
        favorite: !item.favorite,
        version: item.version
      });
      const mapped = mapRecipe({ ...item, ...dto });
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
    /**
     * 到期日来源：编辑时用户可能只填「剩余天数」或「到期日期」，二者择一即可落库。
     * - 显式 expireDate / expiryDate 优先（真实日期字符串）
     * - 否则 expireDaysLeft 是相对今天的天数（允许 0 与负数 = 今日到期/已过期，不做 1..365 夹取）
     * - 都未提供时返回 undefined，编辑语义为「未修改」
     */
    const resolveExpiryDate = (item) => {
      const explicit = typeof item.expireDate === 'string' ? item.expireDate.trim() : '';
      const explicitIso = typeof item.expiryDate === 'string' ? item.expiryDate.trim() : '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
      if (/^\d{4}-\d{2}-\d{2}$/.test(explicitIso)) return explicitIso;
      if (item.expiryDate === null || item.expireDate === null) return null;
      const rawDays = item.expireDaysLeft;
      if (rawDays === undefined || rawDays === null || String(rawDays).trim() === '') return undefined;
      const days = Math.round(Number(rawDays));
      if (!Number.isFinite(days)) return undefined;
      return localDateKey(days);
    };
    const resolveMinStock = (value) => {
      if (value === undefined) return undefined;
      if (value === null || String(value).trim() === '') return null;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0)
        throw new ApiError(422, 'INGREDIENT_MIN_STOCK_INVALID', '最低库存必须是不小于 0 的数字');
      return number;
    };
    service.save = async (item) => {
      const unit = toBackendUnit(item.unitKey || item.unit);
      if (!unit) throw new ApiError(422, 'INGREDIENT_UNIT_UNSUPPORTED', '食材计量单位无法映射到后端单位，无法保存');
      const imagePath = ingredientImagePath(item);
      const category = item.category === undefined ? undefined : normalizeIngredientCategory(item.category, item.name);
      const minStock = resolveMinStock(item.minStock);
      if (item.id) {
        // 编辑：本地缓存可能尚无该条（旧 fixture/刚刷新），version 优先取调用方传入值
        const existing = service.getById(item.id);
        const version = Number(item.version ?? existing?.version);
        if (!Number.isInteger(version) || version < 1)
          throw new ApiError(409, 'INGREDIENT_VERSION_REQUIRED', '编辑食材缺少有效版本，请刷新后重试');
        const expiryDate = resolveExpiryDate(item);
        const location =
          item.storageLocation === undefined ? undefined : String(item.storageLocation ?? '').trim() || null;
        // 后端已支持 Ingredient PUT 的 quantity/purchaseDate/expiryDate/location/batches：
        // 数量与元数据同步进批次，不再抛 INGREDIENT_BATCHES_UNSUPPORTED。
        const body = {
          name: item.name,
          imagePath,
          category: category ?? null,
          unit,
          minStock,
          maxStock: item.maxStock ?? null,
          notes: item.notes || null,
          version
        };
        if (item.stock !== undefined && item.stock !== null && String(item.stock).trim() !== '') {
          const quantity = Number(item.stock);
          if (!Number.isFinite(quantity) || quantity < 0)
            throw new ApiError(422, 'INGREDIENT_QUANTITY_INVALID', '库存数量必须是不小于 0 的数字');
          body.quantity = quantity;
        }
        if (expiryDate !== undefined) body.expiryDate = expiryDate;
        if (location !== undefined) body.location = location;
        if (item.purchaseDate !== undefined) {
          const purchaseDate = String(item.purchaseDate ?? '').trim();
          body.purchaseDate = /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate) ? purchaseDate : null;
        }
        if (Array.isArray(item.batches) && item.batches.length) {
          // 批次编辑（后端已支持 Ingredient PUT batches）：逐条校验，缺单位/负数快速失败
          body.batches = item.batches.map((batch) => {
            const batchQuantity = Number(batch?.quantity);
            const batchUnit = toBackendUnit(batch?.unit);
            if (!Number.isFinite(batchQuantity) || batchQuantity < 0 || !batchUnit)
              throw new ApiError(422, 'INGREDIENT_BATCH_INVALID', '批次数量与单位不合法，无法保存');
            return { ...batch, quantity: batchQuantity, unit: batchUnit };
          });
        }
        const dto = await ApiClient.put(`/ingredients/${encodeURIComponent(item.id)}`, body);
        const mapped = mapPantryItem(dto);
        service.data = service.data.some((x) => x.id === mapped.id)
          ? service.data.map((x) => (x.id === mapped.id ? mapped : x))
          : [mapped, ...service.data];
        emit('pantry:changed');
        window.BentoModal?.close(true);
        toast('食材已更新', 'success');
        return mapped;
      }
      const expiryDate = resolveExpiryDate(item);
      const body = {
        name: item.name,
        imagePath,
        category: category ?? null,
        unit,
        minStock: minStock === undefined ? null : minStock,
        maxStock: item.maxStock ?? null,
        notes: item.notes || null,
        batches: [
          {
            quantity: Number(item.stock),
            unit,
            purchaseDate: /^\d{4}-\d{2}-\d{2}$/.test(String(item.purchaseDate ?? '').trim())
              ? String(item.purchaseDate).trim()
              : null,
            expiryDate: expiryDate === undefined ? null : expiryDate,
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
    /** 单位维度：质量 / 体积 / 计件（其余按计件）。快捷消耗按钮按它动态生成。 */
    const UNIT_DIMENSION = {
      GRAM: 'mass',
      KILOGRAM: 'mass',
      MILLILITER: 'volume',
      LITER: 'volume',
      PIECE: 'count',
      BOX: 'count',
      BAG: 'count',
      BOTTLE: 'count',
      CAN: 'count',
      PACK: 'count',
      PORTION: 'count',
      OTHER: 'count'
    };
    /**
     * 快捷消耗预设：质量 -100g/-250g，体积 -100ml/-250ml，计件 -1/-2 单位。
     * 返回 { label, quantity, unit }；unit 为后端枚举，label 为按钮文案。
     */
    const consumePresets = (item) => {
      const backendUnit = toBackendUnit(item?.unitKey || item?.unit);
      const dimension = UNIT_DIMENSION[backendUnit] || 'count';
      const unitLabel = UNIT_LABELS[backendUnit] ?? (item?.unit || '份');
      if (dimension === 'mass') {
        return [
          { label: '➖ 消耗 100g', quantity: 100, unit: 'GRAM' },
          { label: '➖ 消耗 250g', quantity: 250, unit: 'GRAM' }
        ];
      }
      if (dimension === 'volume') {
        return [
          { label: '➖ 消耗 100ml', quantity: 100, unit: 'MILLILITER' },
          { label: '➖ 消耗 250ml', quantity: 250, unit: 'MILLILITER' }
        ];
      }
      return [1, 2].map((quantity) => ({
        label: `➖ 消耗 ${quantity}${unitLabel || '份'}`,
        quantity,
        unit: backendUnit || 'PORTION'
      }));
    };
    service.consumePresets = consumePresets;
    /**
     * 消耗入参兼容旧调用：
     * - 'all' → 全部用完
     * - 数字 100/250 → 兼容旧按钮，按质量单位扣减
     * - { quantity, unit } → 按真实单位维度扣减（质量/体积/计件）
     */
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
        const preset = typeof amount === 'object' && amount !== null ? amount : { quantity: amount, unit: 'GRAM' };
        const quantity = Number(preset.quantity);
        const unit = toBackendUnit(preset.unit);
        // 只接受与食材同维度的标准单位：克食材不能按「个」扣减，未知单位不猜
        const itemUnit = toBackendUnit(item?.unitKey || item?.unit);
        if (!Number.isFinite(quantity) || quantity <= 0 || !unit)
          return Promise.reject(new ApiError(422, 'INGREDIENT_CONSUME_AMOUNT_INVALID', '扣减数量无效'));
        if (itemUnit && UNIT_DIMENSION[itemUnit] !== UNIT_DIMENSION[unit])
          return toast('扣减单位与食材单位维度不一致，请刷新后重试', 'error');
        body.quantity = quantity;
        body.unit = unit;
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
        const consumedLabel =
          mode === 'ALL' ? '已全部消耗该食材' : `已消耗 ${body.quantity}${UNIT_LABELS[body.unit] ?? ''}`;
        toast(consumedLabel, 'success');
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
      // 名称只传纯净食材名：绝不拼「(手动补货)」污染购物项名称（F-07）
      await shopping.add(
        {
          name: item.name,
          amount: hasUnit ? `1${item.unit}` : '适量',
          // 补货项带上归一后的 7 大分类（缺失时按名称/兜底推断），入库后分类不会丢
          category: normalizeIngredientCategory(item.category, item.name),
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
        if (!Number.isInteger(updates.sortOrder)) throw new ApiError(422, 'SHOPPING_ITEM_INVALID', '排序值必须是整数');
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
        if (pending.status === 'ok')
          return { status: 'replay', promise: checkinWith(pending.value.listId, pending.value.itemIds, pending.value) };
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
      // 编辑保留既有食用人数：只有显式提供合法非负整数时才覆盖（绝不硬写 1）
      dinerCount: (() => {
        const value = plan?.dinerCount;
        return Number.isInteger(value) && value >= 0 ? value : 1;
      })(),
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
    // 打卡结果提示必须与实际记录状态一致：DRAFT 是待确认草稿（不计入统计），
    // CONFIRMED 才是已确认用餐（幂等重复打卡不得再宣称“已生成”）。
    const checkinToast = (result) => {
      const status = result?.record?.status === 'DRAFT' ? 'DRAFT' : result?.record ? 'CONFIRMED' : null;
      if (status === 'DRAFT')
        return result.idempotent
          ? '打卡成功！已恢复待确认就餐草稿（确认后计入统计）'
          : '打卡成功！已生成待确认就餐草稿（确认后计入统计）';
      if (status === 'CONFIRMED')
        return result.idempotent ? '该计划已确认用餐，无需重复打卡' : '打卡成功！就餐记录已确认用餐';
      return '打卡成功！';
    };
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
      toast(checkinToast(result), 'success');
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
  // ---------------------------------------------------------------------------
  // 【菜谱自定义封面：选择 / 预览 / 替换 / 移除 / 上传闭环】
  // 世代号语义与 recordPhotoGenerations 一致：打开、重选、移除、关闭都递增代次；
  // 旧代次的上传结果不得写回新会话，更不得提交或关闭新弹窗。
  // ---------------------------------------------------------------------------
  const RECIPE_COVER_MAX_BYTES = 8 * 1024 * 1024;
  const RECIPE_COVER_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const RECIPE_COVER_HINT_TEXT = '点击上传成品美图（未上传时默认展示分类图标）';
  const recipeCoverState = {
    generation: 0,
    file: null,
    previewUrl: '',
    existingUrl: null,
    removed: false,
    uploadCache: null
  };
  /**
   * 菜谱表单提交会话：每次打开/关闭菜谱表单都换成新对象。
   * 与封面代次（generation）职责不同：generation 管「选图/上传结果是否还属于当前封面」，
   * 会话对象管「这次提交是否还拥有当前表单」——旧会话的在途提交不得关闭新表单、
   * 不得弹 toast，也不得用 submitGuard 的 pending 阻塞新会话提交。
   */
  let recipeFormSession = { generation: 0 };
  function rotateRecipeFormSession() {
    // 只换会话对象，不替换任何全局 API：旧提交据此判断自己是否还拥有当前表单。
    recipeFormSession = { generation: recipeCoverState.generation };
    return recipeFormSession;
  }
  function recipeCoverNodes() {
    const container = document.getElementById('recipeCoverPreview');
    if (!container) return null;
    const declaredHint = document.getElementById('recipeCoverHint');
    // 引导文案必须是预览容器内的唯一来源：图片加载失败被移除后仍能看到引导，
    // 也避免 index 的说明段落与容器内提示重复出现。
    let hint = declaredHint || container.querySelector('[data-cover-hint]');
    if (!hint) {
      hint = document.createElement('span');
      hint.id = 'recipeCoverHint';
      hint.dataset.coverHint = 'true';
      hint.className = 'text-[11px] text-stone-400 font-bold px-3 text-center';
    }
    if (hint.parentElement !== container) container.append(hint);
    return {
      container,
      hint,
      input: document.getElementById('recipeCoverFileInput'),
      choose: document.getElementById('btnChooseRecipeCover'),
      remove: document.getElementById('btnRemoveRecipeCover')
    };
  }
  function releaseRecipeCoverPreview() {
    const url = recipeCoverState.previewUrl;
    recipeCoverState.previewUrl = '';
    if (url && url.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function')
      URL.revokeObjectURL(url);
  }
  /** 封面区只重建受控 <img> 与提示文本，绝不写 innerHTML，也不创建事件属性。 */
  function renderRecipeCoverState() {
    const nodes = recipeCoverNodes();
    if (!nodes) return;
    const { container, hint, choose, remove } = nodes;
    const source = recipeCoverState.previewUrl || recipeCoverState.existingUrl || '';
    container.querySelectorAll('img').forEach((node) => node.remove());
    hint.textContent = RECIPE_COVER_HINT_TEXT;
    hint.classList.toggle('hidden', !!source);
    if (hint.parentElement !== container) {
      // 从容器外的说明段落迁移进预览区：统一成居中提示样式，避免外边距叠加
      hint.className = 'text-[11px] text-stone-400 font-bold px-3 text-center';
      container.append(hint);
    }
    if (source) {
      const image = document.createElement('img');
      image.src = source;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.className = 'w-full h-full object-cover';
      image.addEventListener('error', () => {
        // 图片加载失败：移除失效 <img> 并露出引导文案，避免预览区变成无提示空白。
        // 「移除封面」保持可见：状态里仍记着该封面值，用户需要能主动清掉它。
        image.remove();
        hint.textContent = RECIPE_COVER_HINT_TEXT;
        hint.classList.remove('hidden');
      });
      container.append(image);
    }
    if (choose) choose.textContent = source ? '更换封面' : '＋ 点击上传成品美图';
    if (remove) remove.classList.toggle('hidden', !source);
  }
  function resetRecipeCoverState(recipe) {
    recipeCoverState.generation += 1;
    releaseRecipeCoverPreview();
    recipeCoverState.file = null;
    recipeCoverState.removed = false;
    recipeCoverState.uploadCache = null;
    recipeCoverState.existingUrl = isSafeUploadedCoverUrl(recipe?.imagePath) ? recipe.imagePath : null;
    const nodes = recipeCoverNodes();
    if (nodes?.input) nodes.input.value = '';
    renderRecipeCoverState();
  }
  /** 本地预览：优先 objectURL；环境不支持时退回受限 data:image/(jpeg|png|webp) 读取。 */
  async function previewRecipeCoverFile(file, generation) {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(file);
      if (recipeCoverState.generation !== generation) {
        URL.revokeObjectURL(url);
        return '';
      }
      return url;
    }
    if (typeof FileReader !== 'function') return '';
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    if (recipeCoverState.generation !== generation) return '';
    return /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl) ? dataUrl : '';
  }
  function recipeCoverError(message, code = 'RECIPE_COVER_INVALID') {
    return new ApiError(422, code, message);
  }
  async function handleRecipeCoverFileSelected(event) {
    const input = event?.target || document.getElementById('recipeCoverFileInput');
    const file = input?.files?.[0] || null;
    // 输入控件的 value 必须立刻清空：同一文件重选也能再次触发 change
    if (input) input.value = '';
    if (!file) return false;
    const type = String(file.type || '').toLowerCase();
    if (!RECIPE_COVER_MIME.has(type)) {
      toast('封面仅支持 JPG / PNG / WEBP 图片', 'error');
      return false;
    }
    if (!(Number(file.size) > 0) || Number(file.size) > RECIPE_COVER_MAX_BYTES) {
      toast('封面图片不能超过 8MB', 'error');
      return false;
    }
    recipeCoverState.generation += 1;
    const generation = recipeCoverState.generation;
    releaseRecipeCoverPreview();
    recipeCoverState.file = file;
    recipeCoverState.removed = false;
    recipeCoverState.uploadCache = null;
    try {
      const previewUrl = await previewRecipeCoverFile(file, generation);
      if (recipeCoverState.generation !== generation) return false;
      if (!previewUrl) throw recipeCoverError('封面预览生成失败，请重试');
      recipeCoverState.previewUrl = previewUrl;
      renderRecipeCoverState();
      return true;
    } catch (error) {
      if (recipeCoverState.generation === generation) {
        recipeCoverState.file = null;
        renderRecipeCoverState();
        fail(error);
      }
      return false;
    }
  }
  function handleRemoveRecipeCover(event) {
    event?.preventDefault?.();
    recipeCoverState.generation += 1;
    releaseRecipeCoverPreview();
    recipeCoverState.file = null;
    recipeCoverState.existingUrl = null;
    recipeCoverState.uploadCache = null;
    recipeCoverState.removed = true;
    const nodes = recipeCoverNodes();
    if (nodes?.input) nodes.input.value = '';
    renderRecipeCoverState();
    return true;
  }
  async function uploadRecipeCover(file, generation) {
    const cached = recipeCoverState.uploadCache;
    if (cached && cached.generation === generation && cached.file === file) return cached.url;
    const form = new FormData();
    form.append('file', file, file.name || 'recipe-cover');
    const asset = await ApiClient.request('/uploads/images', { method: 'POST', body: form });
    const url = asset?.url;
    // 上传返回值同样严格校验：绝不把任意后端字符串当图片源
    if (!isSafeUploadedCoverUrl(url))
      throw new ApiError(422, 'RECIPE_COVER_UNSUPPORTED', '封面上传返回的图片地址不可用，请重试');
    if (recipeCoverState.generation !== generation)
      throw new ApiError(409, 'RECIPE_COVER_CHANGED', '封面已更换，本次保存未提交');
    recipeCoverState.uploadCache = { generation, file, url };
    return url;
  }
  /**
   * 提交时解析最终 imagePath：
   * - 有新选文件：先上传，复用同一代次/同一文件的缓存（校验失败重提不重复上传）
   * - 点了移除：显式 null
   * - 未触碰封面：原值保留；仅历史裸占位文件名顺手清成 null
   * snapshot 是提交开始时捕获的封面快照：上传等待期间用户关闭/重开表单改了全局状态，
   * 也不会把新会话的文件/移除标记混进旧请求。
   */
  async function resolveRecipeCoverImagePath(existing, snapshot) {
    const state = snapshot || recipeCoverState;
    if (state.file) return uploadRecipeCover(state.file, state.generation);
    if (state.removed) return null;
    const original = existing?.imagePath ?? null;
    if (isLegacyPlaceholderImageFilename(original)) return null;
    return original;
  }
  function recipeCoverStatus() {
    return {
      generation: recipeCoverState.generation,
      hasPendingFile: !!recipeCoverState.file,
      previewUrl: recipeCoverState.previewUrl,
      existingUrl: recipeCoverState.existingUrl,
      removed: recipeCoverState.removed
    };
  }
  /** 只读状态接口：供外部（含测试/调试）确认封面会话代次，不提供任何写入入口。 */
  function coverStatusAdapter() {
    return Object.freeze({
      recipe: recipeCoverStatus,
      isSafeUploadedCoverUrl,
      isLegacyPlaceholderImageFilename
    });
  }
  function installRecipeCoverControls() {
    const nodes = recipeCoverNodes();
    if (!nodes) return;
    const { input, choose, remove } = nodes;
    if (input && !input.dataset.google2CoverBound) {
      input.dataset.google2CoverBound = 'true';
      input.addEventListener('change', (event) => {
        void handleRecipeCoverFileSelected(event);
      });
    }
    if (choose && !choose.dataset.google2CoverBound) {
      choose.dataset.google2CoverBound = 'true';
      choose.addEventListener('click', (event) => {
        event.preventDefault();
        document.getElementById('recipeCoverFileInput')?.click();
      });
    }
    if (remove && !remove.dataset.google2CoverBound) {
      remove.dataset.google2CoverBound = 'true';
      remove.addEventListener('click', handleRemoveRecipeCover);
    }
    // 表单 submit 兜底监听：内联 onsubmit 在某些宿主（如脚本被 eval 注入的环境）不可达时
    // 仍能走同一条正式提交实现；withSubmitGuard 按 form 去重，真实浏览器里不会重复提交。
    const form = document.querySelector('#modalRecipeForm form');
    if (form && !form.dataset.google2CoverBound) {
      form.dataset.google2CoverBound = 'true';
      form.addEventListener('submit', (event) => {
        const handler = window.BentoModal?.handleRecipeFormSubmit;
        if (typeof handler === 'function') void handler(event);
      });
    }
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
      const result = await ApiClient.delete(
        `/records/${encodeURIComponent(id)}?version=${encodeURIComponent(item.version)}`
      );
      service.data = service.data.filter((x) => x.id !== id);
      emit('records:changed');
      if (result?.revertedPlanId) {
        try {
          await window.BentoService?.plans?.reload?.();
        } catch (error) {
          fail(error);
        }
      }
      toast('该餐记录已删除，月度看板已重算', 'success');
    };
    service.remove = service.delete;
    // 单条记录响应必须是「对象 + id 与所请求 id 一致」的实体，才能写回缓存。
    // 兜底响应（如 { items: [], total: 0 }、数组、缺 id）一律不覆盖既有缓存。
    const isValidRecordDto = (dto, id) =>
      !!dto &&
      typeof dto === 'object' &&
      !Array.isArray(dto) &&
      typeof dto.id === 'string' &&
      dto.id.length > 0 &&
      dto.id === id;
    const upsertById = (mapped) => {
      service.data = service.data.some((x) => x.id === mapped.id)
        ? service.data.map((x) => (x.id === mapped.id ? mapped : x))
        : [mapped, ...service.data];
    };
    const confirmPromises = new Map();
    // 标记「该错误已由 records.confirm 自身向用户提示」，让按钮层 catch 跳过重复 toast；
    // 仍抛回原始 error 对象，调用方语义与 status/code 不变。
    const markConfirmNotified = (error) => {
      if (error && typeof error === 'object') {
        try {
          error.__dafanRecordConfirmNotified = true;
        } catch {
          // 冻结/不可扩展的错误对象不影响原始错误传播
        }
      }
      return error;
    };
    service.confirm = (id) => {
      // 并发/重复点击同一记录只发一次 confirm 请求，其余调用复用同一 Promise。
      if (confirmPromises.has(id)) return confirmPromises.get(id);
      const existing = service.getById(id);
      if (!existing) return toast('就餐记录不在当前列表，请刷新后重试', 'error');
      const path = `/records/${encodeURIComponent(id)}`;
      let conflictSurfaced = false;
      const promise = (async () => {
        try {
          const dto = await ApiClient.post(`${path}/confirm`, { version: existing.version });
          if (!isValidRecordDto(dto, id))
            throw new ApiError(502, 'RECORD_CONFIRM_INVALID_RESPONSE', '确认结果无效，请刷新后查看');
          const mapped = mapRecord(dto);
          upsertById(mapped);
          emit('records:changed');
          toast(mapped.status === 'CONFIRMED' ? '已确认用餐，已计入日历与统计' : '已同步该记录的最新状态', 'success');
          return mapped;
        } catch (error) {
          if (error?.status === 409) {
            // 冲突时只做自愈读取：拿到有效实体才更新缓存，失败则保留原缓存并保留原始错误。
            let healed = null;
            try {
              const latest = await ApiClient.get(path);
              if (isValidRecordDto(latest, id)) {
                healed = mapRecord(latest);
                upsertById(healed);
                emit('records:changed');
                // 自愈也是真实写入后的可见状态变化：首页可见时刷新概览/统计，非首页只置脏（P1-7）
                markDashboardDirty();
              }
            } catch {
              // Keep the original conflict visible when refresh also fails.
            }
            conflictSurfaced = true;
            toast(
              healed
                ? healed.status === 'CONFIRMED'
                  ? '记录已被修改或已确认，已同步最新状态，请刷新查看'
                  : '记录已被其他操作修改，已同步最新版本，请确认后重试'
                : '记录已被修改，未能同步最新状态，请刷新后重试',
              'error'
            );
          }
          // 提示已在上方完成（409 分支或按钮层 fail），标记后仍抛回原始 error 对象
          throw markConfirmNotified(error);
        }
      })();
      confirmPromises.set(id, promise);
      // Inline onclick handlers do not await this promise: keep a user-visible
      // failure path here while preserving rejection for awaiting callers.
      promise.catch((error) => {
        if (!conflictSurfaced) fail(error);
        markConfirmNotified(error);
      });
      promise.finally(() => confirmPromises.delete(id)).catch(() => undefined);
      return promise;
    };
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
      resetDashboardRecipeCover(card);
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
  /** 首页推荐卡封面容器：只认卡片首个 .h-24 区块，找不到则不触碰其它节点。 */
  function dashboardRecipeCoverBox(card) {
    return card ? card.querySelector('.h-24') : null;
  }
  /**
   * 首页推荐卡封面：仅受控 /uploads/ 路径才创建 <img>；
   * 加载失败移除图片露出默认 🥘，绝不使用内联 onerror。
   */
  function renderDashboardRecipeCover(card, imagePath, category) {
    const box = dashboardRecipeCoverBox(card);
    if (!box) return;
    box.classList.add('relative', 'overflow-hidden');
    box.replaceChildren();
    const fallback = document.createElement('span');
    // 无封面时按菜谱分类派生图标（快手家常🍳/水产🐟/时蔬🥦…），不再恒为 🥘
    fallback.textContent = recipeCategoryIcon(category);
    box.append(fallback);
    if (!isSafeUploadedCoverUrl(imagePath)) return;
    const image = document.createElement('img');
    image.src = imagePath;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.className = 'absolute inset-0 w-full h-full object-cover';
    image.addEventListener('error', () => image.remove());
    box.append(image);
  }
  function resetDashboardRecipeCover(card) {
    const box = dashboardRecipeCoverBox(card);
    if (!box) return;
    box.replaceChildren();
    const fallback = document.createElement('span');
    fallback.textContent = '🥘';
    box.append(fallback);
  }
  /**
   * 今日推荐零条时的简洁空态：
   * 1) 页面若提供 [data-binding="recommendedRecipesEmpty"]（含切页入口），只切换 hidden，绝不重复渲染；
   * 2) 否则渲染一行纯文本提示，元素由本函数独占维护，有真实推荐时立即移除。
   */
  const RECOMMENDED_EMPTY_TEXT = '暂无推荐菜谱';
  function renderRecommendedEmptyState(container, hasItems) {
    const declared = document.querySelector('[data-binding="recommendedRecipesEmpty"]');
    if (declared) {
      declared.classList.toggle('hidden', hasItems);
      return;
    }
    if (!container) return;
    const existing = container.querySelector('[data-recommended-empty]');
    if (hasItems) {
      existing?.remove();
      container.removeAttribute('data-empty');
      return;
    }
    const empty = existing || document.createElement('p');
    empty.dataset.recommendedEmpty = 'true';
    empty.className = 'w-full text-center text-xs text-stone-400 py-6 m-0';
    if (empty.textContent !== RECOMMENDED_EMPTY_TEXT) empty.textContent = RECOMMENDED_EMPTY_TEXT;
    if (empty.parentElement !== container) container.append(empty);
    container.setAttribute('data-empty', 'true');
  }
  function mapDashboard(dto) {
    const data = dto || {};
    sanitizeStaticBusinessState();
    setBinding('branding', data.branding?.appName || '');
    setBinding('currentDate', data.currentDate || '');
    setBinding('tip', data.greetingText || data.tip || '');
    setBinding('greetingTitle', data.greetingTitle || '');
    const recommended = Array.isArray(data.recommendedRecipes) ? data.recommendedRecipes : [];
    const recommendedCards = document.querySelectorAll('[data-binding="recommendedRecipes"] > div');
    recommendedCards.forEach((card, i) => {
      const value = recommended[i];
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
        // 菜谱无真实评分时不显示任何假星级（空串，0 分是真实值仍显示 ★ 0）
        if (ratingNode) ratingNode.textContent = value.rating == null ? '' : `★ ${value.rating}`;
        // 无封面时按菜谱分类派生图标：默认端点不返回 category，回落到已加载菜谱缓存
        const cachedRecipe =
          value.category == null && value.id != null ? window.BentoService?.recipes?.getById?.(String(value.id)) : null;
        renderDashboardRecipeCover(card, value.imagePath, value.category ?? cachedRecipe?.category ?? null);
      } else {
        resetDashboardRecipeCover(card);
      }
    });
    renderRecommendedEmptyState(
      document.querySelector('[data-binding="recommendedRecipes"]'),
      recommended.length > 0 && recommendedCards.length > 0
    );
    const records = data.todayRecords || [];
    document.querySelectorAll('[data-binding="todayRecords"] [data-binding^="todayRecord-"]').forEach((slot, i) => {
      const value = records[i];
      slot.hidden = !value;
      if (value) {
        setText('[data-business-value="title"]', value.title || value.summary || '', slot);
        setText('[data-business-value="status"]', value.recorded ? '已完成' : '未记录', slot);
      }
    });
    // 分母只取真实餐次：后端未返回 todayRecords 时不写死 3 餐
    setBinding(
      'todayRecordsCount',
      records.length ? `${records.filter((x) => x.recorded).length}/${records.length} 餐` : ''
    );
    const inventory = data.inventory || {};
    setBinding('inventory-totalIngredients', inventory.totalIngredients ?? '');
    setBinding(
      'inventory-expiringSoon',
      inventory.expiringSoon ??
        (Array.isArray(inventory.expiringIngredients) ? inventory.expiringIngredients.length : '')
    );
    setBinding('inventory-insufficient', inventory.insufficient ?? '');
    const stats = data.weeklyStats || {};
    setBinding('weeklyStat-recordedDays', stats.recordedDays == null ? '' : `${stats.recordedDays}/7 天`);
    setBinding('weeklyStat-totalMeals', stats.totalMeals ?? '');
    // 无真实评分时显示破折号占位；真实 0 分仍显示 0
    setBinding('weeklyStat-averageRating', stats.averageRating == null ? '—' : stats.averageRating);
    setBinding(
      'weeklyStat-consumedIngredientCount',
      stats.consumedIngredientCount == null ? '' : stats.consumedIngredientCount
    );
    setBinding('streakDays', stats.streakDays == null ? '' : stats.streakDays);
    const days = data.calendarDays || [];
    const todayRecorded = (data.todayRecords || []).filter((x) => x.recorded).length;
    // 首页周历 7 格状态样式只由 adapter 统一维护：先摘掉模板里可能写死的状态类与内联样式，
    // 再按真实「今日 / 已打卡 / 有计划 / 普通日」挂唯一一套样式。
    // index 侧的 .week-cell* 与 html[data-theme="dark"] 规则用 !important 覆盖同语义呈现，
    // 两套机制互补：静态模板怎么精简都不会残留黄边格，摘掉今日态后也仍保留普通边框。
    const WEEK_STATE_STYLE = {
      today: {
        // cell 只保留布局类：底色/边框统一由 data-week-state 规则给出，
        // 避免与 index 带 !important 的 .bg-white / .bg-[#FFFDF0] 等工具色竞争，
        // 让 dafan-week-* 与 data-week-state 成为唯一颜色来源。
        cell: ['border-2', 'scale-105', 'hover:scale-110'],
        // 强调文字/徽标/胶囊统一走本模块语义类：浅色与深色各一套达标取值。
        // （#FF6B57 叠在 #FFF0ED 上只有 2.5:1，不能作为正文与徽标文字色）
        heading: ['dafan-week-today-text'],
        badge: ['dafan-week-today-badge'],
        text: ['dafan-week-today-text'],
        pill: ['dafan-week-today-pill']
      },
      recorded: {
        cell: ['border'],
        heading: ['dafan-week-muted'],
        badge: ['dafan-week-recorded-badge'],
        text: ['dafan-week-recorded-text'],
        pill: ['dafan-week-recorded-pill']
      },
      planned: {
        cell: ['border'],
        heading: ['dafan-week-muted'],
        badge: ['dafan-week-planned-badge'],
        text: ['dafan-week-planned-text'],
        pill: ['dafan-week-planned-pill']
      },
      normal: {
        cell: ['border'],
        heading: ['dafan-week-muted'],
        badge: ['dafan-week-normal-badge'],
        text: ['dafan-week-normal-text'],
        pill: ['dafan-week-normal-pill']
      }
    };
    // 清理集合 = 四态样式并集 + index 侧状态类 + 模板历史工具色（只用于周历四格，不做全局清理）
    // 历史槽位色（text-[#2E7D32] / bg-[#EDF7EE] / bg-stone-100 等）会被 index 带 !important 的
    // 深色/浅色全局规则压平四态，因此按 slot 定向摘除，让 dafan-week-* 成为唯一颜色来源。
    const LEGACY_WEEK_SLOT_CLASSES = [
      'text-[#2E7D32]',
      'bg-[#EDF7EE]',
      'bg-[#FFF8E6]',
      'text-[#D97706]',
      'text-stone-600',
      'text-stone-700',
      'text-stone-500',
      'bg-stone-100',
      'shadow-[0_3px_10px_rgba(255,107,87,0.18)]'
    ];
    const WEEK_STATE_CLASSES = [
      ...new Set([
        ...Object.values(WEEK_STATE_STYLE).flatMap((style) => Object.values(style).flat()),
        ...LEGACY_WEEK_SLOT_CLASSES
      ])
    ];
    const weekStateOf = (value) => {
      if (!value) return null;
      if (value.isToday) return 'today';
      if (value.status === 'recorded') return 'recorded';
      if (value.status === 'planned') return 'planned';
      return 'normal';
    };
    const applyWeekRowStyle = (row, state) => {
      row.removeAttribute('style');
      WEEK_STATE_CLASSES.forEach((className) => row.classList.remove(className));
      row.querySelectorAll('[data-business-value]').forEach((node) => {
        WEEK_STATE_CLASSES.forEach((className) => node.classList.remove(className));
      });
      row.classList.add('week-cell');
      row.classList.toggle('is-today-week-cell', state === 'today');
      // 状态同时写到 data-week-state：底板底色/边框由本模块注入的样式按此属性统一呈现，
      // 不依赖模板遗留类，也不与 index 的 .week-cell* 静态兜底互相叠加。
      if (state) row.dataset.weekState = state;
      else delete row.dataset.weekState;
      if (!state) {
        row.classList.add('bg-white', 'border');
        return;
      }
      const style = WEEK_STATE_STYLE[state];
      row.classList.add(...style.cell);
      row.querySelectorAll('[data-business-value="weekday"], [data-business-value="dayOfMonth"]').forEach((node) => {
        node.classList.add(...style.heading);
      });
      row.querySelectorAll('[data-business-value="dateBadge"]').forEach((node) => node.classList.add(...style.badge));
      row.querySelectorAll('[data-business-value="label"], [data-business-value="statusText"]').forEach((node) => {
        node.classList.add(...style.text);
      });
      row.querySelectorAll('[data-business-value="statusPill"]').forEach((node) => node.classList.add(...style.pill));
      // index 的 MutationObserver 只认 data-status / is-today-week-cell，这里同步状态类，
      // 即使 inline 脚本晚于 adapter 加载，页面侧规则也能在首次渲染时立即生效。
      row.classList.toggle('week-cell-today', state === 'today');
      row.classList.toggle('week-cell-recorded', state === 'recorded');
      row.classList.toggle('week-cell-planned', state === 'planned');
    };
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
        applyWeekRowStyle(row, null);
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
    // 周历右上角日期区间：由真实 calendarDays 首尾动态生成，绝不写死「9月1日 – 9月7日」
    const rangeNode = document.getElementById('weeklyCalendarRange');
    if (rangeNode) {
      const firstDate = parseBusinessDate(days[0]?.date);
      const lastDate = parseBusinessDate(days[days.length - 1]?.date);
      rangeNode.textContent =
        firstDate && lastDate ? `${firstDate.month}月${firstDate.day}日 – ${lastDate.month}月${lastDate.day}日` : '';
    }
    // 桌面网格与移动列表是两套并行视图：各自独立按 days[i] 索引，不能合并成一个循环
    document
      .querySelectorAll('[data-binding="calendarDays"] [data-binding^="calendarDay-"]')
      .forEach((row, i) => fillWeekRow(row, days[i]));
    document
      .querySelectorAll('.mobile-week-calendar-list [data-binding^="mobileCalendarDay-"]')
      .forEach((row, i) => fillWeekRow(row, days[i]));
    // 桌面网格与移动列表的第二遍：按真实数据把每格状态样式收敛到唯一一套。
    // 两套视图必须分别索引 days[i]，不能合并成一个联合选择器（否则移动端会读到错位索引）。
    document
      .querySelectorAll('[data-binding="calendarDays"] [data-binding^="calendarDay-"]')
      .forEach((row, i) => applyWeekRowStyle(row, weekStateOf(days[i])));
    document
      .querySelectorAll('.mobile-week-calendar-list [data-binding^="mobileCalendarDay-"]')
      .forEach((row, i) => applyWeekRowStyle(row, weekStateOf(days[i])));
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
            if (days == null) return '';
            if (days < 0) return `已过期 ${Math.abs(days)} 天`;
            if (days === 0) return '今日到期';
            return `${days}天后到期`;
          })(),
          row
        );
        row.dataset.ingredientId = value.id || '';
        row.onclick = () => window.BentoModal?.open('ingredientDetail', value.id);
      }
    });
    return data;
  }
  let dashboardLoadSequence = 0;
  async function loadDashboard() {
    const sequence = ++dashboardLoadSequence;
    try {
      const data = await ApiClient.get('/dashboard');
      // 忌口保存触发的新概览优先；旧请求晚到不得重新显示已排除的菜谱。
      return sequence === dashboardLoadSequence ? mapDashboard(data) : data;
    } catch (error) {
      if (sequence === dashboardLoadSequence) sanitizeStaticBusinessState();
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
    plans: ['save', 'add', 'update', 'delete', 'remove', 'checkin', 'uncheckin'],
    records: ['save', 'add', 'update', 'delete', 'remove', 'confirm'],
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
    const settings = await ApiClient.get('/settings');
    userNickname = settings?.userNickname || null;
    applyPinSettingsState(settings);
    return settings;
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
      clearPinToken();
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
  const PIN_SETTINGS_MODES = {
    enable: {
      title: '启用本地 PIN 保护',
      description: '设置后，访问本机数据需要输入 PIN。',
      submit: '启用 PIN',
      current: false,
      next: true
    },
    change: {
      title: '修改本地 PIN',
      description: '需要先验证当前 PIN，再设置新的 PIN。',
      submit: '保存新 PIN',
      current: true,
      next: true
    },
    disable: {
      title: '关闭本地 PIN 保护',
      description: '需要验证当前 PIN 才能关闭本机保护。',
      submit: '确认关闭',
      current: true,
      next: false
    }
  };
  const PIN_SAFE_ERRORS = {
    invalidFormat: '请输入 4～8 位数字 PIN',
    mismatch: '两次输入的新 PIN 不一致',
    wrongCurrent: '当前 PIN 不正确',
    conflict: '设置已被其他页面修改，已刷新最新状态，请重新提交',
    verifyFailed: 'PIN 验证失败，请稍后重试',
    updateFailed: 'PIN 设置更新失败，请稍后重试',
    renewFailed: 'PIN 已更新，但当前页面会话续期失败，请重新解锁',
    unavailable: 'PIN 设置界面不可用'
  };
  let pinSettingsEnabled = false;
  function pinSettingsDialog() {
    return {
      root: document.getElementById('modalPinSettings'),
      form: document.getElementById('google2PinSettingsForm'),
      title: document.getElementById('google2PinSettingsTitle'),
      description: document.getElementById('google2PinSettingsDescription'),
      currentGroup: document.getElementById('google2PinCurrentGroup'),
      current: document.getElementById('google2PinCurrent'),
      nextGroup: document.getElementById('google2PinNewGroup'),
      next: document.getElementById('google2PinNew'),
      confirmGroup: document.getElementById('google2PinConfirmGroup'),
      confirm: document.getElementById('google2PinConfirm'),
      error: document.getElementById('google2PinSettingsError'),
      submit: document.getElementById('google2PinSettingsSubmit'),
      cancel: document.getElementById('google2PinSettingsCancel'),
      close: document.getElementById('google2PinSettingsClose')
    };
  }
  function setPinSettingsError(message = '') {
    const node = pinSettingsDialog().error;
    if (node) node.textContent = message;
  }
  function applyPinSettingsState(settings) {
    const enabled = settings?.pinEnabled === true;
    pinSettingsEnabled = enabled;
    const status = document.getElementById('google2PinStatus');
    if (status) {
      status.textContent = enabled ? '已启用' : '未启用';
      status.setAttribute(
        'class',
        enabled
          ? 'text-xs font-black bg-[#FFF0ED] text-[#FF6B57] px-3 py-1 rounded-full border border-[#FEDBC5]'
          : 'text-xs font-black bg-stone-100 text-stone-500 px-3 py-1 rounded-full border border-stone-200'
      );
    }
    const enableButton = document.getElementById('google2PinEnable');
    const changeButton = document.getElementById('google2PinChange');
    const disableButton = document.getElementById('google2PinDisable');
    if (enableButton) enableButton.classList.toggle('hidden', enabled);
    if (changeButton) changeButton.classList.toggle('hidden', !enabled);
    if (disableButton) disableButton.classList.toggle('hidden', !enabled);
    return enabled;
  }
  function openPinSettings(mode = 'enable') {
    const key = Object.prototype.hasOwnProperty.call(PIN_SETTINGS_MODES, mode) ? mode : 'enable';
    const dialog = pinSettingsDialog();
    if (!dialog.root || !dialog.form) return false;
    // 已启用时不允许走 enable 路径绕过当前 PIN 校验；状态未知/失败时以提交前的最新 GET 为准
    if (key === 'enable' && pinSettingsEnabled) {
      toast('本地 PIN 已启用，请使用修改或关闭', 'info');
      return false;
    }
    if (key !== 'enable' && !pinSettingsEnabled) {
      toast('本地 PIN 未启用', 'info');
      return false;
    }
    pinSettingsMode = key;
    pinSettingsRequestToken += 1;
    const copy = PIN_SETTINGS_MODES[key];
    if (dialog.title) dialog.title.textContent = copy.title;
    if (dialog.description) dialog.description.textContent = copy.description;
    if (dialog.currentGroup) dialog.currentGroup.classList.toggle('hidden', !copy.current);
    if (dialog.nextGroup) dialog.nextGroup.classList.toggle('hidden', !copy.next);
    if (dialog.confirmGroup) dialog.confirmGroup.classList.toggle('hidden', !copy.next);
    [dialog.current, dialog.next, dialog.confirm].forEach((input) => {
      if (input) input.value = '';
    });
    if (dialog.submit) {
      dialog.submit.textContent = copy.submit;
      dialog.submit.disabled = pinSettingsPending;
    }
    dialog.root.classList.remove('hidden');
    setPinSettingsError('');
    if (renderPinCooldown() > 0) setPinSettingsError(`尝试次数过多，请 ${pinCooldownSeconds()} 秒后再试`);
    queueMicrotask(() => (copy.current ? dialog.current : dialog.next)?.focus());
    return true;
  }
  function closePinSettings() {
    pinSettingsMode = null;
    pinSettingsRequestToken += 1;
    const dialog = pinSettingsDialog();
    dialog.root?.classList.add('hidden');
    [dialog.current, dialog.next, dialog.confirm].forEach((input) => {
      if (input) input.value = '';
    });
    setPinSettingsError('');
    if (dialog.submit) {
      dialog.submit.disabled = false;
      dialog.submit.textContent = PIN_SETTINGS_MODES.enable.submit;
    }
  }
  async function verifyPinForSettings(pin) {
    try {
      const result = await ApiClient.post('/settings/pin/verify', { pin });
      if (result?.valid === true && typeof result.token === 'string' && result.token)
        return { ok: true, token: result.token };
      return { ok: false };
    } catch (error) {
      if (error?.status === 429 && error?.code === 'PIN_ATTEMPTS_EXCEEDED') {
        startPinCooldown(error);
        return { ok: false, cooldown: true };
      }
      throw error;
    }
  }
  async function refreshPinSettingsState() {
    const settings = await loadSettings();
    applyPinSettingsState(settings);
    return settings;
  }
  async function renewPinSession(pin) {
    // put 成功后服务端已清空全部旧会话与 /uploads Cookie：先丢弃本地旧 token，再用新 PIN 换新会话
    clearPinToken();
    let verified;
    try {
      verified = await verifyPinForSettings(pin);
    } catch {
      // PUT 已成功；错误只由持有当前 requestToken 的提交方展示，避免写到重开的弹窗。
      return false;
    }
    if (!verified.ok) return false;
    storePinToken(verified.token);
    return true;
  }
  async function submitPinSettings() {
    if (pinSettingsPending) return false;
    const mode = pinSettingsMode;
    if (!mode) return false;
    if (renderPinCooldown() > 0) return false;
    const dialog = pinSettingsDialog();
    const copy = PIN_SETTINGS_MODES[mode];
    const currentPin = dialog.current?.value || '';
    const nextPin = dialog.next?.value || '';
    const confirmPin = dialog.confirm?.value || '';
    if (copy.current && !/^\d{4,8}$/.test(currentPin)) {
      setPinSettingsError(PIN_SAFE_ERRORS.invalidFormat);
      dialog.current?.focus();
      return false;
    }
    if (copy.next && !/^\d{4,8}$/.test(nextPin)) {
      setPinSettingsError(PIN_SAFE_ERRORS.invalidFormat);
      dialog.next?.focus();
      return false;
    }
    if (copy.next && nextPin !== confirmPin) {
      setPinSettingsError(PIN_SAFE_ERRORS.mismatch);
      dialog.confirm?.focus();
      return false;
    }
    const requestToken = ++pinSettingsRequestToken;
    pinSettingsPending = true;
    if (dialog.submit) dialog.submit.disabled = true;
    setPinSettingsError('');
    try {
      if (copy.current) {
        const verified = await verifyPinForSettings(currentPin);
        if (requestToken !== pinSettingsRequestToken) return false; // 已取消：不再推进写入
        if (!verified.ok) {
          if (!verified.cooldown) setPinSettingsError(PIN_SAFE_ERRORS.wrongCurrent);
          if (dialog.current) dialog.current.value = '';
          return false;
        }
        // 先落地 header token：PUT /settings/pin 受 PIN 守卫保护（cookie 不能替代 header）
        storePinToken(verified.token);
      }
      const settings = await loadSettings();
      if (requestToken !== pinSettingsRequestToken) return false; // 已取消：绝不发 PUT
      const version = settings?.version;
      if (!Number.isInteger(version)) {
        setPinSettingsError(PIN_SAFE_ERRORS.updateFailed);
        return false;
      }
      // 最新状态与入口模式不一致（例如其它标签页刚启用 PIN）：不盲写，提示刷新后重选操作
      if (mode === 'enable' && settings?.pinEnabled === true) {
        setPinSettingsError(PIN_SAFE_ERRORS.conflict);
        return false;
      }
      if (mode !== 'enable' && settings?.pinEnabled !== true) {
        setPinSettingsError(PIN_SAFE_ERRORS.conflict);
        return false;
      }
      const body = { version, enabled: mode !== 'disable', pin: mode === 'disable' ? null : nextPin };
      await ApiClient.put('/settings/pin', body);
      if (mode === 'disable') {
        clearPinToken();
        await refreshPinSettingsState().catch(() => undefined);
        if (requestToken === pinSettingsRequestToken) {
          closePinSettings();
          toast('本地 PIN 已关闭', 'success');
        }
        return true;
      }
      const renewed = await renewPinSession(nextPin);
      await refreshPinSettingsState().catch(() => undefined);
      if (requestToken === pinSettingsRequestToken) {
        if (renewed) {
          closePinSettings();
          toast(mode === 'enable' ? '本地 PIN 已启用' : '本地 PIN 已更新', 'success');
        } else setPinSettingsError(PIN_SAFE_ERRORS.renewFailed);
      }
      return renewed;
    } catch (error) {
      if (error?.status === 409 && error?.code === 'VERSION_CONFLICT') {
        await refreshPinSettingsState().catch(() => undefined);
        if (requestToken === pinSettingsRequestToken) setPinSettingsError(PIN_SAFE_ERRORS.conflict);
        return false;
      }
      if (requestToken === pinSettingsRequestToken) {
        if (error?.status === 429 && error?.code === 'PIN_ATTEMPTS_EXCEEDED') startPinCooldown(error);
        else setPinSettingsError(PIN_SAFE_ERRORS.updateFailed);
      }
      return false;
    } finally {
      pinSettingsPending = false;
      const current = pinSettingsDialog();
      if (current.submit) current.submit.disabled = pinCooldownSeconds() > 0;
    }
  }
  const SETTINGS_ROW_TITLES = { backup: '数据备份与导出', taboo: '食用者忌口偏好' };
  let activeDiners = [];
  let dinersReady = false;
  let dinersLoading = null;
  let tabooSelected = null;
  let tabooLastDinerId = null;
  let tabooPending = false;
  let tabooDialogGeneration = 0;
  let userNickname = null;
  const tabooFields = {
    tabooText: 'google2TabooText',
    allergyText: 'google2AllergyText',
    dislikesText: 'google2DislikesText'
  };
  // 与 shared/diner-rules.ts 保持同一分词和大小写匹配口径。
  const tabooTokens = (value) =>
    value
      ?.split(/[、,，;；\s]+/)
      .map((word) => word.trim().toLocaleLowerCase())
      .filter(Boolean) || [];
  const forbiddenWords = () =>
    activeDiners.flatMap((diner) => [
      ...tabooTokens(diner.tabooText),
      ...tabooTokens(diner.allergyText),
      ...tabooTokens(diner.dislikesText)
    ]);
  function allowsDinerCandidate(item) {
    if (!dinersReady) return false;
    const text = [
      item?.name,
      item?.title,
      item?.ingredientsText,
      item?.notes,
      item?.cuisine,
      item?.category,
      item?.recommendedDishes,
      item?.dishes,
      item?.signatureDishes,
      item?.avoidDishes,
      item?.tagsText,
      ...(item?.ingredients || []).flatMap((ingredient) => [
        ingredient.ingredientNameSnapshot,
        ingredient.name,
        ingredient.ingredientName
      ]),
      ...(item?.menuItems || []).flatMap((dish) => [dish.name, dish.desc])
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();
    return !forbiddenWords().some((word) => text.includes(word));
  }
  function renderTabooSummary() {
    const summary = document.getElementById('google2TabooDescription');
    if (!summary) return;
    const labels = { tabooText: '忌口', allergyText: '过敏', dislikesText: '不偏好' };
    const descriptions = activeDiners
      .map((diner) => {
        const values = Object.entries(labels)
          .filter(([field]) => tabooTokens(diner[field]).length)
          .map(([field, label]) => `${label}：${diner[field]}`);
        return values.length ? `${diner.name}（${values.join('；')}）` : '';
      })
      .filter(Boolean);
    summary.textContent = descriptions.join('；') || '未设置忌口或过敏原';
  }
  function refreshDinerCandidates() {
    window.updateWheelCandidates?.();
    const pantry = document.getElementById('modalPantryRecommend');
    if (pantry && !pantry.classList.contains('hidden')) window.BentoModal?.setupPantryRecommend?.();
  }
  function loadActiveDiners() {
    if (dinersLoading) return dinersLoading;
    dinersLoading = (async () => {
      try {
        const first = await ApiClient.get('/diners?active=true&page=1&pageSize=100');
        const values = pageItems(first).slice();
        const pages = Number(first?.totalPages || (first?.total ? Math.ceil(first.total / 100) : 1));
        for (let page = 2; page <= pages; page += 1) {
          values.push(...pageItems(await ApiClient.get(`/diners?active=true&page=${page}&pageSize=100`)));
        }
        activeDiners = values.filter((diner) => diner.active !== false);
        dinersReady = true;
        renderTabooSummary();
        refreshDinerCandidates();
        return activeDiners;
      } catch (error) {
        dinersReady = false;
        const summary = document.getElementById('google2TabooDescription');
        if (summary) summary.textContent = '忌口偏好读取失败，请点击编辑重试';
        refreshDinerCandidates();
        throw error;
      } finally {
        dinersLoading = null;
      }
    })();
    return dinersLoading;
  }
  function setTabooError(message = '') {
    const error = document.getElementById('google2TabooError');
    if (error) error.textContent = message;
  }
  function fillTabooDiner(id) {
    tabooSelected = activeDiners.find((diner) => diner.id === id) || null;
    if (tabooSelected) tabooLastDinerId = tabooSelected.id;
    Object.entries(tabooFields).forEach(([field, inputId]) => {
      const input = document.getElementById(inputId);
      if (input) input.value = tabooSelected?.[field] || '';
    });
    setTabooError();
  }
  function setTabooBusy(busy) {
    tabooPending = busy;
    document
      .querySelectorAll(
        '#google2TabooForm button, #google2TabooForm select, #google2TabooForm textarea, #google2TabooClose'
      )
      .forEach((control) => {
        control.disabled = busy;
      });
  }
  async function openTabooSettings() {
    if (tabooPending) return;
    const root = document.getElementById('modalTabooSettings');
    if (!root) return;
    const generation = ++tabooDialogGeneration;
    root.classList.remove('hidden');
    fillTabooDiner(null);
    setTabooBusy(true);
    setTabooError('正在读取食用者…');
    try {
      await loadActiveDiners();
      if (!activeDiners.length) await loadSettings();
      if (generation !== tabooDialogGeneration) return;
      const selectedId = activeDiners.find((diner) => diner.id === tabooLastDinerId)?.id || activeDiners[0]?.id;
      const select = document.getElementById('google2TabooDiner');
      if (select) {
        select.replaceChildren();
        const options = activeDiners.length ? activeDiners : [{ id: '', name: userNickname || '默认食用者' }];
        options.forEach((diner) => {
          const option = document.createElement('option');
          option.value = diner.id;
          option.textContent = diner.name;
          select.append(option);
        });
        if (selectedId) select.value = selectedId;
      }
      fillTabooDiner(selectedId);
      setTabooBusy(false);
      document.getElementById('google2TabooText')?.focus();
    } catch (error) {
      setTabooBusy(false);
      // 读取失败时不可根据空缓存创建另一个成员；关闭后可重试。
      const submit = document.getElementById('google2TabooSubmit');
      if (submit) submit.disabled = true;
      setTabooError(error?.message || '食用者读取失败，请关闭后重试');
    }
  }
  function closeTabooSettings() {
    if (tabooPending) return;
    tabooDialogGeneration += 1;
    document.getElementById('modalTabooSettings')?.classList.add('hidden');
    fillTabooDiner(null);
    document.getElementById('google2TabooEdit')?.focus();
  }
  async function submitTabooSettings() {
    if (tabooPending || !dinersReady) return false;
    const body = Object.fromEntries(
      Object.entries(tabooFields).map(([field, id]) => [field, document.getElementById(id)?.value.trim() || null])
    );
    if (!tabooSelected && Object.values(body).every((value) => value === null)) {
      closeTabooSettings();
      return true;
    }
    const selected = tabooSelected;
    setTabooBusy(true);
    setTabooError();
    try {
      const saved = selected
        ? await ApiClient.put(`/diners/${selected.id}`, { ...body, version: selected.version })
        : await ApiClient.post('/diners', { ...body, name: userNickname || '默认食用者' });
      activeDiners = selected
        ? activeDiners.map((diner) => (diner.id === selected.id ? saved : diner))
        : [...activeDiners, saved];
      cancelWheelPending();
      window.cleanupActiveSpin?.('preferences');
      renderTabooSummary();
      refreshDinerCandidates();
      setTabooBusy(false);
      closeTabooSettings();
      toast('忌口偏好已保存', 'success');
      const results = await Promise.allSettled([loadActiveDiners(), loadDashboard()]);
      if (results.some((result) => result.status === 'rejected'))
        toast('偏好已保存，部分推荐刷新失败，请稍后重试', 'warning');
      return true;
    } catch (error) {
      if (error?.status === 409) {
        // 保留用户输入；重新打开获取最新版本，绝不以旧 version 静默覆盖。
        setTabooError('该食用者已在其他页面修改。请取消并重新打开，核对最新偏好后保存。');
      } else setTabooError(error?.message || '保存失败，请稍后重试');
      setTabooBusy(false);
      return false;
    }
  }
  function wireTabooSettings() {
    const button = settingsRowButton(SETTINGS_ROW_TITLES.taboo);
    if (button && !button.dataset.tabooBound) {
      button.dataset.tabooBound = 'true';
      button.removeAttribute('onclick');
      button.removeAttribute('aria-disabled');
      button.addEventListener('click', () => void openTabooSettings());
    }
    const form = document.getElementById('google2TabooForm');
    if (!form || form.dataset.tabooBound) return;
    form.dataset.tabooBound = 'true';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitTabooSettings();
    });
    ['google2TabooClose', 'google2TabooCancel'].forEach((id) =>
      document.getElementById(id)?.addEventListener('click', closeTabooSettings)
    );
    document
      .getElementById('google2TabooDiner')
      ?.addEventListener('change', (event) => fillTabooDiner(event.target.value));
    document.getElementById('google2TabooClear')?.addEventListener('click', () => {
      Object.values(tabooFields).forEach((id) => {
        document.getElementById(id).value = '';
      });
      setTabooError('已清空当前成员的输入，保存后生效。');
    });
    const root = document.getElementById('modalTabooSettings');
    root?.addEventListener('click', (event) => {
      if (event.target === root) closeTabooSettings();
    });
    root?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeTabooSettings();
      }
      if (event.key === 'Tab') {
        const controls = [...root.querySelectorAll('button, select, textarea')].filter((control) => !control.disabled);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    });
  }
  // h4 标题保持精确匹配（不依赖按钮/整卡文案），只按标题定位到整行再取行内控件
  const settingsRow = (title) => {
    const row = Array.from(document.querySelectorAll('#page-settings h4')).find(
      (node) => node.textContent?.trim() === title
    )?.parentElement?.parentElement;
    return row || null;
  };
  const settingsRowButton = (title) => settingsRow(title)?.querySelector('button') || null;
  async function wireSettings() {
    wireTabooSettings();
    await Promise.all([loadSettings(), loadActiveDiners().catch(fail)]);
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
    wirePinSettingsDialog();
  }
  function wirePinSettingsDialog() {
    const entries = [
      ['google2PinEnable', 'enable'],
      ['google2PinChange', 'change'],
      ['google2PinDisable', 'disable']
    ];
    entries.forEach(([id, mode]) => {
      const button = document.getElementById(id);
      if (button && !button.dataset.pinSettingsBound) {
        button.dataset.pinSettingsBound = 'true';
        button.addEventListener('click', () => openPinSettings(mode));
      }
    });
    const dialog = pinSettingsDialog();
    if (dialog.form && !dialog.form.dataset.pinSettingsBound) {
      dialog.form.dataset.pinSettingsBound = 'true';
      dialog.form.addEventListener('submit', (event) => {
        event.preventDefault();
        void submitPinSettings();
      });
    }
    [dialog.cancel, dialog.close].forEach((button) => {
      if (button && !button.dataset.pinSettingsBound) {
        button.dataset.pinSettingsBound = 'true';
        button.addEventListener('click', closePinSettings);
      }
    });
    renderPinCooldown();
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
  /**
   * options.session：菜谱表单的提交会话对象。同一 form 元素在关闭重开后仍是同一个 DOM 节点，
   * 若只按 form 去重，旧会话的在途提交会把新会话的提交直接吞掉（返回旧 promise）。
   * 传入 session 时，旧会话的 pending 不再阻塞新会话；旧 pending 收尾也不会解除新提交的按钮禁用态。
   */
  function withSubmitGuard(event, task, options) {
    const form = event?.currentTarget?.tagName === 'FORM' ? event.currentTarget : event?.target?.closest?.('form');
    const key = form || event?.currentTarget || event?.target || document;
    const session = options && typeof options === 'object' ? (options.session ?? null) : null;
    const previous = submitGuardPending.get(key);
    if (previous && (session === null || previous.session === session)) return previous.pending;
    const button = event?.submitter || form?.querySelector?.('button[type="submit"]');
    if (button) {
      button.dataset.submitting = 'true';
      button.disabled = true;
    }
    const entry = { session, pending: null };
    entry.pending = Promise.resolve()
      .then(task)
      .finally(() => {
        // 只有仍持有该 form 的提交才能解除按钮禁用态；被新会话接管时交给新提交收尾。
        if (submitGuardPending.get(key) !== entry) return;
        submitGuardPending.delete(key);
        if (button) {
          button.dataset.submitting = 'false';
          button.disabled = false;
        }
      });
    submitGuardPending.set(key, entry);
    return entry.pending;
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
  function installAdapterThemeStyles() {
    // adapter 契约样式（周历四态文字 + 图表图例/参考线）：浅色默认 + html[data-theme="dark"] 覆盖，
    // 沿用页面既有主题机制；只注入一次，只作用于本模块生成的 class，不改任何既有节点或类名。
    if (document.getElementById('dafan-adapter-theme')) return;
    const style = document.createElement('style');
    style.id = 'dafan-adapter-theme';
    style.textContent = [
      /* 首页周历 7 格：今日 / 已打卡 / 有计划 / 普通日 的强调文字 */
      '.dafan-week-muted { color: #6F655C; }',
      '.dafan-week-today-text { color: #B3402F; }',
      '.dafan-week-today-badge { background-color: #C8492F; color: #FFFFFF; }',
      '.dafan-week-today-pill { background-color: #FFF0ED; color: #A63A28; border: 1px solid #FEDBC5; }',
      '.dafan-week-recorded-text { color: #23611F; }',
      '.dafan-week-recorded-badge { background-color: #EDF7EE; color: #23611F; }',
      '.dafan-week-recorded-pill { background-color: #EDF7EE; color: #23611F; }',
      '.dafan-week-planned-text { color: #8A5300; }',
      '.dafan-week-planned-badge { background-color: #FFF8E6; color: #8A5300; }',
      '.dafan-week-planned-pill { background-color: #FFF8E6; color: #8A5300; }',
      '.dafan-week-normal-text { color: #6B6257; }',
      '.dafan-week-normal-badge { background-color: #F3EFE9; color: #57534E; }',
      '.dafan-week-normal-pill { background-color: #F3EFE9; color: #57534E; }',
      /* 月历「已打卡」徽标：浅色 #8A5300 白底 6.33 / 今日浅粉底 5.71；深色 #FDD37A 暗槽 8.51–11.21 */
      '.dafan-calendar-checkin { color: #8A5300; }',
      /* 四态底板：以 data-week-state 为准，压过模板历史类与 index 的静态兜底规则，
         保证「今日 / 已打卡 / 有计划 / 普通日」只有一套来源；removeAttribute('style') 已清内联残留。
         border 一律拆成长属性（width/style/color）：shorthand 与非 important 的读侧属性不重叠，
         会让求解与真实层叠出现歧义；长属性同时保证 recorded/planned 的 4px 底边不被覆盖。 */
      '.week-cell[data-week-state="recorded"] { background-color: #FFFFFF !important; border-width: 1px !important; border-style: solid !important; border-color: #BCE3C1 !important; border-bottom-width: 4px !important; border-bottom-color: #2E7D32 !important; }',
      '.week-cell[data-week-state="planned"] { background-color: #FFFFFF !important; border-width: 1px !important; border-style: solid !important; border-color: #FEE8B8 !important; border-bottom-width: 4px !important; border-bottom-color: #B45309 !important; }',
      '.week-cell[data-week-state="today"] { background-color: #FFF8F5 !important; border-width: 2px !important; border-style: solid !important; border-color: #C2412F !important; box-shadow: 0 4px 12px rgba(194, 65, 47, 0.18) !important; }',
      '.week-cell[data-week-state="normal"] { background-color: #FFFFFF !important; border-width: 1px !important; border-style: solid !important; border-color: #D6C9BA !important; }',
      'html[data-theme="dark"] .week-cell[data-week-state="recorded"] { background-color: rgba(46, 125, 50, 0.16) !important; border-color: rgba(76, 175, 80, 0.45) !important; border-bottom-color: #81C784 !important; }',
      'html[data-theme="dark"] .week-cell[data-week-state="planned"] { background-color: rgba(245, 158, 11, 0.16) !important; border-color: rgba(245, 158, 11, 0.45) !important; border-bottom-color: #FBBF24 !important; }',
      'html[data-theme="dark"] .week-cell[data-week-state="today"] { background-color: rgba(255, 107, 87, 0.18) !important; border-color: #FF8A7A !important; box-shadow: none !important; }',
      'html[data-theme="dark"] .week-cell[data-week-state="normal"] { background-color: #2C2723 !important; border-width: 1px !important; border-style: solid !important; border-color: #8E8276 !important; }',
      /* 统计图表图例与参考线 */
      '.dafan-legend-cook { color: #2E7D32; }',
      '.dafan-legend-takeout { color: #8A5300; }',
      '.dafan-legend-dinein { color: #6D28D9; }',
      '.dafan-legend-other { color: #57534E; }',
      '.dafan-legend-comfortable { color: #2E7D32; }',
      '.dafan-legend-low { color: #8A5300; }',
      '.dafan-legend-over { color: #A63A28; }',
      '.dafan-chart-track { stroke: #9C8B79; }',
      '.dafan-chart-cook-value { fill: #2E7D32; }',
      '.dafan-chart-reference { stroke: #C2412C; }',
      '.dafan-chart-reference-label { fill: #B3402F; }',
      'html[data-theme="dark"] .dafan-week-muted { color: #D1C5B7; }',
      'html[data-theme="dark"] .dafan-week-today-text { color: #FFB3A6; }',
      'html[data-theme="dark"] .dafan-week-today-badge { background-color: #FFB4A4; color: #2D2621; }',
      'html[data-theme="dark"] .dafan-week-today-pill { background-color: #52332C; color: #FFB4A4; border-color: #7A4A3F; }',
      'html[data-theme="dark"] .dafan-week-recorded-text { color: #A5D6A7; }',
      'html[data-theme="dark"] .dafan-week-recorded-badge { background-color: #2C3C27; color: #A5D6A7; }',
      'html[data-theme="dark"] .dafan-week-recorded-pill { background-color: #2C3C27; color: #A5D6A7; }',
      'html[data-theme="dark"] .dafan-week-planned-text { color: #FDD37A; }',
      'html[data-theme="dark"] .dafan-week-planned-badge { background-color: #3D3320; color: #FDD37A; }',
      'html[data-theme="dark"] .dafan-week-planned-pill { background-color: #3D3320; color: #FDD37A; }',
      'html[data-theme="dark"] .dafan-week-normal-text { color: #E6DCD0; }',
      'html[data-theme="dark"] .dafan-week-normal-badge { background-color: #332B25; color: #E6DCD0; }',
      'html[data-theme="dark"] .dafan-week-normal-pill { background-color: #332B25; color: #E6DCD0; }',
      'html[data-theme="dark"] .dafan-calendar-checkin { color: #FDD37A; }',
      'html[data-theme="dark"] .dafan-legend-cook { color: #81C784; }',
      'html[data-theme="dark"] .dafan-legend-takeout { color: #FBBF24; }',
      'html[data-theme="dark"] .dafan-legend-dinein { color: #C4B5FD; }',
      'html[data-theme="dark"] .dafan-legend-other { color: #D1C5B7; }',
      'html[data-theme="dark"] .dafan-legend-comfortable { color: #A5D6A7; }',
      'html[data-theme="dark"] .dafan-legend-low { color: #FDD37A; }',
      'html[data-theme="dark"] .dafan-legend-over { color: #FFB4A4; }',
      'html[data-theme="dark"] .dafan-chart-track { stroke: #8E8276; }',
      'html[data-theme="dark"] .dafan-chart-cook-value { fill: #81C784; }',
      'html[data-theme="dark"] .dafan-chart-reference { stroke: #FF9B8B; }',
      'html[data-theme="dark"] .dafan-chart-reference-label { fill: #FFB4A4; }'
    ].join('\n');
    (document.head || document.documentElement).append(style);
  }
  function installLegacyDataViews() {
    installAdapterThemeStyles();
    const originalCalendar = window.renderCalendar;
    let calendarRequest = 0;
    let statisticsRequest = 0;
    // 默认锚定「当前真实本地年月」：启动阶段绝不先刷 2026-09 假打卡月历（A-08/D-004/B18/E1）。
    // 页面显式传入合法年月（如外部深链/测试预设）时尊重该值，不再回落到写死的 2026-09。
    const initialMonth = localDateParts();
    const presetYear = Number(window.currentCalendarYear);
    const presetMonth = Number(window.currentCalendarMonth);
    const calendarState = {
      year: Number.isInteger(presetYear) && presetYear >= 1900 && presetYear <= 2200 ? presetYear : initialMonth.year,
      month: Number.isInteger(presetMonth) && presetMonth >= 1 && presetMonth <= 12 ? presetMonth : initialMonth.month
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
      // 年份/月份只接受有限整数并夹在合理区间，内联 onclick 参数因此恒为纯数字
      const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.trunc(value)));
      const rawYear = Number(calendarState.year);
      const rawMonth = Number(calendarState.month);
      const year = clamp(Number.isFinite(rawYear) ? rawYear : 2026, 1900, 2200);
      const month = clamp(Number.isFinite(rawMonth) ? rawMonth : 1, 1, 12);
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
        const nodes = [];
        for (let index = 0; index < offset; index += 1) {
          const spacer = document.createElement('div');
          spacer.className =
            'aspect-square h-auto rounded-xl sm:rounded-2xl bg-transparent border-0 pointer-events-none';
          nodes.push(spacer);
        }
        for (let day = 1; day <= daysInBusinessMonth(year, month); day += 1) {
          const date = businessDateParts(year, month, day);
          const isToday = year === today.year && month === today.month && day === today.day;
          const hasRecord = dates.has(date);
          const cell = document.createElement('div');
          cell.className = `relative aspect-square h-auto rounded-xl sm:rounded-2xl border p-1 sm:p-1.5 flex items-center justify-center text-center cursor-pointer transition-all ${
            isToday
              ? 'bg-[#FFF0ED] border-[#FF6B57] shadow-sm font-black'
              : hasRecord
                ? 'bg-white border-[#F0E8DC]'
                : 'bg-[#FAF7F2] border-transparent text-stone-400'
          }`;
          // 年月日是严格整数，内联调用参数只含数字，不含任何业务文本
          cell.setAttribute(
            'onclick',
            `BentoModal.open('dailyDiary', { year: ${year}, month: ${month}, day: ${day} })`
          );
          const content = document.createElement('div');
          content.className =
            'calendar-day-content w-full flex flex-col items-center justify-center text-center leading-none gap-0.5';
          const dayLabel = document.createElement('span');
          dayLabel.className = `${isToday ? 'text-[#FF6B57] font-black' : ''} text-[10px] sm:text-[11px] font-bold leading-none`;
          dayLabel.textContent = String(day);
          content.appendChild(dayLabel);
          if (hasRecord) {
            const badge = document.createElement('div');
            // 文字色走主题语义类（浅色 #8A5300 / 深色 #FDD37A，均由 installAdapterThemeStyles 注入），
            // 不再用 Tailwind 固定琥珀色阶：浅色 600 档(#D97706) 白底 3.19、今日浅粉底 2.87 不达标。
            badge.className =
              'dafan-calendar-checkin text-[8px] sm:text-[9px] font-black truncate leading-tight mt-0.5';
            badge.textContent = '🍱 已打卡';
            content.appendChild(badge);
          }
          cell.appendChild(content);
          nodes.push(cell);
        }
        grid.replaceChildren(...nodes);
      } catch (error) {
        if (seq === calendarRequest) {
          const failureNode = document.createElement('div');
          failureNode.className = 'col-span-7 p-6 text-center text-red-500';
          failureNode.textContent = '日历加载失败，请稍后重试';
          grid.replaceChildren(failureNode);
          fail(error);
        }
      } finally {
        if (seq === calendarRequest) grid.removeAttribute('aria-busy');
      }
    };
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const createEmptyChartMessage = (message) => {
      const node = document.createElement('div');
      node.className = 'p-4 text-center text-stone-400';
      node.textContent = message;
      return node;
    };
    const svgElement = (name, attributes = {}) => {
      const node = document.createElementNS(SVG_NS, name);
      Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
      return node;
    };
    const svgText = (value) => document.createTextNode(String(value));
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
        wrap.replaceChildren(createEmptyChartMessage(String(message)));
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
      const svg = svgElement('svg', {
        viewBox: `0 0 ${w} ${h}`,
        class: 'w-full h-full text-stone-500',
        role: 'img',
        'aria-label': '每日卡路里摄入柱状图'
      });
      const title = svgElement('title');
      title.appendChild(
        svgText(`按日期显示已记录热量；未记录日期不绘制柱形；虚线为 ${CALORIE_REFERENCE_KCAL} kcal 通用参考基准`)
      );
      svg.appendChild(title);
      // 原版固定 2000 kcal 参考线：与柱形共用同一 maxCal 比例尺，明确标为参考基准而非个人目标。
      const referenceY = h - (CALORIE_REFERENCE_KCAL / maxCal) * (h - 45) - 22;
      svg.appendChild(
        svgElement('line', {
          'data-reference-kcal': CALORIE_REFERENCE_KCAL,
          x1: 10,
          y1: referenceY,
          x2: w - 10,
          y2: referenceY,
          class: 'dafan-chart-reference',
          'stroke-dasharray': '4,4',
          'stroke-opacity': '0.4',
          'stroke-width': '1.5'
        })
      );
      const referenceLabel = svgElement('text', {
        x: w - 12,
        y: 12,
        class: 'dafan-chart-reference-label',
        'font-size': '9',
        'font-weight': '900',
        'text-anchor': 'end'
      });
      referenceLabel.appendChild(svgText(`${CALORIE_REFERENCE_KCAL} kcal 参考线`));
      svg.appendChild(referenceLabel);
      points.forEach((point, index) => {
        const x = 10 + index * step + step / 2;
        const textX = Math.max(24, Math.min(w - 24, x));
        if (point.calories != null) {
          const barH = (point.calories / maxCal) * (h - 45);
          const y = h - barH - 22;
          // 原版比较表现：高于参考基准的柱形改用对比色
          const fill = point.calories > CALORIE_REFERENCE_KCAL ? '#FF8575' : '#6ABF69';
          const rect = svgElement('rect', {
            'data-date': point.date,
            'data-calories': point.calories,
            x: x - barWidth / 2,
            y,
            width: barWidth,
            height: barH,
            rx: Math.min(6, barWidth / 2),
            fill,
            opacity: '0.85'
          });
          const barTitle = svgElement('title');
          barTitle.appendChild(svgText(`${point.date}: ${point.calories} kcal`));
          rect.appendChild(barTitle);
          svg.appendChild(rect);
          if (labels.includes(index)) {
            const valueLabel = svgElement('text', {
              x: textX,
              y: y - 4,
              fill: 'currentColor',
              'font-size': '10',
              'font-weight': 'bold',
              'text-anchor': 'middle'
            });
            valueLabel.appendChild(svgText(point.calories));
            svg.appendChild(valueLabel);
          }
        }
        if (labels.includes(index)) {
          const dateLabel = svgElement('text', {
            x: textX,
            y: h - 6,
            fill: 'currentColor',
            'font-size': '10',
            'font-weight': 'bold',
            'text-anchor': 'middle'
          });
          dateLabel.appendChild(svgText(point.date.slice(5)));
          svg.appendChild(dateLabel);
        }
      });
      wrap.replaceChildren(svg);
    };
    const renderSourceChart = (breakdown, message = '暂无就餐渠道数据') => {
      const wrap = document.getElementById('chartChannelDonutWrap');
      const legend = document.getElementById('statPctCook')?.parentElement?.parentElement;
      if (!wrap || !legend) return;
      const categories = [
        { key: 'HOMEMADE', label: '自烹', color: '#6ABF69', legendClass: 'dafan-legend-cook', id: 'statPctCook' },
        { key: 'TAKEOUT', label: '外卖', color: '#FFC53D', legendClass: 'dafan-legend-takeout', id: 'statPctTakeout' },
        { key: 'DINE_IN', label: '堂食', color: '#B388FF', legendClass: 'dafan-legend-dinein', id: 'statPctDineIn' },
        { key: 'CUSTOM', label: '其他', color: '#A8A29E', legendClass: 'dafan-legend-other', id: 'statPctCustom' }
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
      const legendNodes = rows
        .filter((row) => row.key !== 'CUSTOM' || row.count > 0)
        .map((row) => {
          const item = document.createElement('span');
          item.className = row.legendClass;
          item.appendChild(document.createTextNode(`● ${row.label} `));
          const value = document.createElement('span');
          value.id = row.id;
          value.textContent = total ? `${Math.round((row.count / total) * 1000) / 10}%` : '—';
          item.appendChild(value);
          return item;
        });
      legend.replaceChildren(...legendNodes);
      if (!total) {
        wrap.replaceChildren(createEmptyChartMessage(String(message)));
        return;
      }
      const r = 50;
      const c = 2 * Math.PI * r;
      let offset = 0;
      const svg = svgElement('svg', {
        viewBox: '0 0 140 140',
        class: 'w-32 h-32 text-stone-700',
        role: 'img',
        'aria-label': '就餐渠道构成环形图'
      });
      svg.appendChild(
        svgElement('circle', {
          cx: 70,
          cy: 70,
          r,
          fill: 'none',
          class: 'dafan-chart-track',
          'stroke-width': 16
        })
      );
      rows.forEach((row) => {
        if (!row.count) return;
        const length = (row.count / total) * c;
        const pct = Math.round((row.count / total) * 1000) / 10;
        const arc = svgElement('circle', {
          'data-source': row.key,
          'data-count': row.count,
          cx: 70,
          cy: 70,
          r,
          fill: 'none',
          stroke: row.color,
          'stroke-width': 16,
          'stroke-dasharray': `${length} ${c - length}`,
          'stroke-dashoffset': -offset,
          transform: 'rotate(-90 70 70)',
          'stroke-linecap': 'round'
        });
        const arcTitle = svgElement('title');
        arcTitle.appendChild(svgText(`${row.label}: ${row.count} 次 (${pct}%)`));
        arc.appendChild(arcTitle);
        svg.appendChild(arc);
        offset += length;
      });
      const cookPct = Math.round((rows[0].count / total) * 1000) / 10;
      const cookLabel = svgElement('text', {
        x: 70,
        y: 66,
        'text-anchor': 'middle',
        'font-size': '11',
        'font-weight': '900',
        fill: 'currentColor'
      });
      cookLabel.appendChild(svgText('下厨率'));
      const cookValue = svgElement('text', {
        x: 70,
        y: 82,
        'text-anchor': 'middle',
        'font-size': '14',
        'font-weight': '900',
        class: 'dafan-chart-cook-value'
      });
      cookValue.appendChild(svgText(`${cookPct}%`));
      svg.appendChild(cookLabel);
      svg.appendChild(cookValue);
      wrap.replaceChildren(svg);
    };
    // 饱腹条统一口径：颜色、图例、百分比全部来自后端 satietySummary 的 category/percent，
    // 分母固定为同一周期的 recordedCount；空记录时不画任何比例段。
    const SATIETY_SEGMENTS = [
      {
        category: 'COMFORTABLE',
        color: '#6ABF69',
        legendClass: 'dafan-legend-comfortable',
        label: '七八分饱舒适刚好',
        percentKey: 'comfortablePercent'
      },
      {
        category: 'LOW',
        color: '#FFC53D',
        legendClass: 'dafan-legend-low',
        label: '三五分饱偏少',
        percentKey: 'lowPercent'
      },
      {
        category: 'OVER',
        color: '#FF6B57',
        legendClass: 'dafan-legend-over',
        label: '十分饱偏撑',
        percentKey: 'overPercent'
      }
    ];
    const renderSatiety = (satiety) => {
      const bar = document.getElementById('satietyBarContainer');
      const legend = bar?.nextElementSibling;
      const recorded = Number(satiety?.recordedCount) || 0;
      if (!bar) return;
      if (!Number.isFinite(recorded) || recorded <= 0) {
        const empty = document.createElement('div');
        empty.className = 'w-full text-center text-xs text-stone-400';
        empty.textContent = '暂无饱腹数据';
        bar.replaceChildren(empty);
        if (legend) legend.textContent = '';
        setStat('statSatietyScore', null);
        return;
      }
      // 后端 percent/count 只作为数据源：非有限数值一律按本地分母重算，绝不拼进 HTML
      const safeCount = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
      const percentText = (value, fallbackCount) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? `${Math.round(numeric * 10) / 10}%` : `${fallbackCount}%`;
      };
      const segments = SATIETY_SEGMENTS.map((segment) => ({
        ...segment,
        count: (Array.isArray(satiety.distribution) ? satiety.distribution : [])
          .filter((bucket) => bucket && bucket.category === segment.category)
          .reduce((sum, bucket) => sum + safeCount(bucket.count), 0)
      }));
      const bars = segments
        .filter((segment) => segment.count > 0)
        .map((segment) => {
          const node = document.createElement('div');
          node.dataset.satietyCategory = segment.category;
          node.dataset.satietyCount = String(segment.count);
          node.title = `${segment.label} ${segment.count}次`;
          node.setAttribute('style', `width:${(segment.count / recorded) * 100}%;background:${segment.color}`);
          node.className = 'h-full';
          return node;
        });
      bar.replaceChildren(...bars);
      if (legend) {
        const legendNodes = segments.map((segment) => {
          const item = document.createElement('span');
          item.dataset.satietyLegend = segment.category;
          item.className = segment.legendClass;
          const localPct = `${Math.round((segment.count / recorded) * 1000) / 10}%`;
          item.textContent = `● ${segment.label} (${percentText(satiety[segment.percentKey], localPct)})`;
          return item;
        });
        legend.replaceChildren(...legendNodes);
      }
      const comfortablePercent = Number(satiety.comfortablePercent);
      if (Number.isFinite(comfortablePercent)) {
        const display = Math.round(comfortablePercent * 10) / 10;
        setStat('statSatietyScore', `舒适达标 ${display}% · 已记录 ${recorded} 次`);
      } else {
        const localComfortable = Math.round((segments[0].count / recorded) * 1000) / 10;
        setStat('statSatietyScore', `已记录 ${recorded} 次（舒适达标 ${localComfortable}%）`);
      }
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
        // 均价分母只用 cost != null 的记录数（后端 takeoutPricedCount / dineInPricedCount），
        // 未填金额的餐次不再稀释人均；分母为 0 时不显示均价。
        // 后端字段名兼容：takeoutPricedCount（当前实现）与 takeoutPricedRecordCount（契约命名）
        const pricedCount = (...candidates) => {
          const value = candidates.find((candidate) => Number.isSafeInteger(candidate) && candidate >= 0);
          return value === undefined ? null : value;
        };
        const takeoutPricedCount = pricedCount(cost.takeoutPricedCount, cost.takeoutPricedRecordCount);
        const dineInPricedCount = pricedCount(cost.dineInPricedCount, cost.dineInPricedRecordCount);
        const takeoutAverage = average(cost.takeoutCost, takeoutPricedCount);
        const dineInAverage = average(cost.dineInCost, dineInPricedCount);
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
    if (satietyDisplay) satietyDisplay.replaceChildren();
    if (satietyDisplay?.nextElementSibling) satietyDisplay.nextElementSibling.textContent = '';
    const calorieDisplay = document.getElementById('chartCalorieTrendWrap');
    if (calorieDisplay) calorieDisplay.replaceChildren();
    const donutDisplay = document.getElementById('chartChannelDonutWrap');
    if (donutDisplay) donutDisplay.replaceChildren();
    originalCalendar?.();
  }
  function wireLegacyEntryPoints() {
    const modal = window.BentoModal;
    if (!modal || typeof modal.open !== 'function' || modal.__google2Wired) return;
    // 快捷消耗按钮已改为按单位维度动态生成（setupIngredientDetail 内绑定闭包），
    // 这里只兜底「全部用完」，静态 100g/250g 不再作为唯一入口。
    const consumeAll = document.getElementById('ingredientDetailConsume-all');
    if (consumeAll && !consumeAll.onclick) {
      consumeAll.onclick = () => {
        Promise.resolve(window.BentoService.pantry.consume(modal.currentPayload, 'all')).catch(() => undefined);
      };
    }
    document.querySelectorAll('#modalRecipeDetail button[onclick*="cookCheckin"]').forEach((button) => {
      button.onclick = () => window.BentoService.recipes.cookCheckin(modal.currentPayload);
    });
    // Remote detail payloads are DTO objects; legacy setup methods look up by id.
    // Keep the DTO in currentPayload for actions, normalize only the setup lookup.
    // 食材详情 setup 同时接受 id 与已映射对象，不再把对象降级成 id（避免缓存竞态丢数据）
    for (const method of ['setupStoreDetail', 'setupRecipeDetail']) {
      if (typeof modal[method] !== 'function') continue;
      const setup = modal[method].bind(modal);
      modal[method] = (payload) => setup(payload && typeof payload === 'object' ? payload.id : payload);
    }
    const originalOpen = modal.open.bind(modal);
    const originalClose = typeof modal.close === 'function' ? modal.close.bind(modal) : null;
    let currentDiaryDate = null;
    let recordFormContext = null;
    installRecipeCoverControls();
    const originalSetupDailyDiary =
      typeof modal.setupDailyDiary === 'function' ? modal.setupDailyDiary.bind(modal) : null;
    // 菜谱表单：标题 icon 由 index 的 setupRecipeForm 重置；封面生命周期由 adapter 在其后接管。
    // 新建清空、编辑回显既有合法封面，绝不残留上一次会话的选择/预览。
    if (typeof modal.setupRecipeForm === 'function') {
      const originalSetupRecipeForm = modal.setupRecipeForm.bind(modal);
      modal.setupRecipeForm = (payload) => {
        const result = originalSetupRecipeForm(payload);
        const recipeId = typeof payload === 'object' && payload ? payload.id : payload;
        resetRecipeCoverState(recipeId ? modalRecipeService()?.getById?.(recipeId) : null);
        rotateRecipeFormSession();
        return result;
      };
    }
    if (originalSetupDailyDiary) {
      // index.html 的日记视图已按字段渲染 null（空串），这里只跟踪合法业务日期供录入入口使用，
      // 不再按卡片索引补清理 DOM：按索引取记录会因标题/分组节点错位，replaceAll('null') 会篡改真实文本。
      modal.setupDailyDiary = (payload) => {
        const parts = payload ? businessDateParts(payload.year, payload.month, payload.day) : null;
        currentDiaryDate = payload && parseBusinessDate(parts) ? parts : null;
        return originalSetupDailyDiary(payload);
      };
    }
    /** 当日日记弹窗内「补记一餐」专用入口标记（与 index 的 DIARY_DATE_ENTRY 同一字面量）。 */
    const DIARY_ENTRY_MARKER = '__dailyDiaryEntry__';
    modal.open = async (name, payload = null, opener = null) => {
      modal.__google2CookContext = null;
      // D-001：只有「日记弹窗内补记」入口可以携带选中日期（专用标记或当前栈顶为 dailyDiary）；
      // 其他任何入口先清空，避免从「饮食记录」页新建时把上一次点开的日历日期串写进去。
      const isCookEntry = Boolean(payload && typeof payload === 'object' && payload.__cookRecipe);
      if (
        name === 'recordForm' &&
        !isCookEntry &&
        opener !== DIARY_ENTRY_MARKER &&
        modal.getTop?.()?.name !== 'dailyDiary'
      ) {
        currentDiaryDate = null;
      }
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
      // 详情页编辑按钮传入 currentPayload 对象；门店/菜谱 setup 只接受 id，
      // 食材/购物/工具 setup 能直接读对象（且需要真实 version 之外的本地字段），这里只归一化前两者。
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
        const formNode = document.getElementById('modalRecipeForm');
        const formWasOpen = !!formNode && !formNode.classList.contains('hidden');
        const result = originalClose(...args);
        // 菜谱表单真正关闭（非脏检查拦截）时递增代次并释放本地预览 objectURL
        if (formWasOpen && formNode && formNode.classList.contains('hidden')) {
          resetRecipeCoverState(null);
          rotateRecipeFormSession();
        }
        recordFormContext = null;
        modal.__google2CookContext = null;
        resetRecordPhotoState([]);
        // 只有日记上下文真正消失后才清空选中日期：关闭记录表单返回日记时仍沿用该日。
        if (modal.getTop?.()?.name !== 'dailyDiary') currentDiaryDate = null;
        return result;
      };
    }
    /**
     * 提交收尾的所有 UI 副作用（关窗、toast）只属于「本次提交仍拥有当前表单」的会话：
     * 保存请求一旦发出就无法撤回，服务端写入照常发生，这里只禁止旧请求污染新会话界面。
     */
    if (modal.handleRecipeFormSubmit)
      modal.handleRecipeFormSubmit = (event) => {
        // 会话在提交入口处捕获：旧会话的在途提交不会阻塞新会话提交（见 withSubmitGuard）
        const submitSession = recipeFormSession;
        const ownsCurrentSession = () => recipeFormSession === submitSession;
        return withSubmitGuard(
          event,
          async () => {
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
            // 封面会话代次：上传/保存全程捕获，代次变化即视为用户已关闭或重开表单
            const coverGeneration = recipeCoverState.generation;
            const ownsCurrentForm = () =>
              recipeFormSession === submitSession && recipeCoverState.generation === coverGeneration;
            const imagePath = await resolveRecipeCoverImagePath(existing, {
              generation: coverGeneration,
              file: recipeCoverState.file,
              removed: recipeCoverState.removed
            });
            if (recipeCoverState.generation !== coverGeneration)
              throw new ApiError(409, 'RECIPE_COVER_CHANGED', '封面已更换，本次保存未提交');
            const save = (saveOptions) =>
              modalRecipeService().save(
                {
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
                  imagePath,
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
                                  String(ingredient.name ?? ingredient.originalName ?? '').trim() ===
                                  row.dataset.originalName
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
                },
                saveOptions
              );
            return save({
              // 完成时求值：只有仍拥有当前表单会话的请求才允许关窗/提示
              shouldClose: ownsCurrentForm,
              shouldNotify: ownsCurrentForm
            });
          },
          { session: submitSession }
        ).catch((error) => {
          // 失败提示同样只属于当前表单会话：旧请求的 4xx/5xx 不得弹到用户已重开的新表单上。
          if (!ownsCurrentSession()) return undefined;
          return fail(error);
        });
      };
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
          const read = (id) => document.getElementById(id);
          const id = read('formIngId')?.value.trim() || '';
          const payload = {
            name: read('formIngName')?.value.trim() || '',
            category: read('formIngCategory')?.value || '',
            // 未改图标时保留上传封面；用户选择新图标时才替换。
            icon: (() => {
              const field = read('formIngIcon');
              const original = field?.dataset.originalImagePath;
              return id && isSafeUploadedCoverUrl(original) && field.value === field.dataset.initialIcon
                ? original
                : field?.value || '';
            })(),
            storageLocation: read('formIngLocation')?.value ?? '',
            stock: (() => {
              const raw = String(read('formIngStockNum')?.value ?? '').trim();
              return raw === '' ? null : Number(raw);
            })(),
            unit: read('formIngStockUnit')?.value || '',
            minStock: (() => {
              const raw = String(read('formIngMinStock')?.value ?? '').trim();
              if (raw === '') return null;
              const value = Number(raw);
              if (!Number.isFinite(value) || value < 0)
                throw new ApiError(422, 'INGREDIENT_MIN_STOCK_INVALID', '最低库存必须是不小于 0 的数字');
              return value;
            })(),
            purchaseDate: read('formIngPurchaseDate')?.value || null,
            // 只有页面确实存在到期日期控件时才传该字段；缺失控件的旧 fixture 走「剩余天数」
            ...(read('formIngExpireDate') ? { expireDate: read('formIngExpireDate').value || null } : {}),
            expireDaysLeft: (() => {
              const raw = String(read('formIngExpireDays')?.value ?? '').trim();
              // 0 与负数都是合法语义（今日到期 / 已过期），只有空串表示未填写
              if (raw === '') return null;
              const days = Number(raw);
              if (!Number.isFinite(days)) throw new ApiError(422, 'INGREDIENT_EXPIRY_INVALID', '剩余天数必须是数字');
              return days;
            })()
          };
          if (id) payload.id = id;
          return window.BentoService.pantry.save(payload);
        }).catch(fail);
    if (modal.handleShoppingFormSubmit)
      modal.handleShoppingFormSubmit = (event) =>
        withSubmitGuard(event, async () => {
          event.preventDefault();
          const id = document.getElementById('formShopId')?.value.trim() || '';
          const name = document.getElementById('formShopName')?.value.trim() || '';
          const category = document.getElementById('formShopCategory')?.value || '';
          const amount = document.getElementById('formShopAmount')?.value.trim() || '';
          if (!name) throw new ApiError(422, 'SHOPPING_ITEM_INVALID', '采购物品名称不能为空');
          // 编辑：真实 PUT 更新（名称/分类/规格），绝不新建重复行
          const parsed = parseShoppingAmount(amount);
          if (id) {
            // 规格可无损解析为「数量+标准单位」时写结构化字段，否则保留自由规格原文
            return window.BentoService.shopping.updateItem(
              id,
              parsed
                ? { ingredientName: name, category, quantity: parsed.quantity, unit: parsed.unit }
                : { ingredientName: name, category, amountText: amount || null }
            );
          }
          return window.BentoService.shopping.add({
            name,
            category,
            amount: amount || '1份',
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
            // 新建记录：日记入口用选中日期，其余入口用真实今天（后端缺省也是本地业务日）
            date: id ? undefined : currentDiaryDate || localDateKey(0),
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
              // cook-checkin 是独立入口：沿用日记选中日期（若有），否则今天
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
            // cook-checkin 也是真实写成功：与 records 域其它写入一致标记首页脏，
            // 首页可见时刷新、不可见时只留待切回首页再刷新（P1-7）。
            markDashboardDirty();
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
          const id = document.getElementById('formToolId')?.value.trim() || '';
          const payload = {
            name: document.getElementById('formToolName')?.value.trim() || '',
            icon: document.getElementById('formToolIcon')?.value || '',
            category: document.getElementById('formToolCategory')?.value || '',
            status: document.getElementById('formToolStatus')?.value || '',
            notes: document.getElementById('formToolNotes')?.value.trim() || ''
          };
          // 编辑：带真实 id → tools.save 走 PUT；新建才 POST
          if (id) payload.id = id;
          return window.BentoService.tools.save(payload);
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
      if (session?.valid === true && session.token) storePinToken(session.token);
      return session;
    } catch (error) {
      if (error?.status === 401 && error?.code === 'UNAUTHORIZED') return ensurePinUnlock();
      throw error;
    }
  }
  function boot() {
    clearMockState();
    // adapter 自持的主题语义类不依赖任何模态/列表初始化，先注入（幂等）
    installAdapterThemeStyles();
    // 只有正式入口存在解锁界面时才启动会话探测；单元 fixture/嵌入式片段不应凭空占用业务请求序列。
    if (document.getElementById('modalPinUnlock')) void syncPinSession().catch(fail);
    blockUnconnectedWrites();
    installDashboardRefresh();
    wireDomain();
    loadDashboard().catch(fail);
    wireSettings().catch(fail);
  }
  function wheelRecommendationBody(mode) {
    const body = { dinerIds: activeDiners.map((diner) => diner.id) };
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
  /** 空候选引导按当前模式指向真实入口：下厨→我的菜谱，堂食/外卖→觅食小馆。 */
  const WHEEL_EMPTY_GUIDE = {
    cook: '当前分类下暂无下厨菜谱，先去【我的菜谱】添加吧',
    dinein: '当前分类下暂无堂食店铺，先去【觅食小馆】添加吧',
    takeout: '当前分类下暂无外卖店铺，先去【觅食小馆】添加吧'
  };
  const WHEEL_EMPTY_GUIDE_FALLBACK = '转盘候选为空，先去添加菜谱或店铺吧';
  /**
   * 请求等待期并发锁：同一时刻只允许一次落点解析在途；重复点击直接返回 null（不排队、不重复请求），
   * 避免两次推荐结果交替写扇区。
   *
   * 忙态所有权：inline `triggerSpin` 会先置 `disabled + aria-busy` 再调用 adapter，此时忙态属于
   * inline 整轮锁（切页/复位由 `setWheelBusy(false)` 清理）。adapter 只在按钮确实空闲时才亲手
   * 上锁并记录所有权，释放时只收回自己写的状态；绝不把别人已清理的 `aria-busy` 重新写回 true
   * （曾导致切页后又返回转盘：disabled=false 但 aria-busy=true，锁被判定未释放）。
   * 直接调用 `resolveTargetIndex`（无 inline 锁）时仍由 adapter 自己提供等待期保护。
   */
  function setWheelWaiting(waiting, ownerId) {
    const button = document.getElementById('wheelGoBtn');
    if (!button) return;
    if (waiting) {
      button.dataset.wheelWaiting = 'true';
      // 等待标记记录所属请求：只有当前请求才能释放它，旧请求的 finally 不得清掉新请求的忙态
      button.dataset.wheelWaitingOwner = String(ownerId);
      // 已被他人（inline 整轮锁）置忙：不接管、不记录原值，释放时一个字节都不动
      if (button.getAttribute('aria-busy') === 'true') return;
      button.dataset.wheelBusyOwned = 'true';
      button.setAttribute('aria-busy', 'true');
      if (button.disabled === false) {
        button.dataset.wheelDisabledOwned = 'true';
        button.disabled = true;
      }
      return;
    }
    // 所有权校验：旧请求晚到的释放不得覆盖新请求的等待标记或忙态
    if (ownerId != null && button.dataset.wheelWaitingOwner !== String(ownerId)) return;
    if (button.dataset.wheelBusyOwned === 'true') {
      delete button.dataset.wheelBusyOwned;
      button.removeAttribute('aria-busy');
    }
    if (button.dataset.wheelDisabledOwned === 'true') {
      button.disabled = false;
      delete button.dataset.wheelDisabledOwned;
    }
    delete button.dataset.wheelWaiting;
    delete button.dataset.wheelWaitingOwner;
  }
  async function resolveWheelTargetIndexOnce(mode, request) {
    // 已作废的请求：不发新提示、不写扇区，直接按「无落点」返回，由调用方丢弃
    const cancelled = () => !!request && request.cancelled === true;
    const notify = (message, type) => {
      if (!cancelled()) toast(message, type);
    };
    if (!dinersReady) {
      try {
        await loadActiveDiners();
      } catch (error) {
        if (!cancelled()) fail(error);
        return null;
      }
    }
    const items = window.getDynamicWheelItems ? window.getDynamicWheelItems() : [];
    if (!items.length) {
      notify(WHEEL_EMPTY_GUIDE[mode] || WHEEL_EMPTY_GUIDE_FALLBACK, 'info');
      return null;
    }
    let payload;
    try {
      payload = await ApiClient.post('/recommendations/random', wheelRecommendationBody(mode));
    } catch (error) {
      if (!cancelled()) fail(error);
      return null;
    }
    if (cancelled()) return null;
    const results = payload?.results || [];
    // 本轮已排除项不得通过远程推荐重新进入结果：按排除集合过滤后取第一个有效结果
    const isExcluded = (item) => (window.isWheelItemExcluded ? window.isWheelItemExcluded(item) : false);
    const pick = results.find((result) => {
      const service = result.resultType === 'STORE' ? window.BentoService?.stores : window.BentoService?.recipes;
      const cached = service?.getById?.(result.resultId);
      return (
        allowsDinerCandidate(cached || { name: result.title || result.name }) &&
        !isExcluded({
          type: result.resultType === 'STORE' ? 'store' : 'recipe',
          id: result.resultId,
          title: result.title || result.name || ''
        })
      );
    });
    if (!pick) {
      notify(
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
      notify('推荐结果已被排除，暂不落到该扇区', 'info');
      return null;
    }
    const remoteService = pick.resultType === 'STORE' ? window.BentoService?.stores : window.BentoService?.recipes;
    const cached = remoteService?.getById ? remoteService.getById(pick.resultId) : null;
    if (!cached) {
      notify('推荐结果无法映射到当前转盘候选', 'error');
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
  /**
   * 对外落点入口：请求在途时直接拒绝并发调用（不排队、不重复请求、不重复起转）。
   * 调用方（inline triggerSpin）负责旋转期 isSpinning 锁；adapter 负责「请求等待」这一段的
   * 并发锁与按钮 disabled / aria-busy，保证等待期重复点击不会产生第二次推荐请求。
   *
   * 作用域失效：切页 / 切模式（inline 已作废本轮）时调用 cancelPending()，当前请求对象立即
   * 标记 cancelled 并释放等待锁，下一次点击可立刻发起新请求；被取消的旧请求即使稍后落定，
   * 也不得写扇区、不弹 toast、不释放新请求的锁（以请求对象 identity 判断所有权）。
   */
  let wheelResolveRequest = null;
  let wheelResolveRequestSeq = 0;
  function resolveWheelTargetIndex(mode) {
    // 保留同一当前请求的重复调用保护：返回 null 而不是复用同一 promise，避免调用方重复起转
    if (wheelResolveRequest && !wheelResolveRequest.cancelled) return Promise.resolve(null);
    const request = { id: (wheelResolveRequestSeq += 1), mode, cancelled: false, promise: null };
    wheelResolveRequest = request;
    setWheelWaiting(true, request.id);
    request.promise = resolveWheelTargetIndexOnce(mode, request).finally(() => {
      // 只有仍是当前请求（且未被取消）才收回忙态；旧请求 late-settle 不得覆盖新请求
      if (wheelResolveRequest !== request) return;
      wheelResolveRequest = null;
      setWheelWaiting(false, request.id);
    });
    return request.promise;
  }
  /** 作废当前在途请求的作用域并立即释放等待锁；返回是否确有请求被取消。 */
  function cancelWheelPending() {
    const request = wheelResolveRequest;
    if (!request || request.cancelled) return false;
    request.cancelled = true;
    wheelResolveRequest = null;
    setWheelWaiting(false, request.id);
    return true;
  }
  sanitizeStaticBusinessState();
  window.DafanApiClient = ApiClient;
  window.DafanPinAdapter = { ensurePinUnlock, cancelPinUnlock, syncPinSession, pinCooldownSeconds };
  window.DafanDashboardAdapter = {
    mapDashboard,
    loadDashboard,
    refreshDashboard,
    isHomeVisible,
    installDashboardRefresh
  };
  window.DafanSettingsAdapter = { loadSettings, wireSettings, openPinSettings, closePinSettings, submitPinSettings };
  window.DafanDinerAdapter = {
    loadActiveDiners,
    openTabooSettings,
    closeTabooSettings,
    submitTabooSettings,
    tokens: tabooTokens,
    allows: allowsDinerCandidate,
    isReady: () => dinersReady,
    dinerIds: () => activeDiners.map((diner) => diner.id)
  };
  window.DafanWheelAdapter = {
    resolveTargetIndex: resolveWheelTargetIndex,
    cancelPending: cancelWheelPending,
    recommendationBody: wheelRecommendationBody
  };
  window.DafanCoverAdapter = coverStatusAdapter();
  window.DafanIngredientAdapter = {
    INGREDIENT_CATEGORIES,
    INGREDIENT_CATEGORY_ICONS,
    normalizeIngredientCategory,
    deriveIngredientIcon,
    isIngredientEmoji
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

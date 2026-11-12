import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

/**
 * VAN-37 回归测试：临期区域（以及同机制的所有动态插槽）空行 / 布局异常。
 *
 * 缺陷机理（已在真实 Chrome 复现并记录）：
 * - 数据适配器 app/client/public/google2-adapter.js 用 `el.hidden = true` 隐藏“没有真实数据”的动态插槽
 *   （临期食材行 expiringIngredient-N、日历日格 calendarDay-N / mobileCalendarDay-N 等）。
 * - 这些插槽本身带 Tailwind 的 display 工具类（flex / grid …），而 Tailwind 由 CDN 在页面加载后**运行时注入**
 *   author 样式，位置在页面自带 <style> 之后。
 * - 浏览器默认的 `[hidden] { display: none }` 属于 UA 样式，优先级低于任何 author 规则；页面里也没有属性级兜底，
 *   于是属性隐藏了、元素却仍以 display:flex 参与布局，占出 22px 的空白行。
 *
 * 关于 jsdom：jsdom 的 getComputedStyle 不实现 `!important` 的层叠（跨样式表时后出现者胜出），
 * 因此**不能**用它判定本修复是否生效。本文件用确定性的 CSS 层叠模型（important > specificity > 顺序；
 * 内联样式视为最高特异性的普通声明）来断言 display 归属；真实浏览器中的像素/高度证据由
 * scripts/check-google2-hidden-layout.mjs 提供（desktop/mobile × 有数据/无数据）。
 */

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = resolve(testsDirectory, '../index.html');
const indexHtml = readFileSync(indexHtmlPath, 'utf8');
const adapterSource = readFileSync(resolve(testsDirectory, '../public/google2-adapter.js'), 'utf8');

/** 适配器用 hidden 属性统一控制显隐的动态插槽选择器。 */
const dynamicSlotSelectors = [
  '[data-binding^="expiringIngredient-"]',
  '[data-binding="calendarDays"] [data-binding^="calendarDay-"]',
  '.mobile-week-calendar-list [data-binding^="mobileCalendarDay-"]',
  '[data-binding="todayRecords"] [data-binding^="todayRecord-"]',
  '[data-binding="recommendedRecipes"] > div'
];

/** 页面用到的 display 工具类集合（只影响 display 的类）。 */
const displayUtilityClasses = new Set([
  'flex',
  'grid',
  'block',
  'inline-flex',
  'inline-block',
  'inline-grid',
  'hidden'
]);

/** 去除页面自带的属性级 [hidden] 规则，用于反证测试。 */
function withoutHiddenAttributeRule(html: string): string {
  return html.replace(/\s*\[hidden\]\s*\{[^}]*\}/g, '');
}

function buildDom(html: string): JSDOM {
  return new JSDOM(html, { pretendToBeVisual: true });
}

/**
 * 仿照 Tailwind CDN 的行为：把页面上真实出现的 display 工具类，以 author 样式追加到页面尾部。
 * 这重现了“工具类比页面自带样式更晚出现”的真实顺序。
 */
function injectDisplayUtilities(dom: JSDOM, selectors: string[]): void {
  const document = dom.window.document;
  const classes = new Set<string>();
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((element) => {
      element.classList.forEach((className) => {
        if (displayUtilityClasses.has(className)) classes.add(className);
      });
    });
  }
  const style = document.createElement('style');
  style.textContent = Array.from(classes)
    .map((className) => `.${className} { display: ${className === 'hidden' ? 'none' : className}; }`)
    .join('\n');
  document.head.appendChild(style);
}

/** 优先级的三段特异性 [id, class/属性/伪类, 类型]；内联样式另行表示为 [1,0,0,0]。 */
type Specificity = number[];

interface Priority {
  important: boolean;
  specificity: Specificity;
  order: number;
}

function selectorSpecificity(selector: string): Specificity {
  const withoutPseudoElements = selector.replace(/::[a-z-]+(\([^)]*\))?/g, '');
  const ids = (withoutPseudoElements.match(/#[\w-]+/g) ?? []).length;
  const classesAndAttributes =
    (withoutPseudoElements.match(/\.[\w-]+/g) ?? []).length +
    (withoutPseudoElements.match(/\[[^\]]+\]/g) ?? []).length +
    (withoutPseudoElements.match(/:(?!:)[a-z-]+(\([^)]*\))?/g) ?? []).length;
  const types = (withoutPseudoElements.match(/(^|[\s>+~])([a-z][\w-]*)/gi) ?? []).length;
  return [ids, classesAndAttributes, types];
}

function comparePriority(left: Priority, right: Priority): number {
  if (left.important !== right.important) return left.important ? 1 : -1;
  for (let i = 0; i < 3; i += 1) {
    if (left.specificity[i] !== right.specificity[i]) return left.specificity[i] - right.specificity[i];
  }
  return left.order - right.order;
}

function splitSelectors(selectorText: string): string[] {
  return selectorText
    .split(',')
    .map((selector) => selector.trim())
    .filter(Boolean);
}

/**
 * 对单个元素、单个属性（display）做确定性层叠求解：
 * 返回胜出声明的来源信息；内联样式作为 (1,0,0,0) 特异性的普通声明参与比较。
 */
function resolveDisplay(
  element: Element,
  window: JSDOM['window']
): { value: string; source: string; important: boolean } | null {
  let winner: { value: string; source: string; important: boolean } | null = null;
  let winnerPriority: Priority | null = null;
  let order = 0;

  const consider = (declaration: { value: string; important: boolean; specificity: Specificity; source: string }) => {
    order += 1;
    const priority: Priority = { important: declaration.important, specificity: declaration.specificity, order };
    if (!winnerPriority || comparePriority(priority, winnerPriority) > 0) {
      winnerPriority = priority;
      winner = { value: declaration.value, source: declaration.source, important: declaration.important };
    }
  };

  const visitRules = (rules: CSSRuleList, mediaMatches: boolean) => {
    for (const rule of Array.from(rules)) {
      if (rule.type === 4 /* CSSMediaRule */) {
        const mediaRule = rule as CSSMediaRule;
        const matches = mediaMatches && Boolean(window.matchMedia?.(mediaRule.conditionText).matches);
        visitRules(mediaRule.cssRules, matches);
        continue;
      }
      if (rule.type !== 1 /* CSSStyleRule */) continue;
      if (!mediaMatches) continue;
      const styleRule = rule as CSSStyleRule;
      if (!splitSelectors(styleRule.selectorText).some((selector) => element.matches(selector))) continue;
      for (const property of Array.from(styleRule.style)) {
        if (property !== 'display') continue;
        consider({
          value: styleRule.style.getPropertyValue(property).trim(),
          important: styleRule.style.getPropertyPriority(property) === 'important',
          specificity: selectorSpecificity(styleRule.selectorText),
          source: styleRule.selectorText
        });
      }
    }
  };

  for (const sheet of Array.from(window.document.styleSheets)) {
    const rules = sheet.cssRules;
    if (rules) visitRules(rules, true);
  }

  const inlineDisplay = (element as HTMLElement).style.getPropertyValue('display').trim();
  if (inlineDisplay) {
    consider({
      value: inlineDisplay,
      important: (element as HTMLElement).style.getPropertyPriority('display') === 'important',
      specificity: [1, 0, 0, 0],
      source: 'inline'
    });
  }

  return winner;
}

function hiddenSlots(html: string, selectors: string[]) {
  const dom = buildDom(html);
  injectDisplayUtilities(dom, selectors);
  const elements: Array<{ selector: string; element: Element }> = [];
  for (const selector of selectors) {
    dom.window.document.querySelectorAll(selector).forEach((element) => {
      element.hidden = true;
      elements.push({ selector, element });
    });
  }
  const measured = elements.map(({ selector, element }) => ({
    selector,
    hidden: (element as HTMLElement).hidden,
    classes: Array.from(element.classList),
    resolved: resolveDisplay(element, dom.window)
  }));
  dom.window.close();
  return measured;
}

describe('VAN-37 动态插槽 hidden 属性必须真正隐藏（不被 Tailwind display 工具类覆盖）', () => {
  it('页面提供了属性级 [hidden] 兜底规则且带 !important', () => {
    const dom = buildDom(indexHtml);
    const css = Array.from(dom.window.document.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n');
    dom.window.close();

    expect(css).toMatch(/\[hidden\][^{}]*\{[^}]*display:\s*none\s*!important[^}]*\}/);
  });

  it('存在真实的 display 工具类冲突前提（插槽本身带 flex/grid 等类）', () => {
    const dom = buildDom(indexHtml);
    const conflicted: string[] = [];
    for (const selector of dynamicSlotSelectors) {
      dom.window.document.querySelectorAll(selector).forEach((element) => {
        const utility = Array.from(element.classList).filter((className) => displayUtilityClasses.has(className));
        if (utility.length > 0) conflicted.push(`${selector} -> ${utility.join(',')}`);
      });
    }
    dom.window.close();

    // 临期食材行与日历日格确实带 display 工具类，所以仅靠默认 [hidden] 规则不足以保证隐藏
    expect(conflicted.length).toBeGreaterThan(0);
    expect(conflicted.some((entry) => entry.startsWith('[data-binding^="expiringIngredient-"'))).toBe(true);
  });

  it('层叠求解：被 hidden 的插槽 display 最终归属 none（压过更晚出现的 display 工具类）', () => {
    const measured = hiddenSlots(indexHtml, dynamicSlotSelectors);
    expect(measured.length).toBeGreaterThan(0);

    for (const item of measured) {
      expect(item.hidden).toBe(true);
      expect(item.resolved?.value).toBe('none');
      expect(item.resolved?.important).toBe(true);
    }
  });

  it('反证：移除属性级兜底规则后，同一批插槽的 display 被工具类夺走（=真实缺陷机理）', () => {
    const measured = hiddenSlots(withoutHiddenAttributeRule(indexHtml), dynamicSlotSelectors);
    const covered = measured.filter((item) => item.resolved?.value !== 'none');

    expect(covered.length).toBeGreaterThan(0);
    for (const item of covered) {
      // 属性已隐藏，display 却被 .flex 之类夺走 —— 这正是“临期区域空行 / 布局异常”的成因
      expect(item.hidden).toBe(true);
    }
  });

  it('适配器仍只通过 hidden 属性控制这些插槽（未改成写入内联 display）', () => {
    for (const binding of ['expiringIngredient-', 'calendarDay-', 'mobileCalendarDay-', 'todayRecord-']) {
      expect(adapterSource).toContain(binding);
    }
    expect(adapterSource).toMatch(/\.hidden\s*=\s*(true|false|!)/);
    expect(adapterSource).not.toMatch(/style\.display\s*=\s*['"](none|flex)['"]/);
  });

  it('真实浏览器布局验证脚本存在，且覆盖 desktop/mobile 与有数据/无数据', () => {
    const script = readFileSync(resolve(testsDirectory, '../../../scripts/check-google2-hidden-layout.mjs'), 'utf8');
    expect(script).toContain('getComputedStyle');
    expect(script).toContain("name: 'desktop'");
    expect(script).toContain("name: 'mobile'");
    expect(script).toContain('withData');
    expect(script).toContain('withoutData');
  });
});

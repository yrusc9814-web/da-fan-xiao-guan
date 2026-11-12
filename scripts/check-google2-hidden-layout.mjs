#!/usr/bin/env node
/**
 * VAN-37 真实布局验证脚本：临期食材行（expiringIngredient-N）在无数据时必须真正隐藏、不再占据布局空间。
 *
 * 为什么需要独立脚本：
 * 原有风险点是“JS 里设置了 row.hidden = true 就算过”。但 hidden 属性在页面上被 Tailwind 的 display 工具类
 * （如 .flex）覆盖——author 样式优先级高于浏览器默认的 [hidden] { display: none }——所以元素仍然以 display:flex
 * 参与布局，占据空白行高度。是否真的隐藏，只能靠真实浏览器的 getComputedStyle / 布局高度判定，不能靠属性断言。
 *
 * 做法：用真实 Chrome（playwright, channel: chrome，headless）打开真实页面 app/client/index.html，
 * 复现适配器的写法（把临期行 hidden = true），在 desktop / mobile 两种视口下测量
 * 行自身的 display / 高度以及所在容器的高度贡献，并对比“有数据（hidden = false）”。
 *
 * 退出码：0 全部通过；1 存在失败项。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pageUrl = pathToFileURL(resolve(projectRoot, 'app/client/index.html')).href;

/**
 * playwright 仅作为本地验证工具使用，未写入 package.json / package-lock.json（本包不新增依赖）。
 * 因此这里做动态导入，并在缺失时给出明确出路，而不是抛出晦涩的 ERR_MODULE_NOT_FOUND。
 */
async function loadChromium() {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch {
    throw new Error(
      '本地缺少 playwright（本脚本刻意不写入依赖）。请在本机安装后重跑：npm i -D playwright（或使用已下载的 chromium），' +
        '否则 VAN-37 布局验证只能留待最终 Smoke 阶段在真实浏览器中执行。'
    );
  }
}

const chromium = await loadChromium();

/** 临期行容器的高度容忍值：隐藏后应当为 0（允许亚像素误差）。 */
const EMPTY_HEIGHT_TOLERANCE = 1;

const viewports = [
  { name: 'desktop', width: 1600, height: 1200 },
  { name: 'mobile', width: 390, height: 844 }
];

function measureScript() {
  // 在页面上下文中执行：测量临期行与容器的真实布局状态。
  return () => {
    const rows = Array.from(document.querySelectorAll('[data-binding^="expiringIngredient-"]'));
    const container = rows.length > 0 ? rows[0].parentElement : null;
    const measureRow = (row) => {
      const style = window.getComputedStyle(row);
      const rect = row.getBoundingClientRect();
      return {
        display: style.display,
        visibility: style.visibility,
        offsetHeight: row.offsetHeight,
        rectHeight: rect.height,
        hiddenAttribute: row.hidden,
        hasHiddenClass: row.classList.contains('hidden')
      };
    };
    return {
      rowCount: rows.length,
      rows: rows.map(measureRow),
      containerHeight: container ? container.getBoundingClientRect().height : -1,
      containerOffsetHeight: container ? container.offsetHeight : -1
    };
  };
}

async function measureWithRowsHidden(page, hidden) {
  await page.evaluate((shouldHide) => {
    // 与 google2-adapter.js 的写法保持一致：通过 hidden 属性（不是 class）隐藏临期行。
    document.querySelectorAll('[data-binding^="expiringIngredient-"]').forEach((row) => {
      row.hidden = shouldHide;
    });
  }, hidden);
  // 等一帧，确保布局完成
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate(measureScript());
}

/** 优先使用本机已安装的 Chrome，其次使用 playwright 自带的 chromium。 */
async function launchBrowser() {
  const attempts = [{ channel: 'chrome', headless: true }, { headless: true }];
  const errors = [];
  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      errors.push(`${options.channel ?? 'bundled chromium'}: ${error.message.split('\n')[0]}`);
    }
  }
  throw new Error(
    `无法启动真实浏览器，VAN-37 布局验证需要 Chrome 或已下载的 playwright chromium：\n${errors.join('\n')}`
  );
}

async function main() {
  const failures = [];
  const evidence = [];
  const browser = await launchBrowser();
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }
      });
      const page = await context.newPage();
      await page.goto(pageUrl, { waitUntil: 'load' });
      // Tailwind 由 CDN 脚本在运行时生成样式，必须等它真正生效后再测量；等待失败即视为验证失败（fail-closed），
      // 否则会把“根本没加载样式表”的空白环境误判成 PASS。
      const tailwindReady = await page
        .waitForFunction(
          () => {
            const card = document.querySelector('[data-binding="inventory"]');
            // 用页面上必然存在的 flex 类元素判断 Tailwind 是否已加载生效。
            return Boolean(card) && window.getComputedStyle(card).display === 'flex';
          },
          undefined,
          { timeout: 30000 }
        )
        .then(() => true)
        .catch(() => false);

      if (!tailwindReady) {
        failures.push(
          `[${viewport.name}] Tailwind（CDN）样式未在超时内生效，无法验证 display 工具类冲突，判定失败而非跳过`
        );
        evidence.push({ viewport: viewport.name, tailwindReady: false });
        await context.close();
        continue;
      }
      evidence.push({ viewport: viewport.name, tailwindReady: true });

      const withData = await measureWithRowsHidden(page, false);
      const withoutData = await measureWithRowsHidden(page, true);

      const record = { viewport: viewport.name, withData, withoutData };

      // 有数据：行必须真实可见、参与布局
      if (withData.rowCount < 2) {
        failures.push(
          `[${viewport.name}] 未找到 2 个临期行（data-binding="expiringIngredient-N"），实际 ${withData.rowCount}`
        );
      }
      for (const row of withData.rows) {
        if (row.display === 'none' || row.offsetHeight <= 0) {
          failures.push(
            `[${viewport.name}] 有数据时临期行未参与布局（display=${row.display}, height=${row.offsetHeight}）`
          );
        }
      }
      if (withData.containerHeight <= EMPTY_HEIGHT_TOLERANCE) {
        failures.push(`[${viewport.name}] 有数据时临期容器高度为 ${withData.containerHeight}，疑似未渲染`);
      }

      // 无数据：hidden 属性必须让行真正 display:none，且容器不再占据高度
      for (const row of withoutData.rows) {
        if (row.display !== 'none') {
          failures.push(
            `[${viewport.name}] 无数据时临期行仍以 display=${row.display} 参与布局（高度 ${row.offsetHeight}px）——hidden 属性被覆盖`
          );
        }
        if (row.offsetHeight > 0) {
          failures.push(`[${viewport.name}] 无数据时临期行仍占位 ${row.offsetHeight}px`);
        }
      }
      if (withoutData.containerHeight > EMPTY_HEIGHT_TOLERANCE) {
        failures.push(
          `[${viewport.name}] 无数据时临期容器仍占位 ${withoutData.containerHeight}px（有数据时 ${withData.containerHeight}px）`
        );
      }

      evidence.push(record);
      console.log(
        `[${viewport.name} ${viewport.width}x${viewport.height}] ` +
          `有数据: 容器高=${withData.containerHeight}px 行display=[${withData.rows.map((r) => r.display).join(',')}] | ` +
          `无数据: 容器高=${withoutData.containerHeight}px 行display=[${withoutData.rows.map((r) => r.display).join(',')}] ` +
          `行高=[${withoutData.rows.map((r) => r.offsetHeight).join(',')}]`
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log('');
  console.log(JSON.stringify({ evidence, failures }, null, 2));

  if (failures.length > 0) {
    console.error('');
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log('PASS VAN-37 临期区域隐藏布局：desktop / mobile 下无数据均不占位，有数据正常显示。');
}

await main();

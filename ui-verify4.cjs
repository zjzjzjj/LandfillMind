const { chromium } = require('playwright');
const OUT = 'E:/workbuddy file';
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  // 滚动到三维场地模型区块
  const section = page.locator('text=三维场地模型');
  if (await section.count()) await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/verify-10-3d-hero.png', fullPage: false });

  // 检查 HUD 文字是否挂载（HTML 层，不依赖 WebGL）
  const labels = ['三维场地数字孪生', '注气驱水井', '监测井', '绿色覆盖层', '污染羽', '拖拽旋转'];
  const found = {};
  for (const t of labels) found[t] = await page.locator(`text=${t}`).count();
  console.log('HUD 文字命中:', JSON.stringify(found));
  console.log('CONSOLE_ERRORS:', JSON.stringify(errors));
  await browser.close();
})();

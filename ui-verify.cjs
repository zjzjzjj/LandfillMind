const { chromium } = require('playwright');
const fs = require('fs');

const OUT = 'E:/workbuddy file';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  // 1) 首页（含 3D 场地模型）
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: OUT + '/verify-1-home.png' });

  // 2) 计算中心：选"注气驱替半径"并试算
  await page.goto('http://localhost:5173/design', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(800);
  const inj = page.locator('button:has-text("注气驱替半径")').first();
  if (await inj.count()) await inj.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/verify-2-design-form.png' });
  const calcBtn = page.locator('button:has-text("开始计算")').first();
  if (await calcBtn.count()) await calcBtn.click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: OUT + '/verify-3-design-result.png' });

  // 3) 多智能体：启动分析
  await page.goto('http://localhost:5173/multiagent', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(800);
  const run = page.locator('button:has-text("启动分析")').first();
  if (await run.count()) await run.click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: OUT + '/verify-4-multiagent.png' });

  console.log('CONSOLE_ERRORS:' + JSON.stringify(errors));
  await browser.close();
})().catch((e) => { console.error('SHOT_FAIL:' + e.message); process.exit(1); });

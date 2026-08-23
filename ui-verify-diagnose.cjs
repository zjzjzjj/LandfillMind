const { chromium } = require('playwright');
const OUT = 'E:/workbuddy file';
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:5173/diagnose', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  await page.locator('button:has-text("开始诊断")').click();
  await page.waitForTimeout(15000); // 等真实 LLM 详实报告
  await page.screenshot({ path: OUT + '/diagnose-detail.png', fullPage: true });

  const checks = ['综合研判报告', '逐项风险分析', '计算书', '分级处置建议', '监测与应急计划', '规范依据'];
  for (const t of checks) {
    const n = await page.locator(`text=${t}`).count();
    console.log(`[${t}] = ${n}`);
  }

  console.log('CONSOLE_ERRORS:', JSON.stringify(errors.slice(0, 6)));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });

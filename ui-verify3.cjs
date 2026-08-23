const { chromium } = require('playwright');
const OUT = 'E:/workbuddy file';

(async () => {
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  // 1) 首页 Hero 顶部
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/verify-7-home-hero.png' });
  console.log('首页 Hero 截图完成');

  // 2) 多智能体 Hero 顶部
  await page.goto('http://localhost:5173/multi-agent', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + '/verify-8-multiagent-hero.png' });
  console.log('多智能体 Hero 截图完成');

  // 3) 计算中心（验证亮色下整体观感）
  await page.goto('http://localhost:5173/design', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: OUT + '/verify-9-design.png' });
  console.log('计算中心截图完成');

  console.log('CONSOLE_ERRORS:' + JSON.stringify(errors));
  await browser.close();
})().catch(e => { console.error('SCRIPT_ERROR:', e); process.exit(1); });

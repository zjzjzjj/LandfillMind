const { chromium } = require('playwright');
const OUT = 'E:/workbuddy file';
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // 1) 改名检查：新名应出现，旧名应消失
  const bodyText = await page.evaluate(() => document.body.innerText);
  const hasNew = bodyText.includes('填埋场智慧监测');
  const hasOld = bodyText.includes('场地智诊') || bodyText.includes('SiteSmart');
  console.log('改名: 新名出现=', hasNew, ' 旧名残留=', hasOld);

  // 2) 滚到三维模型区
  const section = page.locator('text=三维场地模型').last();
  if (await section.count()) await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);

  // 3) 启动巡检漫游
  const roamBtn = page.locator('button:has-text("巡检漫游")');
  console.log('漫游按钮存在=', await roamBtn.count());
  await roamBtn.first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + '/roam-1.png', fullPage: false });

  const banner = await page.locator('text=巡检中').count();
  const stopBtn = await page.locator('button:has-text("停止巡检")').count();
  console.log('漫游中: 顶部提示=', banner, ' 停止按钮=', stopBtn);

  await page.waitForTimeout(5000);
  await page.screenshot({ path: OUT + '/roam-2.png', fullPage: false });
  const banner2 = await page.evaluate(() => document.body.innerText.match(/巡检中 \d\/\d · [^\n]*/)?.[0] || '无');
  console.log('当前站点=', banner2);

  await page.waitForTimeout(5000);
  await page.screenshot({ path: OUT + '/roam-3.png', fullPage: false });
  const banner3 = await page.evaluate(() => document.body.innerText.match(/巡检中 \d\/\d · [^\n]*/)?.[0] || '无');
  console.log('当前站点=', banner3);

  // 4) 模拟拖拽打断漫游
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
  }
  await page.waitForTimeout(800);
  const stopAfterDrag = await page.locator('button:has-text("巡检漫游")').count();
  const bannerAfterDrag = await page.locator('text=巡检中').count();
  console.log('拖拽后: 漫游按钮恢复=', stopAfterDrag > 0, ' 提示消失=', bannerAfterDrag === 0);

  console.log('CONSOLE_ERRORS:', JSON.stringify(errors.slice(0, 8)));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });

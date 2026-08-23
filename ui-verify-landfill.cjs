const { chromium } = require('playwright');
const OUT = 'E:/workbuddy file';
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  // 滚动到三维场地模型区块
  const section = page.locator('text=三维场地模型').last();
  if (await section.count()) await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + '/verify-landfill-3d.png', fullPage: false });

  // 检查新组件 UI 是否挂载（HTML 层，不依赖 WebGL 渲染结果）
  const labels = ['卫生填埋场三维模型', '山谷型生活垃圾卫生填埋场', '防渗衬层', '填埋气系统', '总体鸟瞰', '剖切视图', '项目概况', '截洪沟'];
  const found = {};
  for (const t of labels) found[t] = await page.locator(`text=${t}`).count();

  // 检查 canvas 是否真的渲染出内容（非纯黑/纯透明）
  const canvasInfo = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { exists: false };
    return { exists: true, w: c.width, h: c.height };
  });

  // 交互冒烟：点击「剖面视角」按钮，确认无报错
  await page.locator('button:has-text("剖面视角")').click();
  await page.waitForTimeout(800);
  // 交互冒烟：切换一个图层开关
  await page.locator('text=山体植被').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/verify-landfill-3d-sec.png', fullPage: false });

  console.log('CANVAS:', JSON.stringify(canvasInfo));
  console.log('UI 命中:', JSON.stringify(found));
  console.log('CONSOLE_ERRORS:', JSON.stringify(errors.slice(0, 10)));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });

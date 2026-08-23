const { chromium } = require('playwright');
const OUT = 'E:/workbuddy file';

(async () => {
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  // 1) 首页：滚动到 3D 区块，等渲染
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  // 滚动到"三维场地模型"标题
  const h2 = page.locator('h2:has-text("三维场地模型")');
  if (await h2.count()) {
    await h2.scrollIntoViewIfNeeded();
    await page.waitForTimeout(4000); // 等 WebGL 渲染
    await page.screenshot({ path: OUT + '/verify-5-3dscene.png' });
    console.log('3D 区块截图完成');
  } else {
    console.log('未找到 三维场地模型 标题');
  }

  // 2) 多智能体：启动分析，等待全部完成
  await page.goto('http://localhost:5173/multi-agent', { waitUntil: 'domcontentloaded' });
  let runBtn;
  try {
    runBtn = page.locator('button:has-text("启动分析")').first();
    await runBtn.waitFor({ state: 'visible', timeout: 15000 });
    console.log('找到 启动分析 按钮');
  } catch (e) {
    console.log('15s 内未找到 启动分析 按钮，dump 当前按钮文本：');
    const btns = await page.locator('button').allInnerTexts();
    console.log('页面按钮:', JSON.stringify(btns));
    runBtn = null;
  }
  if (runBtn) {
    await runBtn.click();
    console.log('已点击启动分析，等待 9s 让 5 个 Agent 完成...');
    await page.waitForTimeout(9000);
    await page.screenshot({ path: OUT + '/verify-6-multiagent-done.png', fullPage: true });
    // 统计"完成"徽章数量
    const done = await page.locator('text=完成').count();
    const errs = await page.locator('text=错误').count();
    console.log('完成徽章数量:', done, ' 错误徽章数量:', errs);
  }

  console.log('CONSOLE_ERRORS:' + JSON.stringify(errors));
  await browser.close();
})().catch(e => { console.error('SCRIPT_ERROR:', e); process.exit(1); });

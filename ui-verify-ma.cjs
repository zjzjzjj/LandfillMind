const { chromium } = require('playwright');
const OUT = 'E:/workbuddy file';
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:5173/multi-agent', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // 确认新标题
  const title = await page.locator('text=多智能体协同').count();
  console.log('页面标题「多智能体协同」=', title);

  // 启动分析
  await page.locator('button:has-text("启动分析")').click();
  await page.waitForTimeout(3000);

  // 检查 summary 初始为「等待同伴」
  const waiting = await page.locator('text=等待同伴').count();
  console.log('summary 初始等待同伴=', waiting > 0);

  // 等待领域 Agent 完成后 summary 才启动（真实 GLM 串行，约 12-30s）
  await page.waitForTimeout(35000);
  await page.screenshot({ path: OUT + '/multiagent-llm.png', fullPage: true });

  // 检查各卡片结果是否生成（非模板句式，含 GLM 生成内容）
  const doneCount = await page.locator('text=完成').count();
  const resultBlocks = await page.evaluate(() => {
    const cards = document.querySelectorAll('[class*="rounded-2xl"]');
    let n = 0;
    document.querySelectorAll('div').forEach(d => {
      const t = d.textContent || '';
      if (t.includes('72 小时') || t.includes('滑坡') || t.includes('处置优先级')) n++;
    });
    return n;
  });
  const summaryReport = await page.locator('text=综合诊断报告').count();
  console.log('完成徽章数=', doneCount, ' 含综合研判内容的节点=', resultBlocks, ' 综合报告区=', summaryReport);

  console.log('CONSOLE_ERRORS:', JSON.stringify(errors.slice(0, 8)));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });

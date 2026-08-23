import { chromium } from 'playwright';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:5173/design', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'F:/zj_F/LandfillMind/.debug/design-viewport-v2.png', fullPage: false });
  await page.screenshot({ path: 'F:/zj_F/LandfillMind/.debug/design-page-v2.png', fullPage: true });
  const info = await page.evaluate(() => {
    const out = {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      hasHorizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      elements: {}
    };
    const checks = ['立即计算', '参数输入', '计算结果', '敏感性分析', '公式推导', '导出计算书', 'v4.4'];
    for (const label of checks) {
      const el = Array.from(document.querySelectorAll('*')).find(e => e.children.length === 0 && e.textContent && e.textContent.trim() === label);
      if (el) {
        const r = el.getBoundingClientRect();
        out.elements[label] = {
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          inViewport: r.x >= 0 && r.x + r.width <= window.innerWidth + 5
        };
      } else {
        out.elements[label] = 'NOT FOUND';
      }
    }
    const main = document.querySelector('main');
    if (main) {
      const r = main.getBoundingClientRect();
      out.mainContent = { x: Math.round(r.x), w: Math.round(r.width) };
    }
    return out;
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
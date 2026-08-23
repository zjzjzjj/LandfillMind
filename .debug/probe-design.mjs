import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Collect console messages and errors
  page.on('console', (msg) => {
    console.log(`[BROWSER ${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    console.log(`[PAGE ERROR] ${err.message}`);
  });

  try {
    await page.goto('http://127.0.0.1:5173/design', { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    console.log(`[NAVIGATION ERROR] ${e.message}`);
  }
  await page.waitForTimeout(3000);

  // Viewport screenshot
  await page.screenshot({ path: 'F:/zj_F/LandfillMind/.debug/design-viewport.png', fullPage: false });
  // Full-page screenshot
  await page.screenshot({ path: 'F:/zj_F/LandfillMind/.debug/design-page.png', fullPage: true });

  // Gather info
  const info = await page.evaluate(() => {
    const result = {};
    result.url = location.href;
    result.title = document.title;
    result.bodyText = document.body.innerText.slice(0, 3000);

    // Get all main structural elements
    result.structure = {};
    for (const sel of ['aside', 'main', 'header', 'nav', 'footer', '[role="complementary"]', '[role="main"]']) {
      const els = document.querySelectorAll(sel);
      if (els.length) {
        result.structure[sel] = Array.from(els).map(el => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        });
      }
    }

    // Look for specific text contents
    result.findings = {};
    const findText = (txt) => {
      const all = Array.from(document.querySelectorAll('*'));
      const matches = all.filter(e => {
        // Only leaf-like elements with direct text
        const directText = Array.from(e.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
          return directText === txt || (directText.includes(txt) && e.children.length === 0);
      });
      return matches.map(el => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName, text: el.textContent.trim().slice(0, 50), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
      }).slice(0, 3);
    };

    const probes = ['参数输入', '计算结果', '敏感性分析', '公式推导', '立即计算', '设计参数', 'AI 解读', '安全系数', '坝高', '边坡', '浸润线', '案例管理', '导出', '运行', '方案', '基础数据'];
    for (const p of probes) {
      result.findings[p] = findText(p);
    }

    // Find the 计算 button
    result.buttons = {};
    const btns = Array.from(document.querySelectorAll('button'));
    btns.forEach((b, i) => {
      const t = (b.textContent || '').trim();
      if (t) {
        const r = b.getBoundingClientRect();
        result.buttons[`btn_${i}_${t.slice(0, 20)}`] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0, disabled: b.disabled };
      }
    });

    // Look for SVG gauge elements
    result.svgs = {};
    const svgs = Array.from(document.querySelectorAll('svg'));
    svgs.forEach((s, i) => {
      const r = s.getBoundingClientRect();
      if (r.width > 50 && r.height > 50) {
        result.svgs[`svg_${i}_${r.width}x${r.height}`] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }
    });

    return result;
  });

  console.log('=== URL & Title ===');
  console.log(JSON.stringify({ url: info.url, title: info.title }, null, 2));
  console.log('=== Body Text (first 500 chars) ===');
  console.log(info.bodyText.slice(0, 500));
  console.log('=== Body Text (chars 500-1500) ===');
  console.log(info.bodyText.slice(500, 1500));
  console.log('=== Body Text (chars 1500-3000) ===');
  console.log(info.bodyText.slice(1500, 3000));
  console.log('=== Structure (aside/main/etc.) ===');
  console.log(JSON.stringify(info.structure, null, 2));
  console.log('=== Text findings ===');
  console.log(JSON.stringify(info.findings, null, 2));
  console.log('=== Buttons ===');
  console.log(JSON.stringify(info.buttons, null, 2));
  console.log('=== SVGs (large) ===');
  console.log(JSON.stringify(info.svgs, null, 2));

  await browser.close();
  console.log('=== DONE ===');
})();
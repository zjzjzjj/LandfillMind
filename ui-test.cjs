/**
 * 填埋场智慧监测系统 v4.0 — 全页面交互遍历自动化测试
 * 功能：逐页点击所有按钮/链接/可交互元素，检测黑屏、无响应、延迟、控制台错误
 * 运行：node ui-test.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:5173';
const REPORT_FILE = path.join(__dirname, 'ui-test-report.json');
const SHOT_DIR = path.join(__dirname, 'test-screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

const results = {
  startedAt: new Date().toISOString(),
  pages: {},
  blackScreens: [],
  consoleErrors: [],
  unresponsive: [],
  slowClicks: [],
  summary: { totalElements: 0, passed: 0, failed: 0, blackScreenCount: 0 },
};

/** 检测黑屏：页面可视区域主体内容是否消失/全黑 */
async function detectBlackScreen(page, pageName, triggerDesc) {
  // 给页面 600ms 稳定时间
  await page.waitForTimeout(600);
  const check = await page.evaluate(() => {
    const body = document.body;
    const bg = window.getComputedStyle(body).backgroundColor;
    const root = document.getElementById('root');
    const rootChildren = root ? root.children.length : 0;
    // 主内容区是否有可见元素
    const main = document.querySelector('main, #root > div');
    const mainHasContent = main ? main.innerText.trim().length > 0 : false;
    // 采样页面平均亮度（粗略）：读取几个关键区域计算背景是否全黑
    return { bg, rootChildren, mainHasContent, rootHtmlLen: root ? root.innerHTML.length : 0 };
  });

  // 判定：root 无子元素 或 主内容为空 或 root innerHTML 极小 → 视为黑屏/白屏崩溃
  const isBlack = check.rootChildren === 0 || check.rootHtmlLen < 200 || !check.mainHasContent;
  return { isBlack, detail: check };
}

/** 记录控制台与页面错误 */
function attachErrorListeners(page, pageName) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      results.consoleErrors.push({ page: pageName, text: msg.text().slice(0, 300) });
    }
  });
  page.on('pageerror', (err) => {
    results.consoleErrors.push({ page: pageName, text: `PAGEERROR: ${String(err).slice(0, 300)}` });
  });
}

/** 点击单个元素并观察结果 */
async function clickAndObserve(page, pageName, locator, desc) {
  results.summary.totalElements++;
  const record = { page: pageName, element: desc, status: 'ok', notes: [] };
  try {
    const start = Date.now();
    await locator.click({ timeout: 3000, trial: true }); // 先试操作检查可点击性
    await locator.click({ timeout: 3000 });
    const elapsed = Date.now() - start;
    if (elapsed > 2000) {
      record.status = 'slow';
      record.notes.push(`响应耗时 ${elapsed}ms`);
      results.slowClicks.push({ page: pageName, element: desc, ms: elapsed });
    }
    // 黑屏检测
    const { isBlack, detail } = await detectBlackScreen(page, pageName, desc);
    if (isBlack) {
      record.status = 'black-screen';
      record.notes.push(`黑屏! rootChildren=${detail.rootChildren} htmlLen=${detail.rootHtmlLen} mainContent=${detail.mainHasContent}`);
      results.blackScreens.push({ page: pageName, element: desc, detail });
      results.summary.blackScreenCount++;
      const shot = path.join(SHOT_DIR, `black-${pageName}-${Date.now()}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      record.notes.push(`截图: ${shot}`);
      // 尝试恢复：刷新回该页
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(800);
    }
    results.summary.passed += record.status === 'ok' ? 1 : 0;
    if (record.status !== 'ok') results.summary.failed++;
  } catch (e) {
    record.status = 'unresponsive';
    record.notes.push(String(e).split('\n')[0].slice(0, 200));
    results.unresponsive.push({ page: pageName, element: desc, error: record.notes[0] });
    results.summary.failed++;
  }
  return record;
}

/** 通用：收集页面上所有可交互元素并逐个点击 */
async function exercisePage(page, pageName, url, options = {}) {
  console.log(`\n========== 测试页面: ${pageName} (${url}) ==========`);
  const pageReport = { url, elements: [], pageLoadBlack: false };
  const fullUrl = url.startsWith('http') ? url : BASE + url;
  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1200);

  // 页面加载即黑屏检测
  const initial = await detectBlackScreen(page, pageName, '初始加载');
  if (initial.isBlack) {
    pageReport.pageLoadBlack = true;
    results.blackScreens.push({ page: pageName, element: '页面初始加载', detail: initial.detail });
    results.summary.blackScreenCount++;
    await page.screenshot({ path: path.join(SHOT_DIR, `load-black-${pageName}.png`) }).catch(() => {});
  }
  await page.screenshot({ path: path.join(SHOT_DIR, `${pageName}-initial.png`) }).catch(() => {});

  // 收集可交互元素：button / a / [role=button] / input[type=checkbox|radio] / select
  const elements = await page.$$('button, a[href], [role="button"], select, input[type="checkbox"], input[type="radio"]');
  console.log(`发现 ${elements.length} 个可交互元素`);

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    try {
      // 跳过不可见元素
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      // 描述元素
      const desc = await el.evaluate((node) => {
        const tag = node.tagName.toLowerCase();
        const text = (node.innerText || node.getAttribute('aria-label') || node.getAttribute('placeholder') || '').trim().slice(0, 40);
        return `${tag}["${text}"]`;
      });
      // 跳过纯导航链接回到首页的重复元素（避免死循环），但记录
      const record = await clickAndObserve(page, pageName, el, desc);
      pageReport.elements.push(record);
      // 点击后若路由跳走，跳回当前页面继续
      if (options.stayOn && !page.url().includes(url)) {
        await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(800);
      }
    } catch (e) {
      // 元素已脱离 DOM（组件重渲染），重新收集
      console.log(`  元素 ${i} 已失效，重新收集...`);
      break;
    }
  }
  results.pages[pageName] = pageReport;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // ---- 1. 首页 ----
  attachErrorListeners(page, 'HomePage');
  await exercisePage(page, 'HomePage', '/');

  // ---- 2. AI 快诊 ----
  attachErrorListeners(page, 'DiagnosisPage');
  await exercisePage(page, 'DiagnosisPage', '/diagnose');

  // 快诊专项：加载示例 + 开始诊断 + 分组折叠
  console.log('\n--- DiagnosisPage 专项流程 ---');
  await page.goto(BASE + '/diagnose', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const demoBtn = page.locator('button:has-text("加载示例")').first();
  if (await demoBtn.count()) {
    const r = await clickAndObserve(page, 'DiagnosisPage', demoBtn, 'button[加载示例]');
    results.pages.DiagnosisPage.elements.push(r);
  }
  const startBtn = page.locator('button:has-text("开始诊断")').first();
  if (await startBtn.count()) {
    const r = await clickAndObserve(page, 'DiagnosisPage', startBtn, 'button[开始诊断]');
    results.pages.DiagnosisPage.elements.push(r);
    await page.waitForTimeout(1500); // 等待诊断结果渲染
    await page.screenshot({ path: path.join(SHOT_DIR, 'DiagnosisPage-result.png') }).catch(() => {});
  }
  // 分组折叠按钮
  const accordions = await page.$$('div[class*="rounded-xl"] > button');
  for (let i = 0; i < Math.min(accordions.length, 4); i++) {
    const visible = await accordions[i].isVisible().catch(() => false);
    if (!visible) continue;
    const txt = (await accordions[i].innerText().catch(() => '')).trim().slice(0, 20);
    const r = await clickAndObserve(page, 'DiagnosisPage', accordions[i], `折叠面板[${txt}]`);
    results.pages.DiagnosisPage.elements.push(r);
  }
  // 输入模式切换
  const modeBtns = await page.$$('button:has-text("CSV 导入"), button:has-text("表单录入")');
  for (const b of modeBtns) {
    const txt = (await b.innerText().catch(() => '')).trim();
    const r = await clickAndObserve(page, 'DiagnosisPage', b, `模式切换[${txt}]`);
    results.pages.DiagnosisPage.elements.push(r);
  }

  // ---- 3. 计算中心 ----
  attachErrorListeners(page, 'DesignPage');
  await exercisePage(page, 'DesignPage', '/design');
  console.log('\n--- DesignPage 专项流程 ---');
  await page.goto(BASE + '/design', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  // 逐个切换计算器 + 计算
  const calcButtons = await page.$$('div.w-64 button');
  for (let i = 0; i < Math.min(calcButtons.length, 4); i++) {
    const visible = await calcButtons[i].isVisible().catch(() => false);
    if (!visible) continue;
    const txt = (await calcButtons[i].innerText().catch(() => '')).trim().split('\n')[0].slice(0, 20);
    const r = await clickAndObserve(page, 'DesignPage', calcButtons[i], `计算器[${txt}]`);
    results.pages.DesignPage.elements.push(r);
    const calcBtn = page.locator('button:has-text("开始计算")').first();
    if (await calcBtn.count()) {
      const r2 = await clickAndObserve(page, 'DesignPage', calcBtn, `开始计算(${txt})`);
      results.pages.DesignPage.elements.push(r2);
      await page.waitForTimeout(800);
    }
  }

  // ---- 4. 多智能体 ----
  attachErrorListeners(page, 'MultiAgentPage');
  await exercisePage(page, 'MultiAgentPage', '/multi-agent');
  console.log('\n--- MultiAgentPage 专项流程 ---');
  await page.goto(BASE + '/multi-agent', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const runBtn = page.locator('button:has-text("启动分析")').first();
  if (await runBtn.count()) {
    const r = await clickAndObserve(page, 'MultiAgentPage', runBtn, 'button[启动分析]');
    results.pages.MultiAgentPage.elements.push(r);
    // 等待 12 秒模拟分析过程（每 2 秒检测一次黑屏）
    for (let t = 0; t < 6; t++) {
      await page.waitForTimeout(2000);
      const chk = await detectBlackScreen(page, 'MultiAgentPage', `分析中 t=${(t + 1) * 2}s`);
      if (chk.isBlack) {
        results.blackScreens.push({ page: 'MultiAgentPage', element: `分析过程中 t=${(t + 1) * 2}s`, detail: chk.detail });
        results.summary.blackScreenCount++;
        await page.screenshot({ path: path.join(SHOT_DIR, `multiagent-black-${t}.png`) }).catch(() => {});
        break;
      }
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'MultiAgentPage-after-run.png') }).catch(() => {});
    // 思维链展开按钮
    const treeBtns = await page.$$('button:has-text("思维链")');
    for (const b of treeBtns.slice(0, 2)) {
      const r = await clickAndObserve(page, 'MultiAgentPage', b, '思维链展开/收起');
      results.pages.MultiAgentPage.elements.push(r);
    }
  }

  // ---- 5. 专家对话 ----
  attachErrorListeners(page, 'ChatPage');
  await exercisePage(page, 'ChatPage', '/chat/new');
  console.log('\n--- ChatPage 专项流程 ---');
  await page.goto(BASE + '/chat/new', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  // 快捷问题按钮
  const quickBtns = await page.$$('div.max-w-md button');
  for (let i = 0; i < Math.min(quickBtns.length, 2); i++) {
    const txt = (await quickBtns[i].innerText().catch(() => '')).trim().slice(0, 25);
    const r = await clickAndObserve(page, 'ChatPage', quickBtns[i], `快捷问题[${txt}]`);
    results.pages.ChatPage.elements.push(r);
    await page.waitForTimeout(2000); // 等待流式响应开始
    const chk = await detectBlackScreen(page, 'ChatPage', `发送消息后[${txt}]`);
    if (chk.isBlack) {
      results.blackScreens.push({ page: 'ChatPage', element: `发送消息: ${txt}`, detail: chk.detail });
      results.summary.blackScreenCount++;
    }
  }
  // 发送/停止按钮
  const textarea = page.locator('textarea').first();
  if (await textarea.count()) {
    await textarea.fill('填埋场选址条件有哪些？');
    const sendBtn = page.locator('button:has(svg)').last();
    const r = await clickAndObserve(page, 'ChatPage', sendBtn, '发送按钮');
    results.pages.ChatPage.elements.push(r);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(SHOT_DIR, 'ChatPage-after-send.png') }).catch(() => {});
  }

  // ---- 6. 设置页 ----
  attachErrorListeners(page, 'SettingsPage');
  await exercisePage(page, 'SettingsPage', '/settings');
  console.log('\n--- SettingsPage 专项流程 ---');
  await page.goto(BASE + '/settings', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  // 主题切换开关
  const themeToggle = page.locator('button.w-12.h-6').first();
  if (await themeToggle.count()) {
    const r = await clickAndObserve(page, 'SettingsPage', themeToggle, '主题切换开关');
    results.pages.SettingsPage.elements.push(r);
    // 切回来
    await themeToggle.click().catch(() => {});
  }
  // 新建 Agent
  const addBtn = page.locator('button:has-text("新建 Agent")').first();
  if (await addBtn.count()) {
    const r = await clickAndObserve(page, 'SettingsPage', addBtn, 'button[新建 Agent]');
    results.pages.SettingsPage.elements.push(r);
    const createBtn = page.locator('button:has-text("创建")').first();
    if (await createBtn.count()) {
      await page.locator('input[placeholder*="Agent"]').fill('测试Agent').catch(() => {});
      const r2 = await clickAndObserve(page, 'SettingsPage', createBtn, 'button[创建]');
      results.pages.SettingsPage.elements.push(r2);
    }
  }
  // 显示/隐藏 API Key
  const showKeyBtn = page.locator('button:has-text("显示")').first();
  if (await showKeyBtn.count()) {
    const r = await clickAndObserve(page, 'SettingsPage', showKeyBtn, 'button[显示API Key]');
    results.pages.SettingsPage.elements.push(r);
  }

  // ---- 7. 侧边栏与 Header（在诊断页环境下测导航） ----
  console.log('\n--- Sidebar/Header 导航测试 ---');
  await page.goto(BASE + '/diagnose', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  attachErrorListeners(page, 'Navigation');
  const navTargets = [
    { text: 'AI 快诊', expect: '/diagnose' },
    { text: '计算中心', expect: '/design' },
    { text: '多智能体', expect: '/multi-agent' },
    { text: '专家问答', expect: '/' },
    { text: '设置', expect: '/settings' },
  ];
  results.pages.Navigation = { url: 'sidebar', elements: [] };
  for (const nav of navTargets) {
    await page.goto(BASE + '/diagnose', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    const btn = page.locator(`button:has-text("${nav.text}")`).first();
    if (await btn.count()) {
      const r = await clickAndObserve(page, 'Navigation', btn, `侧边栏导航[${nav.text}]`);
      await page.waitForTimeout(600);
      const landed = page.url();
      r.notes.push(`跳转至: ${landed}`);
      if (!landed.includes(nav.expect)) {
        r.status = 'wrong-route';
        r.notes.push(`期望 ${nav.expect} 实际 ${landed}`);
        results.summary.failed++;
      }
      results.pages.Navigation.elements.push(r);
    }
  }
  // Header：主题切换 + 侧边栏收起
  await page.goto(BASE + '/diagnose', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const menuBtn = page.locator('button[aria-label="切换侧边栏"]').first();
  if (await menuBtn.count()) {
    const r = await clickAndObserve(page, 'Navigation', menuBtn, 'Header[收起侧边栏]');
    results.pages.Navigation.elements.push(r);
  }
  const themeBtn = page.locator('button[aria-label="切换主题"]').first();
  if (await themeBtn.count()) {
    const r = await clickAndObserve(page, 'Navigation', themeBtn, 'Header[切换主题]');
    results.pages.Navigation.elements.push(r);
    await themeBtn.click().catch(() => {}); // 切回
  }
  // 模型下拉
  const modelBtn = page.locator('header div.relative > button').first();
  if (await modelBtn.count()) {
    const r = await clickAndObserve(page, 'Navigation', modelBtn, 'Header[模型下拉]');
    results.pages.Navigation.elements.push(r);
    const modelItems = await page.$$('header div.relative div.absolute button');
    for (const item of modelItems.slice(0, 2)) {
      const txt = (await item.innerText().catch(() => '')).trim().split('\n')[0].slice(0, 25);
      const r2 = await clickAndObserve(page, 'Navigation', item, `模型选择[${txt}]`);
      results.pages.Navigation.elements.push(r2);
    }
  }

  await browser.close();

  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT_FILE, JSON.stringify(results, null, 2), 'utf-8');

  // ===== 控制台汇总 =====
  console.log('\n\n================= 测试汇总 =================');
  console.log(`总交互元素: ${results.summary.totalElements}`);
  console.log(`正常: ${results.summary.passed}`);
  console.log(`异常: ${results.summary.failed}`);
  console.log(`黑屏次数: ${results.summary.blackScreenCount}`);
  console.log(`控制台错误: ${results.consoleErrors.length}`);
  console.log(`无响应元素: ${results.unresponsive.length}`);
  console.log(`延迟>2s元素: ${results.slowClicks.length}`);
  console.log(`报告已保存: ${REPORT_FILE}`);
})().catch((e) => {
  console.error('测试运行失败:', e);
  fs.writeFileSync(REPORT_FILE, JSON.stringify(results, null, 2), 'utf-8');
  process.exit(1);
});

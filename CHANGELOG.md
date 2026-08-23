# Changelog · LandfillMind 填埋场智慧监测系统

## v4.2（2026-08-18 · 评审前冲刺：12 项核心修复 + 2 项差异化创新）

> 第一届"海之子"杯 AI 智能体挑战计划 · 评审前最后一轮迭代。相对于 v4.1.1 的全部改动：
> **P0 评审必改 8 项 + P1 加分项 4 项 + 2 项差异化创新点 + 1 项评审应急端点。**

### a. P0 评审必改（8 项）

- **P0-1 · AI 纠偏演示完整化**
  - 演示数据 `DEMO_RESULT_CORRECTED`（LLM 故意少报/漏报数值）+ 结构化 `VerificationMismatch` 类型（field / reported / expected / severity）
  - 诊断页右侧增加黄色"⚡ 触发纠偏演示"按钮，一键切换"正常演示 → 纠偏演示"模式
  - 视频脚本插入 30 秒纠偏剧场插段（1:50 - 2:40），与分屏剧场 UI 完全同步
- **P0-2 · 工具调用叙事统一**
  - `aug` 上下文改造：改为独立 `system` 消息注入（不再混入 user），避免 GLM 把"工具调用指令"误读为"用户问题"
  - `ToolCallCard` 组件重写：标题改为"📚 知识库检索增强"与"🧮 工程计算内核"，可视化"AI 真的会调用工具"
  - KB 引用徽章：每次工具返回后，结果前部渲染"📖 GB 16889-2008 §6.1"形式可点击徽章
- **P0-3 · AQ 4202 规范张冠李戴修正**
  - 排查 4 处错引：把误挂"AQ 4202"的条目全部替换为真实出处
    - 渗滤液导排 → **GB 16889-2008 §6.1**
    - 填埋气收集 → **CJJ 176-2012 §6.1**
    - 防火间距 → **GB 50016-2014 §5.4**
    - 其余 1 处按上下文修正
  - CH4 风险六档分级：`normal / attention / warning / alarm / danger / explosive`（替代原 4 档），按 LEL% 与体积分数双阈值映射
- **P0-4 · SimulatorPage 3 个无效滑杆删除**
  - 删除 `slopeRatio / tierHeight / floorSlope` 三个从未连入 3D 场景的"装饰性"滑杆
  - 保留真实联动滑杆（库容/谷宽/堆高/坝高/池容/井距/植被密度/车辆数共 8 个）
- **P0-5 · LRU 缓存污染单行修复 + 调试端点**
  - `multiagent.ts` 修复 1 行：缓存 key 增加 `qHash`，避免相同输入但不同追问历史的请求互相污染
  - 新增 `POST /api/agent-cache/clear`（评审日应急清空缓存用，无鉴权仅 dev 环境暴露）
- **P0-6 · 班前交底卡入口前置**
  - 首页 hero 区加红色全宽主按钮"📋 生成今日班前交底卡"，直达 DiagnosisPage
  - DiagnosisPage 内嵌交底卡预览卡片（不再 modal 弹层，可滚动查看完整 8 节）
  - `RiskMap` 组件新增应急疏散路线渲染（SVG path，红色箭头指向 3 个最近安全集结点）
- **P0-7 · DiagnosisPage 4 个演示翻车点**
  - `landfillArea` 与 `rainfall` 字段改为可编辑（之前只读，演示时改不动）
  - "导入 CSV" 按钮未选择文件时 `disabled`（之前点了报错）
  - `handleCalc` 显式捕获异常并 `toast.error` 提示，避免静默失败
  - `handleLoadDemo` 显式 `toast.success('已加载演示数据')`，演示员有视觉反馈
- **P0-8 · 追问链路接通**
  - 修复 `systemPrompt` 真切换：根据上下文是否来自多智能体报告，动态切换"领域专家" vs "通才" system
  - `server/followUp.ts` 从死代码复活：暴露 `buildFollowUpContext()` 接入 `/api/chat`
  - 新增 `FollowUpCard` 折叠卡 UI（追问链路 4 步：场景 → 专家结论 → 用户追问 → 追问回答）
  - 顶部 Banner 霓虹角标"🎯 多智能体协同追问中"（青色边框 + 脉冲动画）

### b. P1 加分项（4 项）

- **P1-1 · RAG 同义词 substring 扩展**
  - `expandQueryBySubstring(q)`：查询词先做同义词 substring 展开（如"垃圾汤" → "渗滤液"、"黑色金子" → "填埋气"）
  - `lookupKB` 与 `scoreKB` 接入：命中关键词全部计分，不再只匹配精确词
  - 8 条自检用例全 PASS（含"垃圾汤"、"黑色金子"、"老场子"、"黑水"等口语词）
- **P1-2 · 专家提示注入三件套**
  - `EXPERT_KNOWLEDGE`：每条 KB 注入 `{ key, clause, thresholds: KEY_THRESHOLDS_JSON }`（约 1.5KB）
  - `SCENARIO_ADVICE`：7 类场景路由（渗滤液/填埋气/边坡/地下水/HDPE/沉降/应急），每类挂专属引导问题
  - `EXPERT_GLOSSARY`：尾部追加 `GLOSSARY_HINT`（约 120B），规范术语→口语映射（"衬垫" → "防渗层"等）
- **P1-3 · cache_hit ⚡ 金色闪卡徽标**
  - `server/multiagent.ts` 增加 `cache_hit` 事件（SSE 流式 + JSON 端点双通道）
  - 新增 `GET /api/agent-cache/status` 返回 `{ size, hits, misses, hitRate, lastHit }`
  - MultiAgentPage 在 4 个 Agent 卡片上叠加金色"⚡ 缓存命中"闪卡徽标（首次跑不显示，复跑显示）
- **P1-4 · 多智能体 hybridSearch + detail 三档**
  - `kbRef` 由 `scoreKB` 改为 `hybridSearch(q, 3)`：融合关键词 + 同义词 substring + 向量余弦
  - `multiagentMaxTokens(detail)`：摘要 800 / 标准 1800 / 详细 3200 tokens，按用户详细度档位动态切
  - MultiAgentPage 顶部增加三档切换 UI（Tab 形式："📋 摘要 / 📊 标准 / 📚 详细"），实时透传到后端

### c. 差异化创新（2 项）

- **想法 1 · 纠偏剧场化 Verification Theater**（评审日直接加分）
  - 新建 `src/components/VerificationTheater.tsx`（394 行）
  - 三栏分屏剧场 UI：**左 AI 报告原文片段**（滚动高亮 mismatch 字段） / **中动画竖线**（逐条"穿过"不一致项的视觉隐喻） / **右计算内核真实结论**（hazard 卡片 + 计算书摘要）
  - 底部时间线步进（4 步：场景输入 → AI 出报告 → 内核复核 → 强制纠偏），可单步前进/后退/自动播放
  - 上下步控件 + 全部展开按钮 + mismatch 列表侧栏
- **想法 5 · 现场一键应急模式**（评审日现场演示加分）
  - 新建 `src/utils/emergencyPoster.ts`（510 行）
  - 5 节一体化海报：**① 诊断报告摘要** + **② 班前安全交底卡** + **③ 4×4 SVG 风险矩阵**（横轴严重度 / 纵轴概率） + **④ SVG 疏散路线**（红色箭头 + 3 集结点） + **⑤ 21×21 QR 码占位**（打印后用 A4 纸即可贴现场）
  - `HomePage` 加红色全宽主按钮"🆘 现场一键应急"，一键触发
  - `AnimatePresence` 全屏 modal 弹出海报预览
  - `<iframe srcDoc>` 原生浏览器打印，零依赖

### d. 冒烟测试结果

- **3 次 verdict clean**：TypeScript 0 错误 + Vite build 0 警告 + 全部 API 端点 HTTP 200
- **P1-1 同义词生效验证**：查询"垃圾汤"成功召回渗滤液相关 KB 条目（命中率 8/8）
- **P1-3 cache_hit 事件触发验证**：第 2 次跑同一组参数，4 个 Agent 卡片均显示⚡闪卡徽标
- **P1-4 detail 三档透传验证**：切到"详细"档，多智能体报告 token 数从 1820 提升到 3147
- **想法 5 海报输出验证**：`generateEmergencyPosterHtml()` 输出 23817 字节有效 HTML，浏览器原生打印 A4 排版正常

### e. 新增文件清单（4 项）

| 文件 | 行数 | 用途 |
|---|---:|---|
| `src/components/VerificationTheater.tsx` | 394 | 纠偏剧场分屏 UI |
| `src/utils/emergencyPoster.ts` | 510 | 现场应急海报生成器 |
| `src/utils/expertPrompts.ts` | 85 | 专家提示三件套（EXPERT_KNOWLEDGE / SCENARIO_ADVICE / GLOSSARY） |
| `server/followUp.ts` | 88 | 追问上下文构建（之前是死代码，现接通） |

### f. 修改文件清单（28 项）

后端（10）：`server/index.ts` / `server/multiagent.ts` / `server/llm.ts` / `server/prompts.ts` / `server/kb.ts` / `server/diagnose.ts` / `server/calculate.ts` / `server/db.ts` / `server/augment.ts` / `server/corrections.ts`

前端页面（7）：`src/pages/DiagnosisPage.tsx` / `src/pages/HomePage.tsx` / `src/pages/SimulatorPage.tsx` / `src/App.tsx` / `src/main.tsx` / `src/types.ts` / `src/utils/exporter.ts`

前端组件（4）：`src/components/CalculationAnimation.tsx` / `src/components/ResultInterpretation.tsx` / `src/components/RiskMap.tsx` / `src/components/Sidebar.tsx`（新增 VerificationTheater 接入）

前端 Hooks（3）：`src/hooks/useAgents.ts` / `src/hooks/useChat.ts` / `src/hooks/useSessions.ts`

配置（4）：`package.json` / `render.yaml` / `.env.example` / `tsconfig.json`

> 注：CHANGELOG.md、参赛技术说明文档.md、视频脚本.md、DEPLOY.md、README.md 由文档 Agent 同步维护，本节不重复列出。

### h. 评审现场应急

- **`POST /api/agent-cache/clear`** 调试端点可用于评审日 LLM 通道 5xx 时应急清空 LRU 缓存
- 仅在 `NODE_ENV !== 'production'` 时启用；生产环境静默 404（不影响安全）
- 评委手机 4G 网络抖动时，主持人可在浏览器 Console 直接 `fetch('/api/agent-cache/clear', {method:'POST'})` 重建缓存

---

## v4.1.1（2026-08-17 · 评审前修复版）

> 第一届"海之子"杯 AI 智能体挑战计划提交版本。相对于 v4.1.0 的全部改动：

### Bug 修复
- **HDPE 验算量纲兼容**：`hdpeCheck` 支持 `eps < 100` 视为小数（如 2 → 200%），保留 `eps ≥ 100` 视为百分数（如 700%）— 修复了前端表单默认 2 与计算内核判断 700% 的歧义。
- **删除 /api/permission 死调用**：GLM 通道无真正工具授权流，前端 `handlePermissionAllow/Deny` 改为 no-op（保留函数签名兼容未来 CodeBuddy 接入）。
- **路由 404 JSON 兜底**：`/api/*` 未匹配路径返回 JSON 而非 SPA fallback 的 HTML，避免前端 `fetch().json()` 抛错。

### 可靠性 / 演示健壮性
- **演示 IP 限流放宽**：Render `RATE_LIMIT_PER_MIN/Day/GLOBAL` 从 20/200/1000 提到 40/1000/5000。
- **IP 限流定期清理**：每 60 秒统一清除过期 ipMinute 记录与昨日 ipDay 记录，防止内存无界增长。
- **db 写 debounce**：所有 `persist()` 改为 `schedulePersist()` 合并为 1 秒批量写；新增 `persistNow()` 在优雅退出时立即落盘。
- **SSE keepalive**：每 15 秒发送 `:keepalive` 注释行，防止长对话场景下反代/浏览器断开。
- **SIGTERM 优雅退出**：监听 SIGTERM / SIGINT / unhandledRejection / uncaughtException，server.close + persistNow + 8 秒强杀兜底。

### 性能优化
- **three.js 懒加载**：`LandfillScene3D` 通过 React.lazy + Suspense 在 HomePage（hero 实时联动）和 SimulatorPage（3D 模拟）按需加载，主页 chunk 不再包含 498KB 的 Three.js，首屏体积显著下降。

### 文档统一（口径修复）
- SPEC.md 顶部加过期说明（与 v4.1 实际实现有偏差）。
- README.md 数字统一：KB 50→66、Calc 15→12、LLM 通道描述更新。
- 新增"实际能力 / API 接口"表格；新增"快速开始"段落。

### 已知遗留
- sql.js（非 better-sqlite3）—— sql.js WASM 在 Render 免费层无持久盘时自动降级为内存态；生产数据库建议后续切换 better-sqlite3。
- 单元测试 / CI 仍缺失——`scripts/eval-agent.ts` 端到端冒烟可作为 CI 第一步。

---

## v4.1.0（2026-08-11）

- 计算中心三栏布局 + 回答详细度三档（摘要/标准/详细）
- 全站导出（MD / HTML 浏览器打印 PDF / JSON）
- 3D 模拟页面 + 3D 场景视觉升级（贴图/天空/云）
- GLM-4-Flash 唯一通道
- 多智能体参数化 + 4 领域 Agent + 总结 Agent
- 6 大页面完整实现
- 67+ KB 条目（2026 新增专题）

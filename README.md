# LandfillMind · 填埋场智慧监测系统 v4.2

> 第一届"海之子"杯 AI 智能体挑战计划参赛作品
> 主题：为人民建好房，为工友谋幸福 ｜ 参赛者：郑洁（浙江大学环境岩土工程）

---

## 核心能力

| 模块 | 说明 |
|------|------|
| **AI 快诊** | 输入场地监测数据 → 双引擎诊断（确定性阈值 + LLM 解释）→ 红/橙/黄/蓝四级风险报告 |
| **多智能体协同** | 5 个专业 Agent 并行推理，覆盖边坡/渗滤液/填埋气/地下水，思维链全程可见 |
| **计算中心** | 14 项专业工程计算器（Fs / HELP / LandGEM / HDPE / 沉降预测…），带规范引用与风险评级 |
| **专家问答** | 基于 199 条规范 KB 的智能对话，工具调用可视化，规范引用带版本年号 |
| **3D 场地可视化** | Three.js 填埋场三维模型，隐患区按严重度着色 |
| **OGS 数值模拟** | 内置 OpenGeoSys 5.5 有限元求解器，真实数值模拟（填埋气产气量·多组分 / 堆体沉降），AI 对话可直接触发 |

---

## OGS 数值模拟（OpenGeoSys）

> 把开源有限元求解器 **OpenGeoSys 5.5** 直接接入智能体：AI 对话里说"帮我模拟地下水渗流"即可真实调用求解器，不再只是公式估算。

- **对话触发**：专家问答里输入 `模拟产气` / `沉降模拟` 等 → 后端自动运行 OGS 求解 → 返回产气组分/沉降时程并注入 AI 回答
- **独立页面**：侧边栏「OGS 模拟」→ 选场景 → 调参数 → 运行 → 结果曲线 + 域统计 + 求解日志
- **场景**：`gas-production` 填埋气产气量（LandGEM 一阶动力学 + 组分模型，输出 CH₄/CO₂/H₂/H₂S/NH₃ 全组分曲线、占比、累计量与发电/减排潜力，秒出）/ `settlement` 堆体固结沉降（OGS DEFORMATION 有限元，沉降时程，约 1s）
- **说明**：产气场景为确定性工程模型（秒出、不依赖外部求解器）；沉降场景为真实 OGS 有限元求解
- **求解器**：默认用仓库内置 `data/ogs/bin/ogs.exe`；如需换路径，在 `.env` 设 `OGS_EXE=...`

---

## 快速开始

```bash
# 1. 安装依赖
cd landfillmind
npm install

# 2. 配置 API Key
cp .env.example .env
# 编辑 .env，填入 CODEBUDDY_API_KEY 或 DEEPSEEK_API_KEY

# 3. 启动（同时运行前后端）
npm run dev
# 前端：http://localhost:5173
# 后端：http://localhost:3000

# 4. 生产构建
npm run build
npm run server
```

### Docker 部署

```bash
docker build -t landfillmind .
docker run -d -p 3000:3000 \
  -e OPENROUTER_API_KEY=你的Key \
  -e DEEPSEEK_API_KEY=你的Key \
  landfillmind
```

---

## 技术栈

- **前端**：React 18 + TypeScript + Vite 5 + Tailwind CSS + Framer Motion + Three.js
- **后端**：Node.js + Express + tsx + sql.js (SQLite WASM)
- **AI**：智谱 GLM 直连（默认免费档）+ OpenRouter 可选（并行信号量 3 路）；CodeBuddy Agent SDK 已预埋接口待 CodeBuddy 主通道启用
- **通信**：SSE 流式推送

---

## 规范依据

覆盖 30+ 本国家/行业标准（版本口径与 knowledge-base 一致）：
`GB 16889-2008`（2024 版已发布，KB 保留 2008 关键阈值）· `CJJ 176-2012`（2025-09 废止，Fs 阈值仍被工程实践引用，见表 6.1.4 分档）· `HJ 25.1~25.6`（HJ 25.1/25.2 现行 2019 版）· `GB 36600-2018` · `GB/T 14848-2017` · `HJ 1106-2020` · `GB 55038-2025` · `AQ 4202-2008`

---

*文档版本：v4.0 ｜ 生成日期：2026-08-11*

## 参赛材料索引（海之子杯 v4.1.1）

| 文件 | 用途 |
|---|---|
| [参赛技术说明文档.md](./参赛技术说明文档.md) | 必交材料：项目技术说明（约 1.2 万字） |
| [视频脚本.md](./视频脚本.md) | 必交材料：3:50 功能介绍视频录屏脚本 + 录制清单 + 字幕名词音准表 |
| [CHANGELOG.md](./CHANGELOG.md) | 评审前修复版 v4.1.1 变更日志 |
| [DEPLOY.md](./DEPLOY.md) | 部署到 Render 免费层 + UptimeRobot 保活操作清单 |
| [../SPEC.md](../SPEC.md) | 早期设计规范（已过期，仅供历史参考） |

## 上线地址（部署完成后填写）

- **Render（推荐）**：`https://landfillmind.onrender.com`
- **本地**（开发模式）：`http://localhost:5173`（前端）+ `http://localhost:3000`（后端 API）


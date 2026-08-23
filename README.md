# LandfillMind · 填埋场智慧监测系统 v4.2

> 第一届"海之子"杯 AI 智能体挑战计划参赛作品
> 主题：为人民建好房，为工友谋幸福 ｜ 参赛者：郑洁（浙江大学环境岩土工程）

---

## 核心能力

| 模块 | 说明 |
|------|------|
| **AI 快诊** | 输入场地监测数据 → 双引擎诊断（确定性阈值 + LLM 解释）→ 红/橙/黄/蓝四级风险报告 |
| **多智能体协同** | 5 个专业 Agent 并行推理，覆盖边坡/渗滤液/填埋气/地下水，思维链全程可见 |
| **计算中心** | 12 项专业工程计算器（Fs / HELP / LandGEM / HDPE / 沉降预测…），带规范引用与风险评级 |
| **专家问答** | 基于 66 条规范 KB 的智能对话，工具调用可视化，规范引用带版本年号 |
| **3D 场地可视化** | Three.js 填埋场三维模型，隐患区按严重度着色 |

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

覆盖 30+ 本国家/行业标准：
`GB 16889-2008` · `CJJ 176-2012` · `HJ 25.1~25.6` · `GB 36600-2018` · `GB/T 14848-2017` · `HJ 1139-2020` · `GB 55038-2025` · `AQ 4202`

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


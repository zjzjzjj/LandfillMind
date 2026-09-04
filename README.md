# LandfillMind · 填埋场全周期智能体 v4.5

## 核心能力

| 模块 | 说明 |
|------|------|
| **AI 快诊** | 输入场地监测数据 → 双引擎诊断（确定性阈值 + LLM 解释）→ 红/橙/黄/蓝四级风险报告 |
| **多智能体协同** | 5 个专业 Agent 并行推理，覆盖边坡/渗滤液/填埋气/地下水，思维链全程可见 |
| **计算中心** | 14 项专业工程计算器（Fs / HELP / LandGEM / HDPE / 沉降预测…），带规范引用与风险评级 |
| **专家问答** | 基于 199 条规范 KB 的智能对话，工具调用可视化，规范引用带版本年号 |
| **3D 场地可视化** | Three.js 填埋场三维模型，隐患区按严重度着色 |
| **AI 生成 3D 场景** | 对话输入"建一个缓坡山谷型 500 万 m³ 的填埋场" → 自然语言/参数解析为 8 维 GeoParams → 一键跳转三维仿真器；可选联动稳定化计算（OGS 产气峰值注入场景） |
| **实时 IoT 感知** | 嵌入式 MQTT broker + 5 个 mock 传感器（CH₄/H₂S/水位/沉降/温度），3D 仿真器实时监测面板按阈值分级（绿/黄/橙/红） |
| **稳定化计算** | 基于 OpenGeoSys 算例标定的确定性数值内核：填埋气产气量（ADM1 多组分）/ 有机物降解动力学 / 堆体固结沉降（Terzaghi），AI 对话可直接触发 |

---

## 稳定化计算（确定性数值内核）

> 数值内核以 OpenGeoSys 5.5 官方算例（Data XCFei 三案例的 ADM1 生化反应模型）为基准复刻标定；Windows 本机可另调原生 `ogs.exe` 做有限元校核。全部场景**秒出结果、跨平台可部署**（Render Linux 容器同样可用）。

- **三大场景**：
  - `gas-production` 填埋气产气量 — ADM1 式厌氧产甲烷模型，CH₄/CO₂/H₂S/H₂ 全组分日分辨率曲线、累计产量、占比、发电/减排潜力
  - `degradation` 有机物降解 — 易/难降解纤维素、VFA、细菌浓度随时间的降解动力学曲线
  - `settlement` 堆体固结沉降 — Terzaghi 一维固结解析解 S(t)=S∞·[1−exp(−t/τ)]，刚度越大固结越快
- **对话触发**：专家问答里输入 `模拟产气` / `有机物降解曲线` / `沉降模拟` → 后端自动计算并注入 AI 回答
- **原生求解器（可选）**：Windows 下用仓库内置 `OGS/bin/ogs.exe`；Linux 容器自动降级为解析内核并在状态徽标注明

---

## AI 生成 3D 场景（v4.3）

在**专家问答**里输入建场/改场意图，系统自动生成 3D 场景并一键跳转三维仿真器渲染：

```text
"建一个缓坡山谷型 500 万 m³ 的填埋场"     → 山谷 1.2× + 缓坡 0.7× + 库容 500 万 m³
"把堆体放缓到 1:3"                        → 斜坡比 → 堆高 0.8×
"重新建一个大库 + 同步算产气"             → 大型 1.6× + OGS 产气峰值 899 万m³/d 注入
"自定义 valleyWidth=1.5, pileHeight=1.6"  → key=value 精确参数
```

- **双通道**：GLM/OpenRouter（默认）走确定性规则解析；CodeBuddy SDK 走真 function calling（`buildScene` 工具）
- **联动**：可选同步跑稳定化计算（OGS），把产气/沉降峰值注入场景卡片与 3D 仿真器
- **容错**：输出永远过 `clampGeo` 边界；规则解析失败退默认场景，不报错、不误伤普通问答

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

*文档版本：v4.5 ｜ 生成日期：2026-08-31*

## 上线地址（部署完成后填写）

- **Render（推荐）**：`https://landfillmind.onrender.com`
- **本地**（开发模式）：`http://localhost:5173`（前端）+ `http://localhost:3000`（后端 API）


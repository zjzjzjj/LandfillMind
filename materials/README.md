# materials/ — 参赛文档与 PDF 输出

本目录存放海之子杯参赛项目的纯文本原始材料，以及由
`scripts/md-to-pdf.mjs` 生成的 A4 PDF 版本。

## 文件清单

| 文件 | 说明 |
|---|---|
| `人机协同履历表.md` | 人机协同履历表（参赛提交版） |
| `人机协同履历表.pdf` | 同上 PDF 版（脚本生成） |
| `参赛技术说明文档.pdf` | 参赛技术说明 PDF 版（脚本生成） |
| `README.md` | 本文件 |

> 原始 Markdown 源文件保留在仓库根目录（`参赛技术说明文档.md`），
> 履历表放在 `materials/` 是为了配合脚本默认扫描路径。

## 如何生成 PDF

### 1. 默认行为 — 扫描整个 `materials/` 目录

```bash
node scripts/md-to-pdf.mjs
```

会遍历 `materials/*.md`，对每个 `.md` 文件生成同名 `.pdf`（同目录）。
**已存在的 PDF 默认不覆盖**。

### 2. 指定单个文件

```bash
node scripts/md-to-pdf.mjs materials/人机协同履历表.md materials/人机协同履历表.pdf
```

### 3. 一次转多个（输入输出成对出现）

```bash
node scripts/md-to-pdf.mjs \
  ../参赛技术说明文档.md 参赛技术说明文档.pdf \
  人机协同履历表.md 人机协同履历表.pdf
```

### 4. 强制覆盖已有 PDF

```bash
node scripts/md-to-pdf.mjs --force
# 或
node scripts/md-to-pdf.mjs -f materials/人机协同履历表.md materials/人机协同履历表.pdf
```

## 依赖与限制

- 仅依赖 `node` 内置模块 + 项目 `devDependencies` 中已装的 `playwright ^1.62.1`
- **不引入任何新的 npm 包**，也不引入字体文件（Chromium 自带 CJK fallback）
- 输出限制：
  - 履历表 PDF：≤ 10 MB（实际 ~50 KB）
  - 参赛技术说明文档 PDF：≤ 30 MB（实际 ~80 KB）
- 样式：A4 / 边距 2 cm / 正文 11pt / 代码 10pt / 页眉+页脚+居中页码

## 常见问题

- **首次运行很慢？** Playwright 启动 Chromium 需要 1–2 秒。
- **PDF 是乱码？** 确认 Chromium 正常启动；本脚本不下载额外字体，
  依赖 Chromium 自带的 PingFang SC / Microsoft YaHei / Noto Sans CJK fallback。
- **想自定义样式？** 直接改 `scripts/md-to-pdf.mjs` 里的 `htmlTemplate()`
  函数（CSS 内联在 `<style>` 里）。

## 相关脚本输出

脚本每次运行会在仓库根生成 `.md-to-pdf.last-run.json`（最近一次结果），
方便 CI 或外部脚本读取。

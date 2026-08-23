// ========================
// 统一导出工具：Markdown / HTML（浏览器打印 PDF）/ JSON / PNG 下载
// ========================
import type { DiagnosisResult, Session, CalcResult } from '../types';
import type { GeoParams } from '../components/LandfillScene3D';

export function timestampName(type: string, ext: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `LandfillMind_${type}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

export function downloadText(filename: string, content: string, mime = 'text/markdown;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadJSON(filename: string, obj: unknown) {
  downloadText(filename, JSON.stringify(obj, null, 2), 'application/json;charset=utf-8');
}

export function downloadDataUrl(filename: string, dataUrl: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 极简 Markdown → HTML（覆盖本工具生成的标题/列表/粗体/行内代码/代码块/分隔线） */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listOpen: 'ul' | 'ol' | null = null;
  const closeList = () => { if (listOpen) { out.push(`</${listOpen}>`); listOpen = null; } };
  const inline = (s: string) => escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const flushCode = () => { if (codeBuf.length) { out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>'); codeBuf = []; } };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim().startsWith('```')) {
      if (inCode) { inCode = false; flushCode(); } else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(escapeHtml(line)); continue; }
    if (!line.trim()) { closeList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); const lv = h[1].length; out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue; }
    if (/^-{3,}\s*$/.test(line.trim())) { closeList(); out.push('<hr/>'); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) { if (listOpen !== 'ul') { closeList(); out.push('<ul>'); listOpen = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) { if (listOpen !== 'ol') { closeList(); out.push('<ol>'); listOpen = 'ol'; } out.push(`<li>${inline(ol[2])}</li>`); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  flushCode();
  return out.join('\n');
}

/** 打开可打印 HTML 报告（新标签页，顶部含「打印 / 另存为 PDF」按钮） */
export function openPrintableHtml(title: string, md: string) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: "Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif; max-width: 860px; margin: 0 auto; padding: 32px 40px; color: #1f2937; line-height: 1.8; background: #fff; }
  h1 { font-size: 24px; border-bottom: 3px solid #0e7490; padding-bottom: 10px; }
  h2 { font-size: 18px; color: #0e7490; margin-top: 28px; border-left: 4px solid #0e7490; padding-left: 10px; }
  h3 { font-size: 15px; color: #155e75; margin-top: 20px; }
  pre { background: #f3f4f6; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; white-space: pre-wrap; }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
  ul, ol { padding-left: 24px; }
  hr { border: none; border-top: 1px dashed #cbd5e1; margin: 20px 0; }
  .toolbar { position: sticky; top: 0; background: #0e7490; color: #fff; padding: 10px 16px; border-radius: 8px; margin-bottom: 18px; display: flex; gap: 10px; align-items: center; }
  .toolbar button { border: 1px solid rgba(255,255,255,.6); background: transparent; color: #fff; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
  .toolbar .meta { flex: 1; font-size: 12px; opacity: .85; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
  @page { margin: 18mm 16mm; }
</style>
</head>
<body>
<div class="toolbar">
  <span class="meta">LandfillMind · ${escapeHtml(title)} · ${new Date().toLocaleString('zh-CN')}</span>
  <button onclick="window.print()">🖨 打印 / 另存为 PDF</button>
</div>
${markdownToHtml(md)}
</body>
</html>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const win = window.open(url, '_blank');
  if (win) setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * 现场应急决策包导出（海之子杯差异化创新功能·想法 5）
 * 把"诊断报告摘要 + 班前交底卡 + 风险矩阵 + 疏散路线 + 现场 QR 海报"
 * 合并为一张可直接打印 / 微信群发 / 张贴的 A4 海报。
 * 海报完整 HTML 由 emergencyPoster.generateEmergencyPosterHtml 生成，
 * 本函数复用 openPrintableHtml 的 Blob + window.open 打印管线。
 *
 * 实现：使用动态 import() 避开 exporter ↔ emergencyPoster 的循环依赖
 * （emergencyPoster 需要本文件的 markdownToHtml，本函数又需要 emergencyPoster）。
 */
export async function exportEmergencyPosterHtml(diagnosis: DiagnosisResult, siteName: string) {
  const mod = await import('./emergencyPoster');
  const html = mod.generateEmergencyPosterHtml(diagnosis, siteName);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const win = window.open(url, '_blank');
  if (win) setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ======================== 各结果 Markdown 生成 ========================

export function buildDiagnosisMarkdown(result: DiagnosisResult, site?: Record<string, unknown>): string {
  const L: string[] = [];
  L.push('# LandfillMind 诊断报告');
  L.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}`);
  if (result.overallRisk) L.push(`\n**综合风险等级：${result.overallRisk}**`);
  if (site && Object.keys(site).length) {
    L.push('\n## 场地数据');
    Object.entries(site)
      .filter(([, v]) => v !== undefined && v !== '' && typeof v !== 'object')
      .forEach(([k, v]) => L.push(`- ${k}：${v}`));
  }
  L.push('\n## 综合研判');
  L.push(result.report?.overview ?? '');
  L.push('\n## 逐项风险分析');
  (result.risks ?? []).forEach(r => {
    L.push(`\n### ${r.title}（风险等级：${r.level}）`);
    if (r.value !== undefined) L.push(`- 实测值：${r.value}${r.unit ?? ''}`);
    if (r.threshold) L.push(`- 判据：${r.threshold}`);
    if (r.description) L.push(r.description);
    if (r.calc && r.calc.length) {
      L.push('\n**计算书：**');
      r.calc.forEach((c, i) => L.push(`${i + 1}. ${c.label}：${c.formula} → ${c.detail}`));
    }
    if (r.suggestion) L.push(`\n**处置建议：**${r.suggestion}`);
  });
  if (result.report?.regulations?.length) {
    L.push('\n## 规范依据');
    result.report.regulations.forEach(x => L.push(`- ${x}`));
  }
  const a = result.report?.actions;
  if (a) {
    L.push('\n## 分级处置建议');
    if (a.immediate?.length) { L.push('\n### 立即处置'); a.immediate.forEach(x => L.push(`- ${x}`)); }
    if (a.shortTerm?.length) { L.push('\n### 短期措施'); a.shortTerm.forEach(x => L.push(`- ${x}`)); }
    if (a.longTerm?.length) { L.push('\n### 长期措施'); a.longTerm.forEach(x => L.push(`- ${x}`)); }
  }
  if (result.report?.monitoring?.length) {
    L.push('\n## 监测与应急计划');
    result.report.monitoring.forEach(x => L.push(`- ${x}`));
  }
  if (result.report?.conclusion) L.push(`\n## 结论\n${result.report.conclusion}`);
  return L.join('\n');
}

export function buildCalcMarkdown(calcName: string, calcRef: string, params: Record<string, unknown>, result: CalcResult): string {
  const L: string[] = [];
  L.push(`# ${calcName} · 计算书`);
  L.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}`);
  L.push('\n## 输入参数');
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length) entries.forEach(([k, v]) => L.push(`- ${k}：${v}`));
  else L.push('- （未提供参数）');
  L.push('\n## 计算结果');
  if (result.value !== undefined) {
    const val = typeof result.value === 'number' ? result.value.toFixed(4) : result.value;
    L.push(`- 结果值：${val} ${result.unit ?? ''}`.trim());
  }
  L.push(`- 风险评级：${result.grade}`);
  if (result.formula) L.push(`\n## 计算公式\n${result.formula}`);
  if (result.analysis) L.push(`\n## 分析说明\n${result.analysis}`);
  L.push(`\n## 规范依据\n${result.ref ?? calcRef}`);
  return L.join('\n');
}

export function buildChatMarkdown(session: Session): string {
  const L: string[] = [];
  L.push(`# 专家问答会话：${session.title || '未命名会话'}`);
  L.push(`> 模型：${session.model} · 导出时间：${new Date().toLocaleString('zh-CN')}`);
  (session.messages ?? []).forEach(m => {
    const t = new Date(m.timestamp).toLocaleString('zh-CN');
    if (m.role === 'user') {
      L.push(`\n## 🧑 用户（${t}）\n${m.content}`);
    } else {
      L.push(`\n## 🤖 AI 助手（${t}）\n${m.content}`);
      if (m.toolCalls && m.toolCalls.length) {
        m.toolCalls.forEach(tc => {
          const tag = tc.type === 'calc' ? '工程计算' : tc.type === 'kb' ? '知识库检索' : '增强';
          L.push(`- ${tag}：${tc.name}（${tc.status}）`);
        });
      }
    }
  });
  return L.join('\n');
}

export function buildMultiAgentMarkdown(
  scenario: string,
  params: Record<string, string>,
  agents: { name: string; icon: string; status: string; result?: string }[],
): string {
  const L: string[] = [];
  L.push('# 多智能体联合诊断报告');
  L.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}`);
  L.push('\n## 输入场景');
  L.push(scenario);
  if (Object.keys(params).length) {
    L.push('\n## 场景参数');
    Object.entries(params).forEach(([k, v]) => L.push(`- ${k}：${v}`));
  }
  L.push('\n## 各领域分析');
  agents.forEach(a => {
    L.push(`\n### ${a.icon} ${a.name}`);
    L.push(a.result?.trim() ? a.result : `（${a.status === 'success' ? '无输出' : `状态：${a.status}`}）`);
  });
  return L.join('\n');
}

export function buildSimSnapshotMarkdown(geo: GeoParams, estimates: { desc: string }): string {
  const L: string[] = [];
  L.push('# 三维填埋场模拟 · 参数快照');
  L.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}`);
  L.push('\n## 几何参数（缩放系数）');
  L.push(`- 库容标定缩放：${geo.volumeScale} ×`);
  L.push(`- 谷底宽度缩放：${geo.valleyWidth} ×`);
  L.push(`- 堆高/层数缩放：${geo.pileHeight} ×`);
  L.push(`- 垃圾坝高缩放：${geo.damHeight} ×`);
  L.push(`- 调节池容积缩放：${geo.pondVolume} ×`);
  L.push(`- 导气井间距缩放：${geo.gasWellSpacing} ×`);
  L.push(`- 山体植被密度：${geo.treeDensity} ×`);
  L.push(`- 作业车辆数量：${geo.vehicleCount} 台`);
  L.push('\n## 模型估算');
  L.push(estimates.desc);
  return L.join('\n');
}
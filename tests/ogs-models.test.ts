/**
 * OGS 确定性模型黄金值回归测试
 *
 * 直接 import server/ogs.ts 的 computeOnly 函数不可行（未导出），
 * 因此通过 runOgsScenario 公共入口驱动，断言关键输出落在黄金区间。
 * 任何改动动力学系数/单位换算的提交若打破这些断言，说明结果漂移。
 */
import { runOgsScenario } from '../server/ogs.js';

let passed = 0;
let failed = 0;
function expect(cond: boolean, label: string, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  console.log('▶ gas-production 默认参数（500万t / 35°C / 50% / 1年）');
  {
    const r = await runOgsScenario('gas-production', {});
    expect(r.ok, '运行成功');
    const ch4 = r.timeSeries.find((s) => s.varName === 'ch4_cum');
    expect(!!ch4 && ch4.points.length === 365, 'CH₄ 累计曲线为日分辨率 365 点', String(ch4?.points.length));
    // 黄金值：aze 初始条件 + 堆体 588 万m³ 缩放，第 365 天 CH₄ ≈ 1.6457e4 万m³（±2%）
    const lastCh4 = ch4?.points[ch4.points.length - 1].v ?? NaN;
    expect(Math.abs(lastCh4 - 16457) / 16457 < 0.02, 'CH₄ 年累计 ≈ 16457 万m³ (±2%)', String(lastCh4));
    const rate = r.timeSeries.find((s) => s.varName === 'ch4_rate')!;
    const peak = Math.max(...rate.points.map((p) => p.v));
    expect(Math.abs(peak - 899) / 899 < 0.05, 'CH₄ 日产峰值 ≈ 899 万m³/d (±5%)', String(peak));
    expect(r.summary.includes('46.2%'), '干气 CH₄ 占比 ≈ 46.2%');
    expect(r.summary.includes('发电潜力 16'), '发电潜力量级正确（万MWh）');
  }

  console.log('▶ gas-production 多年限提示');
  {
    const r = await runOgsScenario('gas-production', { simYears: 20 });
    expect(r.summary.includes('产气在第 1 年内基本完成'), '>2 年时给出产气集中提示');
  }

  console.log('▶ degradation 默认参数（35°C / 1年）');
  {
    const r = await runOgsScenario('degradation', {});
    expect(r.ok, '运行成功');
    const fast = r.timeSeries.find((s) => s.varName === 'deg_fast')!;
    expect(fast.points[0].v > 25 && fast.points[0].v < 27, '易降解纤维素初值 ≈ 26.82', String(fast.points[0].v));
    expect(fast.points[fast.points.length - 1].v < 1, '易降解纤维素年内接近耗尽',
           String(fast.points[fast.points.length - 1].v));
  }

  console.log('▶ settlement 默认参数（Terzaghi）');
  {
    const t0 = Date.now();
    const r = await runOgsScenario('settlement', {});
    expect(r.ok, '运行成功');
    const disp = r.timeSeries[0];
    expect(disp.points.length >= 100, '沉降时程 ≥100 点');
    const lastV = disp.points[disp.points.length - 1].v;
    expect(Math.abs(Math.abs(lastV) - 0.02 * 0.993) < 0.001, '末端沉降 ≈ −0.0199 m', String(lastV));
    expect(disp.points[0].v === 0, '初始位移为 0');
    expect(Date.now() - t0 < 2000, '确定性计算秒出');
    // 软土固结应显著更慢
    const soft = await runOgsScenario('settlement', { youngsModulus: 1e7 });
    const softLast = soft.timeSeries[0].points.slice(-1)[0].v;
    expect(Math.abs(softLast) < Math.abs(lastV) * 0.5, '软土（低模量）同窗口内完成度更低');
  }

  console.log(`\n结果：${passed} 通过 · ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

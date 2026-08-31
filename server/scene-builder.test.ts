/**
 * scene-builder 单元测试 —— AI 生成 3D 场景（意图 → GeoParams 桥接）
 *
 * 与 tests/ogs-models.test.ts 同风格：零框架、自定义 expect、tsx 直接跑。
 * 覆盖：预设 / 自定义 clamp / 自然语言规则（含补强的斜坡比、中文数字、key=value）/
 *       OGS 联动成败 / 意图判定 / bogus 兜底。
 * 运行：npm run test:scene
 */
import {
  buildScene, DEFAULT_NL_PARSER, hasSceneIntent, cnToNum,
} from './scene-builder.js';
import { estimateSite, DEFAULT_GEO, GEO_PRESETS } from '../src/components/LandfillScene3D/geo.js';

let passed = 0;
let failed = 0;
function expect(cond: boolean, label: string, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function approx(a: number, b: number, tol = 1e-3): boolean {
  return Math.abs(a - b) <= tol;
}

async function main() {
  console.log('▶ buildScene · preset 预设');
  {
    const r = await buildScene({ intent: { kind: 'preset', key: 'small' } });
    expect(r.geo.volumeScale < 0.5, 'preset=small → volumeScale < 0.5', String(r.geo.volumeScale));
    expect(r.preset === 'small', 'preset 名回传 small');
    expect(r.geo.pileHeight < 1, 'preset=small 堆高偏低');
    expect(r.snapshot.desc.includes('库容'), 'snapshot 含库容描述');
  }

  console.log('▶ buildScene · custom 参数越界自动 clamp');
  {
    const r = await buildScene({
      intent: { kind: 'custom', geo: { pileHeight: 99, vehicleCount: 999, valleyWidth: -5 } },
    });
    expect(r.geo.pileHeight <= 1.8, 'pileHeight 99 → clamp ≤ 1.8', String(r.geo.pileHeight));
    expect(r.geo.vehicleCount <= 8, 'vehicleCount 999 → clamp ≤ 8', String(r.geo.vehicleCount));
    expect(r.geo.valleyWidth >= 0.6, 'valleyWidth -5 → clamp ≥ 0.6', String(r.geo.valleyWidth));
    expect(r.geo.pileHeight === 1.8 && r.geo.vehicleCount === 8, 'clamp 落在边界精确值');
  }

  console.log('▶ buildScene · natural 关键词兜底');
  {
    const r = await buildScene({ intent: { kind: 'natural', text: '缓坡 小型 500万 m³ 的填埋场' } }, {
      nlParser: DEFAULT_NL_PARSER,
    });
    expect(r.geo.pileHeight < 1, '缓坡 → 堆高 < 1', String(r.geo.pileHeight));
    expect(approx(r.geo.volumeScale, 1.0, 0.05), '500万 m³ → volumeScale ≈ 1.0', String(r.geo.volumeScale));
    expect(r.preset === 'natural', 'preset 名回传 natural');
  }

  console.log('▶ buildScene · OGS 失败静默');
  {
    const r = await buildScene(
      { intent: { kind: 'preset', key: 'default' }, injectOgs: true, ogsScenario: 'gas-production' },
      { runOgs: async () => { throw new Error('OGS down'); } },
    );
    expect(r.ogSummary === undefined, 'OGS 抛错 → ogSummary undefined 不抛');
    expect(r.geo !== undefined && Object.keys(r.geo).length === 8, 'geo 8 维仍完整');
  }

  console.log('▶ buildScene · OGS 成功注入');
  {
    const r = await buildScene(
      { intent: { kind: 'preset', key: 'default' }, injectOgs: true },
      { runOgs: async () => ({ peakValue: 899, unit: '万m³/d' }) },
    );
    expect(r.ogSummary?.scenario === 'gas-production', '默认场景 gas-production');
    expect(r.ogSummary?.peakValue === 899, '峰值 899 透传');
    expect(r.ogSummary?.unit === '万m³/d', '单位透传');
  }

  console.log('▶ DEFAULT_NL_PARSER · 补强规则');
  {
    // 斜坡比：1:3 → 缓坡堆高
    const slope = DEFAULT_NL_PARSER('把堆体放缓到 1:3');
    expect(approx(slope.pileHeight ?? 1, 0.8, 0.01), '1:3 → pileHeight 0.8', String(slope.pileHeight));
    const steep = DEFAULT_NL_PARSER('堆体做成 1:2');
    expect(approx(steep.pileHeight ?? 1, 1.4, 0.01), '1:2 → pileHeight 1.4', String(steep.pileHeight));
    // 中文数字：五百万 m³ → volumeScale ≈ 1
    const cnVol = DEFAULT_NL_PARSER('建一个五百万 m³ 的填埋场');
    expect(approx(cnVol.volumeScale ?? 0, 1.0, 0.05), '五百万 m³ → volumeScale ≈ 1.0', String(cnVol.volumeScale));
    // 审查回归：混合数字"2千万"（阿拉伯+汉字）×亿
    const mixVol = DEFAULT_NL_PARSER('2千万 m³ 的填埋场');
    expect(approx(mixVol.volumeScale ?? 0, 2.2, 0.001), '2千万 → volumeScale clamp 2.2', String(mixVol.volumeScale));
    const yiVol = DEFAULT_NL_PARSER('5亿 m³ 的超大填埋场');
    expect(yiVol.volumeScale === 2.2, '5亿 → volumeScale clamp 2.2', String(yiVol.volumeScale));
    // key=value：谷宽=1.5 堆高=1.6
    const kv = DEFAULT_NL_PARSER('自定义 谷宽=1.5 堆高=1.6');
    expect(approx(kv.valleyWidth ?? 0, 1.5, 0.001), '谷宽=1.5 解析', String(kv.valleyWidth));
    expect(approx(kv.pileHeight ?? 0, 1.6, 0.001), '堆高=1.6 解析', String(kv.pileHeight));
    // 大型 / 小型
    const big = DEFAULT_NL_PARSER('我要个大型的填埋场');
    expect(big.volumeScale === 1.6 && big.pileHeight === 1.3, '大型 → volumeScale 1.6 + 堆高 1.3');
    // bogus 文本 → 空对象（调用方据此判定无场景意图）
    const bogus = DEFAULT_NL_PARSER('今天天气怎么样');
    expect(Object.keys(bogus).length === 0, 'bogus 文本 → 空对象（不误触发）', JSON.stringify(bogus));
  }

  console.log('▶ cnToNum · 中文数字');
  {
    expect(cnToNum('五百万') === 5000000, '五百万 → 5000000', String(cnToNum('五百万')));
    expect(cnToNum('五百') === 500, '五百 → 500', String(cnToNum('五百')));
    expect(cnToNum('二十三') === 23, '二十三 → 23', String(cnToNum('二十三')));
    expect(cnToNum('12') === 12, '阿拉伯 12 透传');
    expect(cnToNum('xyz') === null, '非法输入 → null');
  }

  console.log('▶ hasSceneIntent · 意图判定');
  {
    expect(hasSceneIntent('建一个缓坡山谷型 500 万 m³ 的填埋场'), '建场语 → true');
    expect(hasSceneIntent('把堆体放缓到 1:3'), '改堆体 → true');
    expect(hasSceneIntent('我要个小型的'), '小型的（上下文建场）→ true');
    expect(!hasSceneIntent('填埋场渗滤液怎么处理'), '普通问答 → false');
    expect(!hasSceneIntent('今天天气怎么样'), '无关闲聊 → false');
    // 审查回归：规模词+疑问句不得误触发（"填埋场库容500万m³怎么算"不是建场）
    expect(!hasSceneIntent('填埋场库容 500万m³ 怎么算？'), '规模词+疑问 → false（不误触发）');
    expect(!hasSceneIntent('调节池容积标准是什么'), '参数名词+疑问 → false');
    // 审查回归：显式建场裸请求必须放行（而解析零命中也该出卡片）
    expect(hasSceneIntent('生成一个3D场景'), '裸建场请求 → true');
    expect(hasSceneIntent('帮我建一个填埋场模型'), '建模型 → true');
  }

  console.log('▶ buildScene · bogus 文本兜底（A4）');
  {
    const r = await buildScene({ intent: { kind: 'natural', text: 'bogus 文本' } });
    expect(r.geo.pileHeight === 1 && r.geo.volumeScale === 1, 'bogus → 默认场景（不抛错）', JSON.stringify(r.geo));
    expect(r.snapshot.desc.length > 0, 'bogus → snapshot 正常');
  }

  console.log('▶ buildScene · malformed intent 防御');
  {
    const r = await buildScene(undefined as any);
    expect(r.geo.pileHeight === 1, 'input undefined → 默认场景不抛错');
    const r2 = await buildScene({ intent: {} } as any);
    expect(r2.geo.volumeScale === 1, 'intent 缺 kind → 默认场景不抛错');
  }

  console.log('▶ buildScene · custom 数值消毒（审查 MED 回归）');
  {
    // LLM 传字符串 / NaN → 该字段被丢弃回退默认，不传播 NaN 到 snapshot
    const r = await buildScene({
      intent: { kind: 'custom', geo: { valleyWidth: '1.5' as any, pileHeight: NaN as any, volumeScale: 2 } },
    });
    expect(Number.isFinite(r.geo.valleyWidth) && r.geo.valleyWidth === 1, '字符串 valleyWidth → 过滤回默认 1', String(r.geo.valleyWidth));
    expect(Number.isFinite(r.geo.pileHeight) && r.geo.pileHeight === 1, 'NaN pileHeight → 过滤回默认 1');
    expect(r.geo.volumeScale === 2, '有限数字 volumeScale 保留');
    expect(!r.snapshot.desc.includes('NaN'), 'snapshot 不含 NaN', r.snapshot.desc);
  }

  console.log('▶ 库容标定（v4.5 回归：默认≈500 万 m³，随几何联动）');
  {
    const wan = (v: string) => parseFloat(v);
    const def = estimateSite(DEFAULT_GEO);
    expect(Math.abs(wan(def.volumeWanM3) - 500) <= 1, '默认几何 → 设计库容 ≈ 500 万 m³', def.volumeWanM3);
    // 缓坡山谷型 500万：谷宽 1.2 × 堆高 0.7 × 库容系数 1.0 → ≈504 万
    const slope = estimateSite({ valleyWidth: 1.2, pileHeight: 0.7, volumeScale: 1.0 });
    expect(Math.abs(wan(slope.volumeWanM3) - 504) <= 5, '缓坡山谷 500万 → ≈504 万 m³', slope.volumeWanM3);
    // 大型场预设 → 库容显著大于默认
    const large = estimateSite(GEO_PRESETS.find(p => p.key === 'large')!.geo);
    expect(wan(large.volumeWanM3) > 1000, '大型场 → 库容 > 1000 万 m³', large.volumeWanM3);
    // 调整堆体高度 → 库容联动增大
    const taller = estimateSite({ pileHeight: 1.4 });
    expect(Math.abs(wan(taller.volumeWanM3) - 700) <= 1, '堆高 1.4 → 库容 ≈ 700 万 m³', taller.volumeWanM3);
    // 建 1000 万 m³ → volumeScale 2.0 → 库容 ≈ 1000 万
    const thousand = estimateSite({ volumeScale: 2.0 });
    expect(Math.abs(wan(thousand.volumeWanM3) - 1000) <= 1, 'volumeScale 2.0 → 库容 ≈ 1000 万 m³', thousand.volumeWanM3);
    expect(def.desc.includes('500 万 m³'), 'desc 默认含 500 万 m³', def.desc.slice(0, 40));
  }

  console.log(`\n${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

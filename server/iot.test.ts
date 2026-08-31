/**
 * iot.test.ts · IoT 数据流单元测试
 *
 * 覆盖：
 *   1) classifyLevel 阈值分级边界（绿/黄/橙/红）
 *   2) nextReading 数据形态（值非负、单位/标签/坐标一致、等级与阈值一致）
 *   3) snapshotReadings 完整性（5 个传感器、shape 合法，无需启动 broker）
 *   4) startIotBroker + onIotPublish 发布/订阅回放（真实 localhost MQTT 往返）
 *   5) 优雅关闭（stopIotBroker 幂等、不抛错）
 */

import { startIotBroker, stopIotBroker, snapshotReadings, onIotPublish, classifyLevel, nextReading } from './iot.js';
import type { SensorSpec, SensorKey } from './iot.js';
import mqtt from 'mqtt';

const LABEL_BY_KEY: Record<SensorKey, string> = {
  ch4: '导气井 #1  CH₄',
  h2s: '渗滤液 H₂S',
  waterLevel: '监测井 #A 水位',
  settlement: '堆体沉降 S2',
  temperature: '堆体温度 T3',
};
const SENSOR_KEYS = Object.keys(LABEL_BY_KEY) as SensorKey[];

function spec(over: Partial<SensorSpec> = {}): SensorSpec {
  return {
    key: 'ch4',
    label: '导气井 #1  CH₄',
    unit: '%LEL',
    base: 18,
    range: 12,
    warnThreshold: 25,
    dangerThreshold: 50,
    periodMs: 1800,
    position: { x: -60, y: 30, z: -40 },
    ...over,
  };
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.error(`  ✗ ${name} — ${e.message}`);
  }
}

async function run(): Promise<void> {
  // 1) classifyLevel 边界
  await check('value ≥ danger → red', () => {
    assert(classifyLevel(50, 25, 50) === 'red', '=danger 应 red');
    assert(classifyLevel(99, 25, 50) === 'red', '>danger 应 red');
  });
  await check('warn ≤ value < danger → orange', () => {
    assert(classifyLevel(25, 25, 50) === 'orange', '=warn 应 orange');
    assert(classifyLevel(49.9, 25, 50) === 'orange', '<danger 应 orange');
  });
  await check('warn*0.7 ≤ value < warn → yellow', () => {
    assert(classifyLevel(17.5, 25, 50) === 'yellow', '=warn*0.7 应 yellow');
    assert(classifyLevel(24.9, 25, 50) === 'yellow', '<warn 应 yellow');
  });
  await check('value < warn*0.7 → green', () => {
    assert(classifyLevel(0, 25, 50) === 'green', '0 应 green');
    assert(classifyLevel(17.4, 25, 50) === 'green', '<warn*0.7 应 green');
  });

  // 2) nextReading 形态
  await check('nextReading 值非负且等级与阈值一致', () => {
    const r = nextReading(spec());
    assert(Number.isFinite(r.value) && r.value >= 0, 'value 应非负有限');
    assert(r.unit === '%LEL', 'unit 应透传');
    assert(r.label === '导气井 #1  CH₄', 'label 应透传');
    assert(r.position.x === -60 && r.position.y === 30 && r.position.z === -40, 'position 应透传');
    assert(/^\d{4}-\d{2}-\d{2}T/.test(r.ts), 'ts 应为 ISO 时间');
    assert(r.level === classifyLevel(r.value, 25, 50), 'level 应与阈值判定一致');
  });
  await check('nextReading 值有界且非负（50 次采样）', () => {
    for (let i = 0; i < 50; i++) {
      const r = nextReading(spec({ base: 20, range: 10 }));
      assert(r.value >= 0 && r.value <= 40, `value=${r.value} 越界`);
    }
  });

  // 3) snapshotReadings 完整性（不启动 broker）
  await check('snapshotReadings 返回 5 个传感器且 shape 合法', () => {
    const readings = snapshotReadings();
    assert(readings.length === 5, `应为 5 条，实际 ${readings.length}`);
    const labels = readings.map((r) => r.label);
    for (const k of SENSOR_KEYS) {
      assert(labels.includes(LABEL_BY_KEY[k]), `缺少 ${k}`);
    }
    for (const r of readings) {
      assert(Number.isFinite(r.value) && r.value >= 0, 'value 应非负有限');
      assert(['green', 'yellow', 'orange', 'red'].includes(r.level), 'level 非法');
      assert(Boolean(r.unit && r.label && r.position), 'unit/label/position 缺失');
    }
  });

  // 5) 优雅关闭幂等（先测：未启动时不抛错）
  await check('stopIotBroker 未启动时调用不抛错', async () => {
    await stopIotBroker();
  });

  // 4) broker 发布/订阅回放（真实 localhost MQTT）
  await check('startIotBroker + onIotPublish 发布/订阅回放', async () => {
    const { port } = await startIotBroker(1899);
    try {
      const got: { topic: string; value: number }[] = [];
      const off = onIotPublish((r, topic) => got.push({ topic, value: r.value }));

      const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'iot-test-pub', reconnectPeriod: 200 });
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
      });
      client.publish('landfill/sensor/ch4', JSON.stringify({ value: 42, unit: '%LEL', label: LABEL_BY_KEY.ch4 }));
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      client.end(true);

      assert(got.length === 1, `应收到 1 条，实际 ${got.length}`);
      assert(got[0].topic === 'landfill/sensor/ch4', 'topic 应正确');
      assert(got[0].value === 42, 'payload 应解析');
      off();
    } finally {
      await stopIotBroker();
    }
  });

  // 5) 再测：已停止后二次 stop 幂等
  await check('stopIotBroker 重复调用幂等', async () => {
    await stopIotBroker();
    await stopIotBroker();
  });

  console.log(`\n结果：${passed} 通过 · ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error('测试运行异常:', e);
  process.exit(1);
});

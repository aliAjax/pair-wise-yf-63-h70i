// 中央登记账本行为测试：node scripts/test-central-registry.mjs
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { CentralRegistry } = await jiti.import('../server/centralRegistry.ts');

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    _dump: () => Object.fromEntries(map)
  };
}

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

const baseInput = (over = {}) => ({
  requestId: 'req-1',
  participantNo: 'S01-003',
  identityKey: 'id-003',
  site: '上海中心',
  ageBand: '45-64',
  queuedAt: new Date().toISOString(),
  ...over
});

// 1. 首次登记发号，重复确认幂等，并发也只入库一次
{
  console.log('幂等与并发收口');
  const reg = new CentralRegistry(memoryStorage());
  const [r1, r2, r3] = await Promise.all([
    reg.register(baseInput()),
    reg.register(baseInput()),
    reg.register(baseInput())
  ]);
  assert('首次登记 registered', r1.outcome === 'registered');
  assert('并发重复确认为 duplicate-request', r2.outcome === 'duplicate-request' && r3.outcome === 'duplicate-request');
  assert('三次返回同一份回执', r1.receipt.receiptId === r2.receipt.receiptId && r2.receipt.receiptId === r3.receipt.receiptId);
  assert('随机号一致', r1.receipt.sequence === 1001 && r2.receipt.sequence === 1001 && r3.receipt.sequence === 1001);
  assert('治疗组一致', r1.receipt.arm === r2.receipt.arm);
  assert('账本只有一条登记', reg.listRegistrations().length === 1);
}

// 2. 全场唯一：编号 / 身份标识只能登记一次
{
  console.log('全场唯一约束');
  const reg = new CentralRegistry(memoryStorage());
  const a = await reg.register(baseInput());
  const b = await reg.register(baseInput({ requestId: 'req-2', identityKey: 'id-003-other' }));
  const c = await reg.register(baseInput({ requestId: 'req-3', participantNo: 'S01-099', identityKey: 'id-003' }));
  assert('首次成功', a.outcome === 'registered');
  assert('编号冲突被中央拒绝', b.outcome === 'duplicate-conflict' && b.conflictField === 'participantNo');
  assert('身份标识冲突被中央拒绝', c.outcome === 'duplicate-conflict' && c.conflictField === 'identityKey');
  assert('冲突不占号（nextSequence 不变）', reg.listRegistrations().length === 1);
}

// 3. 断网（中央不可达）不发号，恢复后原请求重放成功并沿用内容
{
  console.log('断网保留 + 恢复重放');
  const reg = new CentralRegistry(memoryStorage());
  reg.setOutage(true);
  const down = await reg.register(baseInput());
  assert('中断时登记返回 unavailable', down.outcome === 'unavailable');
  assert('中断期间账本无登记', reg.listRegistrations().length === 0);
  reg.setOutage(false);
  const replay = await reg.register(baseInput());
  assert('恢复后重放首次入库', replay.outcome === 'registered');
  assert('恢复后取得随机号 1001', replay.receipt.sequence === 1001);
  assert('再次重放为幂等重复请求', (await reg.register(baseInput())).outcome === 'duplicate-request');
}

// 4. 回执：有效可核验、过期不改分组、未知回执拒绝、刷新后沿用原随机号
{
  console.log('中央回执核验');
  const reg = new CentralRegistry(memoryStorage());
  const r = await reg.register(baseInput());
  const v = await reg.verifyReceipt(r.receipt.receiptId);
  assert('有效回执核验通过', v.outcome === 'valid' && v.registration.sequence === r.receipt.sequence);
  await reg.expireActiveReceipt('req-1');
  const expired = await reg.verifyReceipt(r.receipt.receiptId);
  assert('过期回执被识别', expired.outcome === 'expired');
  assert('过期不改变随机号/治疗组', expired.registration.sequence === 1001 && expired.registration.arm === r.receipt.arm);
  const unknown = await reg.verifyReceipt('rcpt-forged');
  assert('未知回执拒绝', unknown.outcome === 'unknown');
  const fresh = await reg.refreshReceipt('req-1');
  const v2 = await reg.verifyReceipt(fresh.receiptId);
  assert('刷新回执后有效', v2.outcome === 'valid');
  assert('刷新后沿用原随机号/治疗组', v2.registration.sequence === 1001 && v2.registration.arm === r.receipt.arm);
}

// 5. 持久化与恢复：新建实例后账本仍在，已入库记录沿用原随机号
{
  console.log('可恢复持久化');
  const storage = memoryStorage();
  const reg1 = new CentralRegistry(storage);
  const r = await reg1.register(baseInput());
  const reg2 = new CentralRegistry(storage);
  const again = await reg2.register(baseInput());
  assert('重建实例后重复确认返回既有回执', again.outcome === 'duplicate-request');
  assert('沿用原随机号', again.receipt.sequence === r.receipt.sequence);
  const v = await reg2.verifyReceipt(r.receipt.receiptId);
  assert('重建后回执仍可核验', v.outcome === 'valid');
}

// 6. 基线 seed：只植入一次并沿用指定随机号
{
  console.log('基线植入');
  const storage = memoryStorage();
  const seed = [
    { requestId: 'seed-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', sequence: 1001, arm: 'A' },
    { requestId: 'seed-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', sequence: 1002, arm: 'B' }
  ];
  new CentralRegistry(storage).seed(seed);
  const reg2 = new CentralRegistry(storage);
  reg2.seed([{ ...seed[0], sequence: 9999 }]);
  const list = reg2.listRegistrations();
  assert('基线只植入一次', list.length === 2 && list[0].sequence === 1001 && list[1].sequence === 1002);
  const next = await reg2.register(baseInput({ requestId: 'req-x', participantNo: 'S01-010', identityKey: 'id-x' }));
  assert('基线之后新登记随机号单调递增', next.receipt.sequence === 1003);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

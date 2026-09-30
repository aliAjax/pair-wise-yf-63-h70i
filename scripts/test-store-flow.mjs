// 入组/队列/审计编排端到端测试：node scripts/test-store-flow.mjs
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, {
  alias: { '~': root, '@': root }
});

const { createPinia, setActivePinia } = await jiti.import('pinia');
const { useTrialStore } = await jiti.import('../stores/trial.ts');
const { CentralRegistry } = await jiti.import('../server/centralRegistry.ts');
const { __setCentralRegistryForTest } = await jiti.import('../composables/useCentralRegistry.ts');

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v)
  };
}

function freshStore() {
  __setCentralRegistryForTest(new CentralRegistry(memoryStorage()));
  setActivePinia(createPinia());
  return useTrialStore();
}

const input = (over = {}) => ({
  participantNo: 'S01-003',
  identityKey: 'id-003',
  site: '上海中心',
  ageBand: '45-64',
  actor: '研究者张宁',
  ...over
});

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
// 1. 离线入队 + 全场唯一预检
{
  console.log('离线入队与唯一预检');
  const store = freshStore();
  await store.init();
  const r = await store.randomize(input(), true);
  assert('离线入队成功', r.ok);
  assert('未本地发号（受试者仍只有基线2人）', store.participants.length === 2);
  const q = store.pending[0];
  assert('队列项有原提交顺序', q.orderIndex === 0 && q.status === 'pending');
  assert('原入组内容保留', q.payload.participantNo === 'S01-003' && q.payload.identityKey === 'id-003');

  const dupNo = await store.randomize(input({ identityKey: 'id-other', actor: '研究者李四' }), true);
  assert('队列中编号重复被拦截', !dupNo.ok);
  const dupId = await store.randomize(input({ participantNo: 'S01-099', actor: '研究者李四' }), true);
  assert('队列中身份标识重复被拦截', !dupId.ok);
  assert('拦截不新增队列项', store.pending.length === 1);
}

// 2. 并发确认：只入库一次、一个随机号、一份回执
{
  console.log('并发确认收口');
  const store = freshStore();
  await store.init();
  await store.randomize(input(), true);
  const id = store.pending[0].id;
  const [r1, r2] = await Promise.all([
    store.confirmPending(id, '管理员甲'),
    store.confirmPending(id, '管理员乙')
  ]);
  assert('至少一次确认成功', r1.ok || r2.ok);
  assert('只有一条受试者记录', store.participants.filter((p) => p.requestId === id).length === 1);
  const p = store.participants.find((x) => x.requestId === id);
  assert('随机号由中央发放（1003）', p.sequence === 1003, `got ${p.sequence}`);
  assert('队列项已入库且只保留一份回执', store.pending[0].status === 'committed');
  assert('页面与队列引用同一回执号', p.receiptId && p.receiptId === store.pending[0].receipt.receiptId);
  const audit = store.audits.find((a) => a.action === 'pending-committed');
  assert('审计记录同一回执号', audit && audit.receiptId === p.receiptId);
}

// 3. 断网在线入组 → 恢复自动按序重放，已入库沿用原随机号
{
  console.log('断网保留 + 恢复按序重放');
  const store = freshStore();
  await store.init();
  await store.setCentralOutage(true, '研究者张宁');
  const a = await store.randomize(input({ participantNo: 'S01-010', identityKey: 'id-010' }));
  const b = await store.randomize(input({ participantNo: 'S01-011', identityKey: 'id-011', site: '广州中心' }));
  assert('中断时两次入组都保留成功', a.ok && b.ok);
  assert('中断期间未发号', store.participants.length === 2);
  assert('队列保持原提交顺序', store.pendingOrdered[0].payload.participantNo === 'S01-010');
  await store.setCentralOutage(false, '研究者张宁');
  const p10 = store.participants.find((p) => p.participantNo === 'S01-010');
  const p11 = store.participants.find((p) => p.participantNo === 'S01-011');
  assert('两条均入库', p10 && p11);
  assert('按原序发放随机号 1003/1004', p10.sequence === 1003 && p11.sequence === 1004, `${p10?.sequence}/${p11?.sequence}`);
  // 重入/刷新对账后沿用原随机号
  const again = await store.reconfirmCommitted(store.pending[0].id, '管理员甲');
  assert('重复确认回执核验一致并沿用原号', again.ok && again.message.includes('1003'));
}

// 4. 失败保留原因与重试次数
{
  console.log('失败原因与重试计数');
  const store = freshStore();
  await store.init();
  await store.setCentralOutage(true, '研究者张宁');
  await store.randomize(input({ participantNo: 'S01-020', identityKey: 'id-020' }));
  const id = store.pending[0].id;
  const f1 = await store.confirmPending(id, '管理员甲');
  const f2 = await store.confirmPending(id, '管理员甲');
  assert('中央不可达时确认失败', !f1.ok && !f2.ok);
  assert('记录重试次数=2 与失败原因', store.pending[0].retries === 2 && store.pending[0].failureReason.includes('不可达'));
  assert('失败项仍保留原入组内容', store.pending[0].payload.participantNo === 'S01-020');
  await store.setCentralOutage(false, '研究者张宁');
  assert('恢复后重放入库', store.pending[0].status === 'committed');
  assert('入库后沿用中央原随机号', store.participants.find((p) => p.requestId === id).sequence === 1003);
  assert('失败原因在入库后清除', !store.pending[0].failureReason);
}

// 5. 过期/未知回执不能改写已落定分组
{
  console.log('回执防改写');
  const store = freshStore();
  await store.init();
  await store.randomize(input(), true);
  const id = store.pending[0].id;
  await store.confirmPending(id, '管理员甲');
  const before = store.participants.find((p) => p.requestId === id);
  const seq = before.sequence;
  const arm = before.arm;
  const { useCentralRegistry } = await jiti.import('../composables/useCentralRegistry.ts');
  await useCentralRegistry().expireActiveReceipt(id);
  const expired = await store.confirmPending(id, '管理员乙');
  assert('过期回执确认被拒绝', !expired.ok);
  const after = store.participants.find((p) => p.requestId === id);
  assert('已落定随机号/治疗组不变', after.sequence === seq && after.arm === arm);
  const refreshed = await store.refreshReceipt(id, '管理员甲');
  const reOk = await store.confirmPending(id, '管理员甲');
  assert('刷新回执后确认成功', refreshed.ok && reOk.ok);
  assert('刷新后仍沿用原随机号/治疗组', store.participants.find((p) => p.requestId === id).sequence === seq);
}

// 6. 角色隔离：发药仅药品管理员；揭盲仅研究者且必须留原因
{
  console.log('角色隔离与揭盲留因');
  const store = freshStore();
  await store.init();
  const target = store.participants[0];
  const denyDisp = store.updateDispensing(target.requestId, { kitNo: 'K-1', lotNo: 'L-1' }, '研究者张宁', 'investigator');
  assert('研究者不能维护发药', !denyDisp.ok);
  const okDisp = store.updateDispensing(target.requestId, { kitNo: 'KIT-9', lotNo: 'LOT-9' }, '药师范蕾', 'pharmacist');
  assert('药品管理员维护发药成功', okDisp && target.dispensing.kitNo === 'KIT-9');
  assert('发药不触碰随机号', target.sequence === 1001);

  const denyUnblind = store.emergencyUnblind(target.id, '紧急', '药师范蕾', 'pharmacist');
  assert('药品管理员不能揭盲', !denyUnblind.ok);
  const noReason = store.emergencyUnblind(target.id, '   ', '研究者张宁', 'investigator');
  assert('揭盲原因必填', !noReason.ok);
  const okUnblind = store.emergencyUnblind(target.id, '受试者发生SAE需获知治疗组', '研究者张宁', 'investigator');
  assert('带原因揭盲成功', okUnblind.ok && target.status === 'unblinded' && target.unblindReason.includes('SAE'));
  const again = store.emergencyUnblind(target.id, '再来一次', '研究者张宁', 'investigator');
  assert('已揭盲不可改写', !again.ok);
  const audit = store.audits.find((a) => a.action === 'unblinded');
  assert('揭盲原因进入仅追加审计', audit && audit.detail.includes('SAE'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

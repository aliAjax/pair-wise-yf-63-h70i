import { defineStore } from 'pinia';
import type { Arm, CentralReceipt, LedgerEntry, RandomizeInput } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

/**
 * 中央登记处（模拟）。
 * - 台账（ledger）以客户端幂等键 clientKey 去重：同一提交无论确认多少次，只落定一次分组。
 * - 受试者编号、身份核验标识在全场台账中只能登记一次。
 * - 入库以中央回执为准；回执有有效期，重复/过期回执不能改写已落定分组。
 * 真实环境中这就是远端 IWRS/CTMS 服务，这里用 localStorage 模拟其持久化。
 */
const REGISTRY_KEY = 'trial-central-registry-v1';
const RECEIPT_TTL_MS = 10 * 60 * 1000; // 回执有效期 10 分钟
const SEED_EXPIRY = '2099-01-01T00:00:00.000Z';

export type CentralFailReason =
  | 'network-offline'
  | 'network-timeout'
  | 'duplicate-participant'
  | 'duplicate-identity'
  | 'receipt-unknown'
  | 'receipt-expired';

export class CentralError extends Error {
  constructor(public reason: CentralFailReason, message: string) {
    super(message);
    this.name = 'CentralError';
  }
}

interface CentralState {
  ledger: Record<string, LedgerEntry>;
  receipts: Record<string, CentralReceipt>;
}

const seedCentral = (): CentralState => ({
  ledger: {
    'seed-key-1': { clientKey: 'seed-key-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', sequence: 1001, arm: 'A', receiptId: 'R-SEED-1', committedAt: new Date(Date.now() - 7200_000).toISOString() },
    'seed-key-2': { clientKey: 'seed-key-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', sequence: 1002, arm: 'B', receiptId: 'R-SEED-2', committedAt: new Date(Date.now() - 3600_000).toISOString() }
  },
  receipts: {
    'R-SEED-1': { id: 'R-SEED-1', key: 'seed-key-1', sequence: 1001, arm: 'A', issuedAt: new Date(Date.now() - 7200_000).toISOString(), expiresAt: SEED_EXPIRY },
    'R-SEED-2': { id: 'R-SEED-2', key: 'seed-key-2', sequence: 1002, arm: 'B', issuedAt: new Date(Date.now() - 3600_000).toISOString(), expiresAt: SEED_EXPIRY }
  }
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const useRegistryStore = defineStore('registry', {
  state: () => ({
    ...readLocal<CentralState>(REGISTRY_KEY, seedCentral()),
    online: true,
    /** 恢复链路抖动开关：离线记录联网后首次重放模拟一次超时，重试即成功（确定性演示） */
    flakyEnabled: true,
    /** 待触发首次重放超时的幂等键（内存态，不持久化） */
    flakyKeys: new Set<string>()
  }),
  actions: {
    persist() {
      writeLocal(REGISTRY_KEY, { ledger: this.ledger, receipts: this.receipts });
    },
    setOnline(value: boolean) {
      this.online = value;
    },
    /** 离线入组时标记：该记录联网后的第一次重放模拟链路超时 */
    markFlaky(clientKey: string) {
      this.flakyKeys.add(clientKey);
    },
    /** 从其他标签页的写入中同步（多名管理员并发确认时共享同一份中央结果） */
    hydrate() {
      const data = readLocal<CentralState | null>(REGISTRY_KEY, null);
      if (data) this.$patch({ ledger: data.ledger, receipts: data.receipts });
    },
    /**
     * 中央登记入库。幂等：同一 clientKey 重复提交返回同一份回执，不重新发号、不改写分组。
     */
    async register(input: RandomizeInput, clientKey: string): Promise<{ ok: true; receipt: CentralReceipt; duplicated: boolean } | { ok: false; reason: CentralFailReason }> {
      if (!this.online) throw new CentralError('network-offline', '中央登记处不可达（离线）');
      await delay(250 + Math.random() * 450);
      if (this.flakyEnabled && this.flakyKeys.has(clientKey)) {
        this.flakyKeys.delete(clientKey);
        throw new CentralError('network-timeout', '中央登记处响应超时（恢复链路不稳定）');
      }
      // 幂等：同一次提交（同一 clientKey）只落定一次
      const existing = this.ledger[clientKey];
      if (existing) {
        return { ok: true, receipt: this.receipts[existing.receiptId], duplicated: true };
      }
      // 唯一性：受试者编号、身份核验标识全场只能登记一次
      if (Object.values(this.ledger).some((entry) => entry.participantNo === input.participantNo)) {
        return { ok: false, reason: 'duplicate-participant' };
      }
      if (Object.values(this.ledger).some((entry) => entry.identityKey === input.identityKey)) {
        return { ok: false, reason: 'duplicate-identity' };
      }

      // 中央发号：流水号只由中央分配，本地列表不再发号
      const allocated = Object.values(this.ledger).map((entry) => entry.sequence);
      const sequence = allocated.length ? Math.max(...allocated) + 1 : 1003;
      // 分层区组：按中央台账中的同层记录平衡 A/B
      const stratum = Object.values(this.ledger).filter((entry) => entry.site === input.site && entry.ageBand === input.ageBand);
      const arm: Arm = stratum.filter((entry) => entry.arm === 'A').length <= stratum.filter((entry) => entry.arm === 'B').length ? 'A' : 'B';

      const now = new Date();
      const receipt: CentralReceipt = {
        id: `R-${crypto.randomUUID().slice(0, 8)}`,
        key: clientKey,
        sequence,
        arm,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + RECEIPT_TTL_MS).toISOString()
      };
      this.ledger[clientKey] = {
        clientKey,
        participantNo: input.participantNo,
        identityKey: input.identityKey,
        site: input.site,
        ageBand: input.ageBand,
        sequence,
        arm,
        receiptId: receipt.id,
        committedAt: receipt.issuedAt
      };
      this.receipts[receipt.id] = receipt;
      this.persist();
      return { ok: true, receipt, duplicated: false };
    },
    /** 校验回执：不存在或已过期则拒绝，不能用于改写已落定分组 */
    verifyReceipt(receiptId?: string): { ok: true; receipt: CentralReceipt } | { ok: false; reason: 'receipt-unknown' | 'receipt-expired' } {
      if (!receiptId) return { ok: false, reason: 'receipt-unknown' };
      const receipt = this.receipts[receiptId];
      if (!receipt) return { ok: false, reason: 'receipt-unknown' };
      if (new Date(receipt.expiresAt).getTime() <= Date.now()) return { ok: false, reason: 'receipt-expired' };
      return { ok: true, receipt };
    }
  }
});

import { defineStore } from 'pinia';
import type { AuditEntry, CentralReceipt, Participant, PendingRandomization, RandomizeInput } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';
import { CentralError, useRegistryStore } from '~/stores/registry';

const STORAGE_KEY = 'trial-randomization-v2';

const seed: { participants: Participant[]; audits: AuditEntry[]; pending: PendingRandomization[] } = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A', clientKey: 'seed-key-1', receiptId: 'R-SEED-1', committedAt: new Date(Date.now() - 7200_000).toISOString() },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B', clientKey: 'seed-key-2', receiptId: 'R-SEED-2', committedAt: new Date(Date.now() - 3600_000).toISOString() }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成中央入库，随机号 1002，回执 R-SEED-2', participantNo: 'S01-002' }
  ],
  pending: []
};

export const useTrialStore = defineStore('trial', {
  state: () => readLocal<{ participants: Participant[]; audits: AuditEntry[]; pending: PendingRandomization[] }>(STORAGE_KEY, seed),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    /** 待提交 + 失败待重试，均为未入库记录 */
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending' || item.status === 'failed').length
  },
  actions: {
    persist() {
      writeLocal(STORAGE_KEY, { participants: this.participants, audits: this.audits, pending: this.pending });
    },
    hydrate() {
      const data = readLocal<{ participants: Participant[]; audits: AuditEntry[]; pending: PendingRandomization[] } | null>(STORAGE_KEY, null);
      if (data) this.$patch(data);
    },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
      this.persist();
    },

    /**
     * 入组：在线走中央登记（以回执为准），离线保留原入组内容进入待提交队列。
     * 中央不可达时同样转队列，保证断网不丢内容。
     */
    async enroll(input: RandomizeInput, offline: boolean): Promise<{ ok: boolean; message: string }> {
      if (this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}（本地已存在）`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }

      const clientKey = crypto.randomUUID();
      if (offline) {
        this.enqueue(input, clientKey, '离线提交，保留原入组内容');
        return { ok: true, message: '已按原内容加入待提交队列，联网后按原顺序重放' };
      }

      const registry = useRegistryStore();
      try {
        const result = await registry.register(input, clientKey);
        if (!result.ok) {
          const reason = result.reason === 'duplicate-participant' ? '受试者编号已在中央登记' : '身份核验标识已在中央登记';
          this.addAudit('duplicate-blocked', `中央登记处拒绝重复入组：${input.participantNo}（${reason}）`, input.actor, input.participantNo);
          return { ok: false, message: `${reason}，全场只能登记一次` };
        }
        this.applyReceipt(input, result.receipt, result.duplicated, input.actor);
        this.persist();
        return { ok: true, message: `中央回执确认入库，随机号 ${result.receipt.sequence}${result.duplicated ? '（幂等重放，沿用原随机号）' : ''}` };
      } catch (error) {
        const reason = error instanceof CentralError ? error.reason : 'network-error';
        this.enqueue(input, clientKey, `中央不可达（${reason}），原入组内容转入待提交队列`);
        return { ok: true, message: '中央登记暂不可达，已保留原入组内容进入待提交队列' };
      }
    },

    enqueue(input: RandomizeInput, clientKey: string, reason: string) {
      const queued: PendingRandomization = {
        id: crypto.randomUUID(),
        clientKey,
        payload: input,
        createdAt: new Date().toISOString(),
        status: 'pending',
        retryCount: 0
      };
      this.pending.push(queued);
      // 模拟恢复链路不稳定：该记录联网后首次重放超时，重试即成功
      useRegistryStore().markFlaky(clientKey);
      this.addAudit('pending-queued', `${reason}：${input.participantNo}`, input.actor, input.participantNo);
      this.persist();
    },

    /** 按中央回执落定分组；重复回执不新建记录、不改写已落定分组 */
    applyReceipt(input: RandomizeInput, receipt: CentralReceipt, duplicated: boolean, actor: string) {
      const existing = this.participants.find((item) => item.clientKey === receipt.key || item.receiptId === receipt.id);
      if (existing) {
        this.addAudit('receipt-duplicate', `重复回执未改写分组：${input.participantNo} 已入库，沿用原随机号 ${existing.sequence}`, actor, input.participantNo);
        return;
      }
      const participant: Participant = {
        id: crypto.randomUUID(),
        ...input,
        status: 'randomized',
        sequence: receipt.sequence,
        arm: receipt.arm,
        clientKey: receipt.key,
        receiptId: receipt.id,
        committedAt: new Date().toISOString()
      };
      this.participants.unshift(participant);
      this.addAudit('randomized', `${input.participantNo} 中央入库完成，随机号 ${receipt.sequence}，治疗组 ${receipt.arm}，回执 ${receipt.id}`, actor, input.participantNo);
    },

    /**
     * 确认入库（管理员并发确认同一队列时由中央幂等兜底）：
     * - 已入库：校验回执，重复/过期回执不改写分组；
     * - 未入库：以中央回执为准落定，失败则保留原因与重试次数。
     */
    async commitPending(id: string, actor: string): Promise<{ ok: boolean; message: string }> {
      const row = this.pending.find((item) => item.id === id);
      if (!row || row.status === 'committing') return { ok: false, message: '记录不存在或正在确认中' };
      const registry = useRegistryStore();

      if (row.status === 'committed') {
        const check = registry.verifyReceipt(row.receiptId);
        if (!check.ok) {
          this.addAudit('receipt-expired', `过期/无效回执不能改写已落定分组：${row.payload.participantNo}（${check.reason}）`, actor, row.payload.participantNo);
          this.persist();
          return { ok: false, message: '回执已过期或无效，分组未改写' };
        }
        this.addAudit('receipt-duplicate', `重复确认未生效：${row.payload.participantNo} 已入库，沿用原随机号 ${check.receipt.sequence}`, actor, row.payload.participantNo);
        return { ok: true, message: '该记录已入库，重复确认未改写分组' };
      }

      row.status = 'committing';
      this.persist();
      try {
        const result = await registry.register(row.payload, row.clientKey);
        if (!result.ok) {
          row.status = 'failed';
          row.retryCount += 1;
          row.lastError = result.reason;
          this.addAudit('pending-failed', `待提交记录中央拒绝：${row.payload.participantNo}（原因：${result.reason}，第 ${row.retryCount} 次尝试）`, actor, row.payload.participantNo);
          this.persist();
          return { ok: false, message: `中央拒绝：${result.reason}` };
        }
        this.applyReceipt(row.payload, result.receipt, result.duplicated, actor);
        row.status = 'committed';
        row.receiptId = result.receipt.id;
        row.committedAt = new Date().toISOString();
        row.lastError = undefined;
        if (!result.duplicated) {
          this.addAudit('pending-committed', `待提交记录按中央回执入库：${row.payload.participantNo}，随机号 ${result.receipt.sequence}，回执 ${result.receipt.id}`, actor, row.payload.participantNo);
        }
        this.persist();
        return { ok: true, message: `已入库，随机号 ${result.receipt.sequence}${result.duplicated ? '（幂等重放，沿用原随机号）' : ''}` };
      } catch (error) {
        row.status = 'failed';
        row.retryCount += 1;
        row.lastError = error instanceof CentralError ? error.reason : 'network-error';
        this.addAudit('pending-failed', `待提交记录重放失败：${row.payload.participantNo}（原因：${row.lastError}，第 ${row.retryCount} 次重试）`, actor, row.payload.participantNo);
        this.persist();
        return { ok: false, message: `重放失败（第 ${row.retryCount} 次）：${row.lastError}` };
      }
    },

    /** 联网恢复后按原提交顺序（FIFO）逐条重放 */
    async replayAll(actor: string): Promise<{ total: number; succeeded: number; failed: number }> {
      const rows = this.pending
        .filter((row) => row.status === 'pending' || row.status === 'failed')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      if (!rows.length) return { total: 0, succeeded: 0, failed: 0 };
      this.addAudit('replay-started', `联网恢复，按原提交顺序重放 ${rows.length} 条待提交记录`, actor);
      let succeeded = 0;
      let failed = 0;
      for (const row of rows) {
        const result = await this.commitPending(row.id, actor);
        if (result.ok) succeeded += 1;
        else failed += 1;
      }
      return { total: rows.length, succeeded, failed };
    },

    /** 紧急揭盲：必须填写原因，审计仅追加 */
    emergencyUnblind(id: string, reason: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !reason.trim()) return;
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲：${reason.trim()}；分配组别 ${participant.arm}`, actor, participant.participantNo);
    },

    /** 药品管理员维护发药信息（不可见/不改写治疗组） */
    updateDispensing(id: string, drugKitNo: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !drugKitNo.trim()) return;
      participant.drugKitNo = drugKitNo.trim();
      participant.dispensedAt = new Date().toISOString();
      participant.dispensedBy = actor;
      this.addAudit('dispensing-updated', `维护发药信息：${participant.participantNo}，药品编号 ${participant.drugKitNo}`, actor, participant.participantNo);
      this.persist();
    }
  }
});

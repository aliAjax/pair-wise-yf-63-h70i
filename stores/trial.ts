import { defineStore } from 'pinia';
import type { Arm, AuditEntry, Participant, PendingRandomization, RandomizeInput } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v1';
const seed: { participants: Participant[]; audits: AuditEntry[]; pending: PendingRandomization[] } = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A' },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B' }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层随机，中央随机号 1002', participantNo: 'S01-002' }
  ],
  pending: []
};

export const useTrialStore = defineStore('trial', {
  state: () => readLocal(STORAGE_KEY, seed),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length
  },
  actions: {
    persist() { writeLocal(STORAGE_KEY, { participants: this.participants, audits: this.audits, pending: this.pending }); },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
      this.persist();
    },
    randomize(input: RandomizeInput, offline = false): { ok: boolean; message: string; arm?: Arm } {
      if (this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      if (offline) {
        const queued: PendingRandomization = { id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线提交进入待处理队列：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: true, message: '已加入待提交队列，联网后确认入库' };
      }
      return this.commitRandomization(input);
    },
    commitRandomization(input: RandomizeInput): { ok: boolean; message: string; arm: Arm } {
      const sequence = 1000 + this.participants.length + 1;
      const sameStratum = this.participants.filter((item) => item.site === input.site && item.ageBand === input.ageBand);
      const arm: Arm = sameStratum.filter((item) => item.arm === 'A').length <= sameStratum.filter((item) => item.arm === 'B').length ? 'A' : 'B';
      const participant: Participant = { id: crypto.randomUUID(), ...input, status: 'randomized', sequence, arm };
      this.participants.unshift(participant);
      this.addAudit('randomized', `${input.participantNo} 完成分层随机，序列号 ${sequence}`, input.actor, input.participantNo);
      return { ok: true, message: `随机成功，中央序列号 ${sequence}`, arm };
    },
    commitPending(id: string, actor: string) {
      const pending = this.pending.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return;
      pending.status = 'committed';
      this.commitRandomization(pending.payload);
      this.addAudit('pending-committed', `待提交记录已确认入库：${pending.payload.participantNo}`, actor, pending.payload.participantNo);
      this.persist();
    },
    emergencyUnblind(id: string, reason: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !reason.trim()) return;
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲：${reason}；分配组别 ${participant.arm}`, actor, participant.participantNo);
    }
  }
});

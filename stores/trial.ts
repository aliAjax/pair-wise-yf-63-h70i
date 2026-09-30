import { defineStore } from 'pinia';
import type {
  Arm,
  AuditEntry,
  Participant,
  PendingRandomization,
  RandomizeInput,
  RegisterOutcome,
  TrialRole,
  VerifyOutcome
} from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';
import { useCentralRegistry } from '~/composables/useCentralRegistry';

const STORAGE_KEY = 'trial-randomization-v2';

const SEED_PARTICIPANTS: Participant[] = [
  {
    id: 'p-seed-1', requestId: 'req-seed-001', participantNo: 'S01-001', identityKey: 'demo-a',
    site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A',
    receiptId: '', registeredAt: new Date(Date.now() - 7200_000).toISOString()
  },
  {
    id: 'p-seed-2', requestId: 'req-seed-002', participantNo: 'S01-002', identityKey: 'demo-b',
    site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B',
    receiptId: '', registeredAt: new Date(Date.now() - 3600_000).toISOString()
  }
];

const seedAudit = (): AuditEntry[] => [
  {
    id: 'a-seed-1',
    at: new Date(Date.now() - 3600_000).toISOString(),
    actor: '系统',
    action: 'randomized',
    detail: 'S01-002 完成中央分层随机，中央随机号 1002（中央回执为准）',
    participantNo: 'S01-002'
  }
];

interface TrialState {
  participants: Participant[];
  audits: AuditEntry[];
  pending: PendingRandomization[];
  /** 队列原提交顺序游标，断网期间继续递增，恢复后按该序重放 */
  nextOrder: number;
  /** 正在向中央确认的 requestId，并发重复确认在入口直接收口 */
  confirming: string[];
  ready: boolean;
  centralOutage: boolean;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  receiptId?: string;
}

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export const useTrialStore = defineStore('trial', {
  state: (): TrialState => {
    const persisted = readLocal<Partial<TrialState>>(STORAGE_KEY, {});
    return {
      participants: persisted.participants ?? [],
      audits: persisted.audits ?? [],
      pending: persisted.pending ?? [],
      nextOrder: persisted.nextOrder ?? 0,
      confirming: [],
      ready: false,
      centralOutage: false
    };
  },

  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    /** 待提交 = 尚未落定（pending/failed）；已落定的 committed 项不再计入待办 */
    pendingCount: (state) => state.pending.filter((item) => item.status !== 'committed').length,
    /** 恢复后按原提交顺序展示：orderIndex 升序 */
    pendingOrdered: (state) => [...state.pending].sort((a, b) => a.orderIndex - b.orderIndex),
    isConfirming: (state) => (id: string) => state.confirming.includes(id)
  },

  actions: {
    persist() {
      // confirming 是瞬时并发锁，不落盘
      writeLocal(STORAGE_KEY, {
        participants: this.participants,
        audits: this.audits,
        pending: this.pending,
        nextOrder: this.nextOrder,
        confirming: [],
        ready: this.ready,
        centralOutage: this.centralOutage
      });
    },

    /** 审计只追加，任何地方都不提供删除或改写入口 */
    addAudit(entry: Omit<AuditEntry, 'id' | 'at'> & { at?: string }) {
      this.audits.unshift({ id: newId('a'), at: entry.at ?? new Date().toISOString(), ...entry });
      this.persist();
    },

    /**
     * 启动对账：中央账本是唯一事实来源。
     * - 首次启动把基线入组植入中央（沿用既有随机号）；
     * - 页面/队列/受试者列表全部由中央账本对账重建，共用同一份中央入库结果；
     * - 断网期间已落定但本地未标记的队列项，按中央结果补登，沿用原随机号。
     */
    async init() {
      if (this.ready) return;
      const registry = useCentralRegistry();
      registry.seed(
        SEED_PARTICIPANTS.map((p) => ({
          requestId: p.requestId,
          participantNo: p.participantNo,
          identityKey: p.identityKey,
          site: p.site,
          ageBand: p.ageBand,
          sequence: p.sequence,
          arm: (p.arm ?? 'A') as Arm,
          registeredAt: p.registeredAt
        }))
      );

      const registrations = registry.listRegistrations();
      const localByRequest = new Map(this.participants.map((p) => [p.requestId, p]));
      const reconciled: Participant[] = registrations.map((reg) => {
        const local = localByRequest.get(reg.requestId);
        const receipt = registry.getActiveReceipt(reg.requestId);
        if (local) {
          // 已入库记录沿用原随机号/治疗组，仅补齐中央回执引用
          return {
            ...local,
            sequence: reg.sequence,
            arm: reg.arm,
            receiptId: receipt?.receiptId ?? local.receiptId,
            registeredAt: reg.registeredAt
          };
        }
        const seed = SEED_PARTICIPANTS.find((p) => p.requestId === reg.requestId);
        return {
          id: seed?.id ?? newId('p'),
          requestId: reg.requestId,
          participantNo: reg.participantNo,
          identityKey: reg.identityKey,
          site: reg.site,
          ageBand: reg.ageBand,
          status: 'randomized',
          sequence: reg.sequence,
          arm: reg.arm,
          receiptId: receipt?.receiptId ?? '',
          registeredAt: reg.registeredAt
        };
      });

      // 队列对账：中央已存在登记的 pending/failed 项一律按中央结果补登
      for (const item of this.pending) {
        if (item.status === 'committed') continue;
        const reg = registry.getRegistration(item.id);
        if (reg) {
          const receipt = registry.getActiveReceipt(item.id) ?? item.receipt;
          this.adoptRegistration(reconciled, item, {
            receiptId: receipt?.receiptId ?? '',
            sequence: reg.sequence,
            arm: reg.arm,
            registeredAt: reg.registeredAt
          });
        }
      }

      this.participants = reconciled;
      if (this.audits.length === 0) this.audits = seedAudit();
      this.centralOutage = registry.isOutage();
      this.ready = true;
      this.persist();
    },

    /** 把中央入库结果落到本地：受试者 upsert（同一 requestId 只有一行）、队列标记 committed */
    adoptRegistration(
      list: Participant[],
      item: PendingRandomization,
      result: { receiptId: string; sequence: number; arm: Arm; registeredAt: string }
    ) {
      const existing = list.find((p) => p.requestId === item.id);
      if (existing) {
        existing.sequence = result.sequence;
        existing.arm = result.arm;
        existing.receiptId = result.receiptId;
        existing.registeredAt = result.registeredAt;
      } else {
        list.unshift({
          id: newId('p'),
          requestId: item.id,
          participantNo: item.payload.participantNo,
          identityKey: item.payload.identityKey,
          site: item.payload.site,
          ageBand: item.payload.ageBand,
          status: 'randomized',
          sequence: result.sequence,
          arm: result.arm,
          receiptId: result.receiptId,
          registeredAt: result.registeredAt
        });
      }
      item.status = 'committed';
      item.receipt = item.receipt?.receiptId === result.receiptId
        ? item.receipt
        : {
            receiptId: result.receiptId,
            requestId: item.id,
            participantNo: item.payload.participantNo,
            sequence: result.sequence,
            arm: result.arm,
            issuedAt: result.registeredAt,
            expiresAt: result.registeredAt
          };
      item.failureReason = undefined;
    },

    /** 入组：全场唯一预检 + 中央登记；断网保留原入组内容进入待提交队列 */
    async randomize(input: RandomizeInput, offline = false): Promise<ActionResult> {
      const participantTaken = this.participants.some((p) => p.participantNo === input.participantNo);
      const identityTaken = this.participants.some((p) => p.identityKey === input.identityKey);
      const participantQueued = this.pending.some(
        (q) => q.status !== 'committed' && q.payload.participantNo === input.participantNo
      );
      const identityQueued = this.pending.some(
        (q) => q.status !== 'committed' && q.payload.identityKey === input.identityKey
      );
      if (participantTaken || participantQueued) {
        this.addAudit({ action: 'duplicate-blocked', actor: input.actor, participantNo: input.participantNo, detail: `拒绝重复入组：受试者编号 ${input.participantNo} 已登记或在待提交队列中` });
        return { ok: false, message: '受试者编号全场只能登记一次，已阻止重复入组' };
      }
      if (identityTaken || identityQueued) {
        this.addAudit({ action: 'duplicate-blocked', actor: input.actor, participantNo: input.participantNo, detail: `拒绝重复入组：身份核验标识已用于受试者 ${input.participantNo}` });
        return { ok: false, message: '身份核验标识全场只能登记一次，已阻止重复入组' };
      }

      const requestId = newId('req');
      if (offline) {
        this.enqueue(requestId, input, '离线模式保留原入组内容，等待联网后按原序重放');
        return { ok: true, message: '断网已保留原入组内容，恢复后将按原提交顺序重放' };
      }

      const registry = useCentralRegistry();
      if (registry.isOutage()) {
        this.enqueue(requestId, input, '中央登记服务不可达，入组内容原样进入待提交队列');
        this.addAudit({ action: 'central-unavailable', actor: input.actor, participantNo: input.participantNo, detail: '中央登记不可达，入组内容原样进入待提交队列，未本地发号' });
        return { ok: true, message: '中央不可达，已保留入组内容至待提交队列，未本地发号' };
      }

      const outcome = await registry.register({
        requestId,
        participantNo: input.participantNo,
        identityKey: input.identityKey,
        site: input.site,
        ageBand: input.ageBand,
        queuedAt: new Date().toISOString()
      });
      return this.applyRegisterOutcome(requestId, input, outcome, '在线入组');
    },

    enqueue(requestId: string, input: RandomizeInput, detail: string) {
      const item: PendingRandomization = {
        id: requestId,
        payload: input,
        createdAt: new Date().toISOString(),
        status: 'pending',
        orderIndex: this.nextOrder,
        retries: 0
      };
      this.nextOrder += 1;
      this.pending.push(item);
      this.addAudit({ action: 'pending-queued', actor: input.actor, participantNo: input.participantNo, detail });
      this.persist();
    },

    applyRegisterOutcome(
      requestId: string,
      input: RandomizeInput,
      outcome: RegisterOutcome,
      source: '在线入组' | '队列确认'
    ): ActionResult {
      if (outcome.outcome === 'unavailable') {
        // 在线登记期间中央故障：同样保留原内容待重放，绝不本地补发号
        if (!this.pending.some((q) => q.id === requestId)) this.enqueue(requestId, input, '确认时中央不可达，原入组内容保留待重放');
        return { ok: true, message: '中央不可达，已转入待提交队列保留，恢复后按原序重放' };
      }
      if (outcome.outcome === 'duplicate-conflict') {
        this.addAudit({
          action: 'duplicate-blocked',
          actor: input.actor,
          participantNo: input.participantNo,
          detail: `中央拒绝入库：${outcome.conflictField === 'participantNo' ? '受试者编号' : '身份核验标识'}已被请求 ${outcome.ownerRequestId} 登记`
        });
        const queued = this.pending.find((q) => q.id === requestId);
        if (queued) {
          queued.status = 'failed';
          queued.failureReason = `中央拒绝：${outcome.conflictField === 'participantNo' ? '受试者编号' : '身份核验标识'}已被其他入组请求登记`;
          this.persist();
        }
        return { ok: false, message: '中央拒绝：编号或身份标识已被另一次入组登记' };
      }

      // registered / duplicate-request 都以中央回执为准；重复确认拿到同一份入库结果
      const queued = this.pending.find((q) => q.id === requestId);
      if (queued) {
        this.adoptRegistration(this.participants, queued, {
          receiptId: outcome.receipt.receiptId,
          sequence: outcome.receipt.sequence,
          arm: outcome.receipt.arm,
          registeredAt: outcome.receipt.issuedAt
        });
        this.addAudit({
          action: 'pending-committed',
          actor: input.actor,
          participantNo: input.participantNo,
          receiptId: outcome.receipt.receiptId,
          retries: queued.retries,
          detail: `${source}凭中央回执入库：${input.participantNo}，中央随机号 ${outcome.receipt.sequence}，治疗组 ${outcome.receipt.arm}（回执 ${outcome.receipt.receiptId}）`
        });
        this.persist();
      } else if (!this.participants.some((p) => p.requestId === requestId)) {
        this.participants.unshift({
          id: newId('p'),
          requestId,
          participantNo: input.participantNo,
          identityKey: input.identityKey,
          site: input.site,
          ageBand: input.ageBand,
          status: 'randomized',
          sequence: outcome.receipt.sequence,
          arm: outcome.receipt.arm,
          receiptId: outcome.receipt.receiptId,
          registeredAt: outcome.receipt.issuedAt
        });
        this.addAudit({
          action: 'randomized',
          actor: input.actor,
          participantNo: input.participantNo,
          receiptId: outcome.receipt.receiptId,
          detail: `${input.participantNo} 完成中央分层随机，中央随机号 ${outcome.receipt.sequence}（回执 ${outcome.receipt.receiptId}）`
        });
        this.persist();
      }
      return {
        ok: true,
        receiptId: outcome.receipt.receiptId,
        message: outcome.duplicate
          ? `该入组已由中央登记，沿用首次入库随机号 ${outcome.receipt.sequence}`
          : `中央登记成功，中央随机号 ${outcome.receipt.sequence}`
      };
    },

    /**
     * 确认待提交队列（幂等、可恢复）：
     * - 同一队列项的并发确认在入口锁收口，只有一次真正请求中央；
     * - 已有回执先核验：有效回执确认，过期/失效回执不允许凭旧回执改写；
     * - 中央不可达/冲突都保留失败原因与重试次数，原入组内容不变。
     */
    async confirmPending(id: string, actor: string): Promise<ActionResult> {
      const item = this.pending.find((q) => q.id === id);
      if (!item) return { ok: false, message: '队列记录不存在' };
      if (item.status === 'committed') {
        return this.reconfirmCommitted(id, actor);
      }
      if (this.confirming.includes(id)) {
        return { ok: false, message: '该入组正在由另一名管理员确认中，中央回执将以先到者为准' };
      }

      this.confirming.push(id);
      try {
        const registry = useCentralRegistry();
        item.retries += 1;
        item.lastAttemptAt = new Date().toISOString();

        if (item.receipt) {
          const verify = await registry.verifyReceipt(item.receipt.receiptId);
          if (verify.outcome === 'expired') {
            item.status = 'failed';
            item.failureReason = `中央回执已过期（${verify.receipt.expiresAt}），需刷新回执后再确认，已落定分组不变`;
            this.addAudit({ action: 'receipt-expired', actor, participantNo: item.payload.participantNo, receiptId: verify.receipt.receiptId, retries: item.retries, detail: item.failureReason });
            this.persist();
            return { ok: false, message: '中央回执已过期，已落定分组不被改写，请刷新回执后重试' };
          }
          if (verify.outcome === 'unknown') {
            item.status = 'failed';
            item.failureReason = '回执号在中央无法核验（未知回执），拒绝凭旧回执确认';
            this.addAudit({ action: 'receipt-unknown', actor, participantNo: item.payload.participantNo, retries: item.retries, detail: item.failureReason });
            this.persist();
            return { ok: false, message: '中央回执无法核验，拒绝确认' };
          }
          // 有效回执：仍以中央登记为幂等收口（重复确认返回同一份入库结果），不本地重发号
          return await this.doRegister(item, actor, '队列确认');
        }

        return await this.doRegister(item, actor, '队列确认');
      } finally {
        this.confirming = this.confirming.filter((x) => x !== id);
        this.persist();
      }
    },

    async doRegister(
      item: PendingRandomization,
      actor: string,
      source: '在线入组' | '队列确认'
    ): Promise<ActionResult> {
      const registry = useCentralRegistry();
      const outcome = await registry.register({
        requestId: item.id,
        participantNo: item.payload.participantNo,
        identityKey: item.payload.identityKey,
        site: item.payload.site,
        ageBand: item.payload.ageBand,
        queuedAt: item.createdAt
      });

      if (outcome.outcome === 'unavailable') {
        item.status = 'failed';
        item.failureReason = outcome.reason;
        this.addAudit({ action: 'pending-failed', actor, participantNo: item.payload.participantNo, retries: item.retries, detail: `第 ${item.retries} 次确认失败：${outcome.reason}，原入组内容保留待重放` });
        this.persist();
        return { ok: false, message: `确认失败（第 ${item.retries} 次）：${outcome.reason}` };
      }

      if (outcome.outcome === 'duplicate-conflict') {
        item.status = 'failed';
        item.failureReason = `中央拒绝：${outcome.conflictField === 'participantNo' ? '受试者编号' : '身份核验标识'}已被请求 ${outcome.ownerRequestId} 登记`;
        this.addAudit({ action: 'confirm-conflict', actor, participantNo: item.payload.participantNo, retries: item.retries, detail: item.failureReason });
        this.persist();
        return { ok: false, message: '中央拒绝：编号或身份标识已被另一次入组登记' };
      }

      item.receipt = outcome.receipt;
      const input: RandomizeInput = { ...item.payload, actor };
      const result = this.applyRegisterOutcome(item.id, input, outcome, source);
      return result;
    },

    /** 已落定队列项的重复确认：只回查中央回执，不重新发号、不改治疗组 */
    async reconfirmCommitted(id: string, actor: string): Promise<ActionResult> {
      const item = this.pending.find((q) => q.id === id);
      if (!item || item.status !== 'committed') return { ok: false, message: '记录尚未入库' };
      const registry = useCentralRegistry();
      if (!item.receipt) return { ok: false, message: '缺少中央回执，请以受试者列表中的回执为准' };
      const verify: VerifyOutcome = await registry.verifyReceipt(item.receipt.receiptId);
      if (verify.outcome === 'unknown') {
        this.addAudit({ action: 'receipt-unknown', actor, participantNo: item.payload.participantNo, receiptId: item.receipt.receiptId, detail: '重复确认时回执无法在中央核验，已拒绝，未改动已落定分组' });
        return { ok: false, message: '回执无法核验，已落定分组保持不变' };
      }
      if (verify.outcome === 'expired') {
        this.addAudit({ action: 'receipt-expired', actor, participantNo: item.payload.participantNo, receiptId: verify.receipt.receiptId, detail: '重复确认使用了过期回执，已拒绝改写；中央登记的随机号/治疗组不变，可刷新回执' });
        return { ok: false, message: '回执已过期，已落定分组不被改写' };
      }
      this.addAudit({ action: 'receipt-confirmed', actor, participantNo: item.payload.participantNo, receiptId: verify.receipt.receiptId, detail: `重复确认经中央回执核验一致：${item.payload.participantNo} 沿用随机号 ${verify.registration.sequence}、治疗组 ${verify.registration.arm}` });
      return { ok: true, receiptId: verify.receipt.receiptId, message: `中央回执核验一致，沿用原随机号 ${verify.registration.sequence}` };
    },

    /** 刷新过期回执：登记与分组不动，只换发新回执 */
    async refreshReceipt(id: string, actor: string): Promise<ActionResult> {
      const item = this.pending.find((q) => q.id === id);
      if (!item) return { ok: false, message: '队列记录不存在' };
      const registry = useCentralRegistry();
      const receipt = await registry.refreshReceipt(id);
      if (!receipt) return { ok: false, message: '中央尚无该入组的登记，无法刷新回执' };
      item.receipt = receipt;
      const participant = this.participants.find((p) => p.requestId === id);
      if (participant) participant.receiptId = receipt.receiptId;
      this.addAudit({ action: 'receipt-confirmed', actor, participantNo: item.payload.participantNo, receiptId: receipt.receiptId, detail: '已刷新中央回执，随机号与治疗组沿用原中央入库结果' });
      this.persist();
      return { ok: true, receiptId: receipt.receiptId, message: '已刷新中央回执，可再次确认' };
    },

    /** 断网恢复：按原提交顺序（orderIndex 升序）重放全部未落定记录；遇中央不可达即暂停保序 */
    async replayPending(actor: string): Promise<{ committed: number; failed: number; paused: boolean }> {
      const queue = this.pending
        .filter((q) => q.status !== 'committed')
        .sort((a, b) => a.orderIndex - b.orderIndex);
      if (queue.length === 0) return { committed: 0, failed: 0, paused: false };

      this.addAudit({ action: 'replay-started', actor, detail: `联网恢复，按原提交顺序重放 ${queue.length} 条待提交记录` });
      let committed = 0;
      let failed = 0;
      for (const item of queue) {
        // 顺序重放：前一条未确认成功就暂停，避免打乱原提交顺序
        if (useCentralRegistry().isOutage()) {
          this.addAudit({ action: 'replay-paused', actor, participantNo: item.payload.participantNo, detail: `重放至 ${item.payload.participantNo} 时中央仍不可达，保留失败原因与重试次数，等待下次恢复` });
          return { committed, failed, paused: true };
        }
        const result = await this.confirmPending(item.id, actor);
        if (result.ok) committed += 1;
        else {
          failed += 1;
          if (item.failureReason?.includes('不可达')) {
            this.addAudit({ action: 'replay-paused', actor, participantNo: item.payload.participantNo, detail: '重放因中央不可达暂停，后续记录按原序保留' });
            return { committed, failed, paused: true };
          }
        }
      }
      return { committed, failed, paused: false };
    },

    /** 模拟中央中断/恢复开关（仅原型演示用）；恢复时自动按原序重放 */
    async setCentralOutage(value: boolean, actor: string) {
      const registry = useCentralRegistry();
      const previous = registry.isOutage();
      registry.setOutage(value);
      this.centralOutage = value;
      this.persist();
      if (previous === value) return;
      if (value) {
        this.addAudit({ action: 'central-unavailable', actor, detail: '中央登记服务中断模拟开启：在线入组将保留入组内容，不本地发号' });
      } else {
        this.addAudit({ action: 'central-restored', actor, detail: '中央登记服务恢复，开始按原提交顺序重放' });
        await this.replayPending(actor);
      }
    },

    /** 发药信息维护：仅药品管理员；只改发药字段，不触碰随机号/治疗组 */
    updateDispensing(requestId: string, info: { kitNo: string; lotNo: string }, actor: string, role: TrialRole): ActionResult {
      if (role !== 'pharmacist') {
        this.addAudit({ action: 'forbidden', actor, detail: '非药品管理员尝试维护发药信息，已拒绝' });
        return { ok: false, message: '仅药品管理员可维护发药信息' };
      }
      const participant = this.participants.find((p) => p.requestId === requestId);
      if (!participant) return { ok: false, message: '受试者不存在或尚未入库' };
      if (!info.kitNo.trim() || !info.lotNo.trim()) return { ok: false, message: '药盒号与批号不能为空' };
      participant.dispensing = {
        kitNo: info.kitNo.trim(),
        lotNo: info.lotNo.trim(),
        dispensedAt: new Date().toISOString(),
        by: actor
      };
      this.addAudit({ action: 'dispensing-updated', actor, participantNo: participant.participantNo, detail: `发药信息维护：药盒号 ${participant.dispensing.kitNo}，批号 ${participant.dispensing.lotNo}` });
      this.persist();
      return { ok: true, message: '发药信息已保存' };
    },

    /** 紧急揭盲：仅研究者，必须填写原因，审计只追加 */
    emergencyUnblind(id: string, reason: string, actor: string, role: TrialRole): ActionResult {
      if (role !== 'investigator') {
        this.addAudit({ action: 'forbidden', actor, detail: '非研究者尝试紧急揭盲，已拒绝' });
        return { ok: false, message: '仅研究者可执行紧急揭盲' };
      }
      const participant = this.participants.find((p) => p.id === id);
      if (!participant || !reason.trim()) return { ok: false, message: '揭盲原因不能为空' };
      if (participant.status === 'unblinded') return { ok: false, message: '该受试者已揭盲，记录不可改写' };
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      participant.unblindReason = reason.trim();
      this.addAudit({ action: 'unblinded', actor, participantNo: participant.participantNo, receiptId: participant.receiptId, detail: `紧急揭盲，原因：${reason.trim()}；中央治疗组 ${participant.arm}（随机号 ${participant.sequence}）` });
      this.persist();
      return { ok: true, message: '已揭盲，审计记录已追加' };
    }
  }
});

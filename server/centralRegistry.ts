import type {
  Arm,
  CentralEnrollmentRequest,
  CentralReceipt,
  CentralRegistration,
  RegisterOutcome,
  VerifyOutcome
} from '../types/trial';

/** 回执有效期：确认必须在回执有效期内凭回执落账，过期回执不能改写已落定分组 */
export const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
export const SEQUENCE_START = 1000;

export interface RegistryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** 可选：跨标签页互斥锁（浏览器 Web Locks API） */
  navigatorLock?<T>(name: string, opts: { mode: 'exclusive' | 'shared' }, callback: () => T | Promise<T>): Promise<T>;
}

interface Ledger {
  /** 中央已落定登记，按 requestId 索引，写入即最终结果，不允许改写 */
  registrations: Record<string, CentralRegistration>;
  /** 全场唯一约束：受试者编号 / 身份核验标识 -> requestId，各只能登记一次 */
  participantNoIndex: Record<string, string>;
  identityKeyIndex: Record<string, string>;
  /** 已签发的全部回执，凭回执号可回查同一次中央入库结果 */
  receipts: Record<string, CentralReceipt>;
  /** 每个 requestId 当前生效的回执号（刷新回执后旧回执作废但不删审计线索） */
  activeReceiptByRequest: Record<string, string>;
  nextSequence: number;
  initialized: boolean;
}

const emptyLedger = (): Ledger => ({
  registrations: {},
  participantNoIndex: {},
  identityKeyIndex: {},
  receipts: {},
  activeReceiptByRequest: {},
  nextSequence: SEQUENCE_START,
  initialized: false
});

/**
 * 中央随机登记账本。
 *
 * 所有随机号与治疗组只在这里产生：
 * - 同一 requestId 反复确认是幂等的，永远返回第一次入库的同一份回执；
 * - 受试者编号 / 身份核验标识在全场只能登记一次，冲突由中央拒绝；
 * - 已落定登记（随机号、治疗组）不接受任何改写；
 * - 写入串行化，多个管理员并发确认同一入组只有一次真正入库。
 */
export class CentralRegistry {
  private ledger: Ledger;
  private chain: Promise<unknown> = Promise.resolve();
  /** 模拟中央服务中断（断网恢复前中央不可达）；读路径始终可用，登记写路径返回 unavailable */
  outage = false;

  constructor(
    private readonly storage: RegistryStorage,
    private readonly storageKey = 'central-registry-v1',
    private readonly clock: () => Date = () => new Date()
  ) {
    this.ledger = this.load();
  }

  private load(): Ledger {
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) return emptyLedger();
    try {
      return { ...emptyLedger(), ...(JSON.parse(raw) as Ledger) };
    } catch {
      return emptyLedger();
    }
  }

  private save() {
    this.storage.setItem(this.storageKey, JSON.stringify(this.ledger));
  }

  /** 账本首次使用时植入基线登记（基线数据同样来自中央，沿用既有随机号） */
  seed(entries: Array<Omit<CentralRegistration, 'registeredAt'> & { registeredAt?: string }>): void {
    if (this.ledger.initialized) return;
    for (const entry of entries) {
      const registration: CentralRegistration = {
        requestId: entry.requestId,
        participantNo: entry.participantNo,
        identityKey: entry.identityKey,
        site: entry.site,
        ageBand: entry.ageBand,
        sequence: entry.sequence,
        arm: entry.arm,
        registeredAt: entry.registeredAt ?? this.clock().toISOString()
      };
      this.ledger.registrations[registration.requestId] = registration;
      this.ledger.participantNoIndex[registration.participantNo] = registration.requestId;
      this.ledger.identityKeyIndex[registration.identityKey] = registration.requestId;
      this.ledger.nextSequence = Math.max(this.ledger.nextSequence, registration.sequence);
      this.issueReceipt(registration);
    }
    this.ledger.initialized = true;
    this.save();
  }

  isOutage(): boolean {
    return this.outage;
  }

  setOutage(value: boolean): void {
    this.outage = value;
  }

  getRegistration(requestId: string): CentralRegistration | undefined {
    return this.ledger.registrations[requestId];
  }

  /** 读路径：取某条登记当前生效的回执（启动对账/补登用），不产生新回执 */
  getActiveReceipt(requestId: string): CentralReceipt | undefined {
    const receiptId = this.ledger.activeReceiptByRequest[requestId];
    return receiptId ? this.ledger.receipts[receiptId] : undefined;
  }

  listRegistrations(): CentralRegistration[] {
    return Object.values(this.ledger.registrations).sort((a, b) => a.sequence - b.sequence);
  }

  /** 读路径：按全场唯一约束查占用，离线入组前用它做本地预检 */
  findOwner(field: 'participantNo' | 'identityKey', value: string): string | undefined {
    return field === 'participantNo'
      ? this.ledger.participantNoIndex[value]
      : this.ledger.identityKeyIndex[value];
  }

  private issueReceipt(registration: CentralRegistration): CentralReceipt {
    const now = this.clock().getTime();
    const receipt: CentralReceipt = {
      receiptId: `rcpt-${cryptoRandom()}`,
      requestId: registration.requestId,
      participantNo: registration.participantNo,
      sequence: registration.sequence,
      arm: registration.arm,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + RECEIPT_TTL_MS).toISOString()
    };
    this.ledger.receipts[receipt.receiptId] = receipt;
    this.ledger.activeReceiptByRequest[registration.requestId] = receipt.receiptId;
    return receipt;
  }

  /**
   * 中央登记（幂等）。
   * 并发同一 requestId 只会真正入库一次；重复确认拿到的是首次入库的同一份回执。
   */
  register(request: CentralEnrollmentRequest): Promise<RegisterOutcome> {
    return this.withLock(() => {
      if (this.outage) {
        return { outcome: 'unavailable', reason: '中央登记服务不可达' } as RegisterOutcome;
      }

      const existing = this.ledger.registrations[request.requestId];
      if (existing) {
        // 重复确认：不重新发号、不改治疗组，只补发与既有入库一致的回执
        const receiptId = this.ledger.activeReceiptByRequest[request.requestId];
        const receipt = this.ledger.receipts[receiptId] ?? this.issueReceipt(existing);
        this.save();
        return { outcome: 'duplicate-request', receipt, duplicate: true } as RegisterOutcome;
      }

      const ownerByNo = this.ledger.participantNoIndex[request.participantNo];
      if (ownerByNo && ownerByNo !== request.requestId) {
        return { outcome: 'duplicate-conflict', conflictField: 'participantNo', ownerRequestId: ownerByNo } as RegisterOutcome;
      }
      const ownerByIdentity = this.ledger.identityKeyIndex[request.identityKey];
      if (ownerByIdentity && ownerByIdentity !== request.requestId) {
        return { outcome: 'duplicate-conflict', conflictField: 'identityKey', ownerRequestId: ownerByIdentity } as RegisterOutcome;
      }

      const registration = this.allocate(request);
      this.ledger.registrations[request.requestId] = registration;
      this.ledger.participantNoIndex[registration.participantNo] = registration.requestId;
      this.ledger.identityKeyIndex[registration.identityKey] = registration.requestId;
      const receipt = this.issueReceipt(registration);
      this.save();
      return { outcome: 'registered', receipt, duplicate: false } as RegisterOutcome;
    });
  }

  /** 分层区组随机：随机号中央单调递增，治疗组按（中心 × 年龄分层）平衡分配，结果只产生一次 */
  private allocate(request: CentralEnrollmentRequest): CentralRegistration {
    this.ledger.nextSequence += 1;
    const stratum = Object.values(this.ledger.registrations).filter(
      (item) => item.site === request.site && item.ageBand === request.ageBand
    );
    const countA = stratum.filter((item) => item.arm === 'A').length;
    const countB = stratum.filter((item) => item.arm === 'B').length;
    const arm: Arm = countA <= countB ? 'A' : 'B';
    return {
      requestId: request.requestId,
      participantNo: request.participantNo,
      identityKey: request.identityKey,
      site: request.site,
      ageBand: request.ageBand,
      sequence: this.ledger.nextSequence,
      arm,
      registeredAt: this.clock().toISOString()
    };
  }

  /**
   * 凭中央回执核验。落定分组永远以账本为准：
   * - valid：回执与账本一致，可据此确认；
   * - expired：回执过期，但账本里的分组不变，必须刷新回执后再确认；
   * - unknown：回执号不存在（伪造或来自其他库），拒绝且不改动任何分组。
   */
  verifyReceipt(receiptId: string): Promise<VerifyOutcome> {
    return this.withLock(() => {
      const receipt = this.ledger.receipts[receiptId];
      if (!receipt) return { outcome: 'unknown', receiptId } as VerifyOutcome;
      const registration = this.ledger.registrations[receipt.requestId];
      if (!registration) return { outcome: 'unknown', receiptId } as VerifyOutcome;
      if (this.clock().getTime() > new Date(receipt.expiresAt).getTime()) {
        return { outcome: 'expired', receipt, registration } as VerifyOutcome;
      }
      return { outcome: 'valid', receipt, registration } as VerifyOutcome;
    }, false);
  }

  /** 刷新过期回执：登记内容与随机号保持原样，只签发新的有效期 */
  refreshReceipt(requestId: string): Promise<CentralReceipt | undefined> {
    return this.withLock(() => {
      const registration = this.ledger.registrations[requestId];
      if (!registration) return undefined;
      const receipt = this.issueReceipt(registration);
      this.save();
      return receipt;
    });
  }

  /** 测试/运维用：把某条登记的生效回执改成已过期，用于演示过期回执不得改写分组 */
  async expireActiveReceipt(requestId: string): Promise<boolean> {
    return this.withLock(() => {
      const receiptId = this.ledger.activeReceiptByRequest[requestId];
      const receipt = receiptId ? this.ledger.receipts[receiptId] : undefined;
      if (!receipt) return false;
      const now = this.clock().getTime();
      receipt.issuedAt = new Date(now - 2 * RECEIPT_TTL_MS).toISOString();
      receipt.expiresAt = new Date(now - RECEIPT_TTL_MS).toISOString();
      this.save();
      return true;
    });
  }

  private serialize<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(() => task());
    // 串行链不因单次失败而中断
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * 串行 + 跨标签页互斥地执行一次账本访问。
   * 多个管理员（多标签页/多窗口）并发确认时，写操作排队进入同一把中央锁，
   * 且进入临界区前重新读盘，保证“同一入组只真正入库一次”。
   */
  private withLock<T>(task: () => T | Promise<T>, mutating = true): Promise<T> {
    return this.serialize(async () => {
      const runLocked = (): T | Promise<T> => {
        // 临界区前重新加载，拿到其他标签页已提交的最新账本
        if (mutating) this.ledger = this.load();
        return task();
      };
      if (typeof this.storage.navigatorLock === 'function') {
        return await this.storage.navigatorLock(`lock:${this.storageKey}`, { mode: mutating ? 'exclusive' : 'shared' }, runLocked);
      }
      return await runLocked();
    });
  }
}

function cryptoRandom(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

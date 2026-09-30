export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AuditAction =
  | 'randomized'
  | 'unblinded'
  | 'pending-queued'
  | 'pending-committed'
  | 'pending-failed'
  | 'duplicate-blocked'
  | 'central-unavailable'
  | 'central-restored'
  | 'replay-started'
  | 'replay-paused'
  | 'receipt-expired'
  | 'receipt-unknown'
  | 'receipt-confirmed'
  | 'confirm-conflict'
  | 'dispensing-updated'
  | 'forbidden';

export type PendingStatus = 'pending' | 'failed' | 'committed';

export interface DispensingInfo {
  kitNo: string;
  lotNo: string;
  dispensedAt: string;
  by: string;
}

export interface Participant {
  id: string;
  /** 中央登记请求幂等键，也是受试者在全场的唯一入库键 */
  requestId: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: '18-44' | '45-64' | '65+';
  status: 'randomized' | 'unblinded';
  /** 中央随机号，由中央账本发号，本地任何重放/重复确认都不得改写 */
  sequence: number;
  arm?: Arm;
  /** 中央回执号，页面、队列、审计共用同一次中央入库结果的凭据 */
  receiptId: string;
  registeredAt: string;
  unblindedAt?: string;
  unblindReason?: string;
  /** 发药信息：仅药品管理员可维护 */
  dispensing?: DispensingInfo;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
  receiptId?: string;
  retries?: number;
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: Participant['ageBand'];
  actor: string;
}

export interface PendingRandomization {
  /** 等于中央登记的幂等 requestId，入组时生成，断网期间保持不变 */
  id: string;
  /** 原入组内容：断网期间原样保留，不重新编号、不重新分层 */
  payload: RandomizeInput;
  createdAt: string;
  status: PendingStatus;
  /** 原提交顺序，恢复后按该顺序升序重放 */
  orderIndex: number;
  /** 已尝试的确认次数 */
  retries: number;
  lastAttemptAt?: string;
  /** 最近一次失败原因（中央不可用、身份冲突等） */
  failureReason?: string;
  /** 已拿到的中央回执；一旦存在，后续确认只能凭回执核验，不允许二次发号 */
  receipt?: CentralReceipt;
}

/** 中央登记请求 */
export interface CentralEnrollmentRequest {
  requestId: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: Participant['ageBand'];
  queuedAt: string;
}

/** 中央账本中已落定的登记记录 */
export interface CentralRegistration {
  requestId: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: Participant['ageBand'];
  sequence: number;
  arm: Arm;
  registeredAt: string;
}

/** 中央回执：确认以中央回执为准 */
export interface CentralReceipt {
  receiptId: string;
  requestId: string;
  participantNo: string;
  sequence: number;
  arm: Arm;
  issuedAt: string;
  expiresAt: string;
}

export type RegisterOutcome =
  | { outcome: 'registered'; receipt: CentralReceipt; duplicate: false }
  | { outcome: 'duplicate-request'; receipt: CentralReceipt; duplicate: true }
  | { outcome: 'duplicate-conflict'; conflictField: 'participantNo' | 'identityKey'; ownerRequestId: string }
  | { outcome: 'unavailable'; reason: string };

export type VerifyOutcome =
  | { outcome: 'valid'; receipt: CentralReceipt; registration: CentralRegistration }
  | { outcome: 'expired'; receipt: CentralReceipt; registration: CentralRegistration }
  | { outcome: 'unknown'; receiptId: string };

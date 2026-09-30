export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AgeBand = '18-44' | '45-64' | '65+';
export type AuditAction =
  | 'randomized'
  | 'unblinded'
  | 'pending-queued'
  | 'pending-committed'
  | 'duplicate-blocked'
  | 'pending-failed'
  | 'receipt-duplicate'
  | 'receipt-expired'
  | 'dispensing-updated'
  | 'replay-started';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  status: 'randomized' | 'unblinded';
  sequence: number;
  arm?: Arm;
  /** 客户端提交时生成的幂等键，中央登记处凭此去重 */
  clientKey?: string;
  /** 中央回执号：页面、队列、审计共用同一次入库结果 */
  receiptId?: string;
  committedAt?: string;
  unblindedAt?: string;
  /** 发药信息（药品管理员维护） */
  drugKitNo?: string;
  dispensedAt?: string;
  dispensedBy?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
}

export type PendingStatus = 'pending' | 'committing' | 'committed' | 'failed';

export interface PendingRandomization {
  id: string;
  /** 客户端幂等键：断网重放时保持不变，中央凭此返回同一份回执 */
  clientKey: string;
  /** 原始入组内容，断网期间原样保留，不允许改写 */
  payload: RandomizeInput;
  createdAt: string;
  status: PendingStatus;
  retryCount: number;
  lastError?: string;
  receiptId?: string;
  committedAt?: string;
}

/** 中央登记台账：受试者编号与身份核验标识全场只能登记一次 */
export interface LedgerEntry {
  clientKey: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  sequence: number;
  arm: Arm;
  receiptId: string;
  committedAt: string;
}

/** 中央回执：确认以回执为准，重复/过期回执不能改写已落定分组 */
export interface CentralReceipt {
  id: string;
  key: string;
  sequence: number;
  arm: Arm;
  issuedAt: string;
  expiresAt: string;
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: AgeBand;
  actor: string;
}

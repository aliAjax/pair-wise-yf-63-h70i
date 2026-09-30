export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AuditAction = 'randomized' | 'unblinded' | 'pending-queued' | 'pending-committed' | 'duplicate-blocked';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: '18-44' | '45-64' | '65+';
  status: 'randomized' | 'unblinded';
  sequence: number;
  arm?: Arm;
  unblindedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
}

export interface PendingRandomization {
  id: string;
  payload: RandomizeInput;
  createdAt: string;
  status: 'pending' | 'committed';
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: Participant['ageBand'];
  actor: string;
}

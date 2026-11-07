import type { AwsCredentialIdentityProvider } from '@smithy/types';

export type SsmStatus = 'Online' | 'ConnectionLost' | 'Inactive' | 'None' | 'unknown';

export interface InstanceRow {
  instanceId: string;
  name: string | null;
  state: string;
  ssm: SsmStatus;
  instanceType: string | null;
  privateIp: string | null;
  publicIp: string | null;
  platform: string | null;
  connectable: boolean;
  reason: string | null;
}

export interface AwsContext {
  profile: string;
  region: string;
  credentials: AwsCredentialIdentityProvider;
}

export interface StartSessionInput {
  Target: string;
  DocumentName?: string;
  Parameters?: Record<string, string[]>;
}

export interface SessionStart {
  SessionId: string;
  StreamUrl: string;
  TokenValue: string;
}

/** The only part of an SDK client we call; tests substitute a fake. */
// biome-ignore lint/suspicious/noExplicitAny: SDK command/output types vary per client
export type Sender = { send(command: any): Promise<any> };

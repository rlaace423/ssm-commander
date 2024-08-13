export enum OsType {
  Darwin = 'Darwin',
  Linux = 'Linux',
  Windows = 'Windows_NT',
}

export interface Profile {
  Version: number;
  AccessKeyId: string;
  SecretAccessKey: string;
  Name: string;
  Region: string | null;
}

export enum InstanceState {
  Pending = 'pending',
  Running = 'running',
  ShuttingDown = 'shutting-down',
  Terminated = 'terminated',
  Stopping = 'stopping',
  Stopped = 'stopped',
}

export interface Instance {
  InstanceId: string;
  InstanceType: string;
  PrivateIpAddress: string;
  PublicIpAddress: string | null;
  State: InstanceState;
  Name: string | null;
}

export interface CreateUserInput {
  name: string;
  profile: Profile;
  command: CommandType;
  instance: Instance;
  remoteHost?: string;
  remotePort?: string;
  localPort?: string;
  sshPort?: string;
}

export enum CommandType {
  Connect = 'connect',
  PortForward = 'port-forward',
  FileTransfer = 'file-transfer',
}

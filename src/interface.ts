export interface Profile {
  Version: number;
  AccessKeyId: string;
  SecretAccessKey: string;
  Name: string;
  Region: string | null;
}

export interface Instance {
  InstanceId: string;
  InstanceType: string;
  PrivateIpAddress: string;
  PublicIpAddress: string | null;
  State: string;
  Name: string | null;
}

export enum CommandType {
  Connect = 'connect',
  PortForward = 'port-forward',
  FileTransfer = 'file-transfer',
}

interface CommandOptional {
  remoteHost?: string;
  remotePort?: string;
  localPort?: string;
  sshPort?: string;
}

export interface CreateUserInput extends CommandOptional {
  name: string;
  profile: Profile;
  commandType: CommandType;
  instance: Instance;
}

export interface ConfigFileCommand extends CommandOptional {
  name: string;
  profileName: string;
  region: string;
  instanceName: string;
  instanceId: string;
  commandType: CommandType;
}

export interface ConfigFile {
  version: string;
  commands: ConfigFileCommand[];
}

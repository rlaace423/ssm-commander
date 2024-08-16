import os from 'node:os';
import { $, file, write } from 'bun';
import type { ConfigFile, ConfigFileCommand, CreateUserInput } from './interface.ts';
import { CommandType } from './interface.ts';
import * as colors from 'yoctocolors-cjs';
import { checkAwsInstalled, checkSessionManagerPluginInstalled } from './aws.ts';

const CONFIG_DIRECTORY_PATH = `${os.homedir()}/.ssm-commander`;
const CONFIG_FILE_PATH = `${CONFIG_DIRECTORY_PATH}/config.json`;
// BUMP UP IF ConfigFile's structure changed
const CONFIG_VERSION = '1.0';

async function createConfigDirectory() {
  await $`mkdir -p ${CONFIG_DIRECTORY_PATH}`;
}

async function writeConfigFile(content: ConfigFile) {
  await createConfigDirectory();
  await write(CONFIG_FILE_PATH, JSON.stringify(content));
}

export async function readConfigFile(): Promise<ConfigFile> {
  const configFile = file(CONFIG_FILE_PATH);

  if (!(await configFile.exists())) {
    const emptyConfigFile = { version: CONFIG_VERSION, commands: [] };
    await writeConfigFile(emptyConfigFile);
    return emptyConfigFile;
  } else {
    return await configFile.json();
  }
}

export async function commandNameExists(commandName: string) {
  const configFile = await readConfigFile();
  return configFile.commands.find((command) => command.name === commandName);
}

export function printConfigFileCommand(command: ConfigFileCommand): void {
  console.log(`✍️ Command Name:    ${colors.cyan(command.name)}`);
  console.log(`🤵 AWS CLI Profile: ${colors.cyan(command.profileName)}`);
  console.log(`🌏 AWS Region:      ${colors.cyan(command.region)}`);
  console.log(`🖥️ EC2 Instance:    ` + colors.cyan(`${command.instanceName} (${command.instanceId})`));
  console.log(`🚀 Command Type:    ${colors.cyan(command.commandType)}`);

  if (command.commandType === CommandType.PortForward) {
    console.log(`    👉 Remote Service: ` + colors.cyan(`${command.remoteHost} (port ${command.remotePort})`));
    console.log(`    👉 Local Port:     ${colors.cyan(command.localPort as string)}`);
  } else if (command.commandType === CommandType.FileTransfer) {
    console.log(`    👉 EC2 SSH Port: ${colors.cyan(command.sshPort as string)}`);
  }
}

export function convertCreateUserInputToConfigFileCommand(data: CreateUserInput): ConfigFileCommand {
  const configFileCommand: ConfigFileCommand = {
    name: data.name,
    profileName: data.profile.Name,
    region: data.profile.Region as string,
    instanceName: data.instance.Name as string,
    instanceId: data.instance.InstanceId,
    commandType: data.commandType,
  };
  if (data.commandType === CommandType.PortForward) {
    configFileCommand.remoteHost = data.remoteHost;
    configFileCommand.remotePort = data.remotePort;
    configFileCommand.localPort = data.localPort;
  } else if (data.commandType === CommandType.FileTransfer) {
    configFileCommand.sshPort = data.sshPort;
  }
  return configFileCommand;
}

export async function saveCommand(command: ConfigFileCommand) {
  const configFile = await readConfigFile();

  configFile.commands.push(command);
  await writeConfigFile(configFile);
}

export async function deleteCommand(target: ConfigFileCommand) {
  const configFile = await readConfigFile();
  configFile.commands = configFile.commands.filter((command) => command.name !== target.name);
  await writeConfigFile(configFile);
}

export function buildActualCommand(configFileCommand: ConfigFileCommand) {
  if (configFileCommand.commandType === CommandType.Connect) {
    return `aws ssm start-session --profile ${configFileCommand.profileName} --target ${configFileCommand.instanceId}`;
  } else if (configFileCommand.commandType === CommandType.PortForward) {
    return `aws ssm start-session --profile ${configFileCommand.profileName} --target ${configFileCommand.instanceId} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host="${configFileCommand.remoteHost}",portNumber="${configFileCommand.remotePort}",localPortNumber="${configFileCommand.localPort}"`;
  } else if (configFileCommand.commandType === CommandType.FileTransfer) {
    const shellStarter = os.type() === 'Windows_NT' ? 'powershell -Command' : 'sh -c';
    return `scp -o ProxyCommand="${shellStarter} 'aws ssm start-session --profile ${configFileCommand.profileName} --target ${configFileCommand.instanceId} --document-name AWS-StartSSHSession --parameters portNumber=${configFileCommand.sshPort}'" `;
  }
}

export async function runCommand(command: ConfigFileCommand): Promise<void> {
  await checkAwsInstalled();
  await checkSessionManagerPluginInstalled();

  const actualCommand = buildActualCommand(command);
  console.log(colors.cyan(`\nRunning SSM Command "${command.name}"`));
  console.log(colors.cyan(`${actualCommand}\n`));

  if (os.type() === 'Windows_NT') {
    await $`powershell -Command ${actualCommand}`;
  } else {
    await $`sh -c ${actualCommand}`;
  }

  process.exit(0);
}

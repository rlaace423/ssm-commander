import os from 'node:os';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  type ConfigFile,
  type ConfigFileCommand,
  type CreateUserInput,
  CommandType,
  type Profile,
  type Instance,
} from './interface';
import colors from 'yoctocolors-cjs';
import { checkAwsInstalled, checkSessionManagerPluginInstalled } from './aws';

const CONFIG_DIRECTORY_PATH = `${os.homedir()}/.ssm-commander`;
const CONFIG_FILE_PATH = `${CONFIG_DIRECTORY_PATH}/config.json`;
const SCRIPT_DIRECTORY_PATH = `${CONFIG_DIRECTORY_PATH}/scripts`;
// BUMP UP IF ConfigFile's structure changed
const CONFIG_VERSION = '1.0';

function writeConfigFile(content: ConfigFile): void {
  fs.mkdirSync(CONFIG_DIRECTORY_PATH, { recursive: true });
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(content), { mode: 0o755 });
}

export function readConfigFile(): ConfigFile {
  if (!fs.existsSync(CONFIG_DIRECTORY_PATH)) {
    const emptyConfigFile = { version: CONFIG_VERSION, commands: [] };
    writeConfigFile(emptyConfigFile);
    return emptyConfigFile;
  } else {
    return JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf8'));
  }
}

export function commandNameExists(commandName: string): boolean {
  const configFile = readConfigFile();
  return !!configFile.commands.find((command) => command.name === commandName);
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
    name: data.name as string,
    profileName: (data.profile as unknown as Profile).Name,
    region: (data.profile as unknown as Profile).Region as string,
    instanceName: (data.instance as unknown as Instance).Name as string,
    instanceId: (data.instance as unknown as Instance).InstanceId,
    commandType: data.commandType as CommandType,
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

export function saveCommand(command: ConfigFileCommand): void {
  const configFile = readConfigFile();

  configFile.commands.push(command);
  writeConfigFile(configFile);
}

export function deleteCommand(target: ConfigFileCommand): void {
  const configFile = readConfigFile();
  configFile.commands = configFile.commands.filter((command) => command.name !== target.name);
  writeConfigFile(configFile);
}

export function buildActualCommand(configFileCommand: ConfigFileCommand): string {
  if (configFileCommand.commandType === CommandType.Connect) {
    return `aws ssm start-session --profile ${configFileCommand.profileName} --target ${configFileCommand.instanceId}`;
  } else if (configFileCommand.commandType === CommandType.PortForward) {
    return `aws ssm start-session --profile ${configFileCommand.profileName} --target ${configFileCommand.instanceId} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host="${configFileCommand.remoteHost}",portNumber="${configFileCommand.remotePort}",localPortNumber="${configFileCommand.localPort}"`;
  } else if (configFileCommand.commandType === CommandType.FileTransfer) {
    const shellStarter = os.type() === 'Windows_NT' ? 'powershell -Command' : 'sh -c';
    return `scp -o ProxyCommand="${shellStarter} 'aws ssm start-session --profile ${configFileCommand.profileName} --target ${configFileCommand.instanceId} --document-name AWS-StartSSHSession --parameters portNumber=${configFileCommand.sshPort}'" `;
  } else {
    throw new Error('unsupported CommandType');
  }
}

function createScriptFile(actualCommand: string): string {
  const fileName = os.type() === 'Windows_NT' ? `${randomUUID()}.bat` : `${randomUUID()}.sh`;
  const scriptHeader = os.type() === 'Windows_NT' ? '@echo off\n' : '#!/bin/sh\n';

  fs.mkdirSync(SCRIPT_DIRECTORY_PATH, { recursive: true });
  fs.writeFileSync(`${SCRIPT_DIRECTORY_PATH}/${fileName}`, `${scriptHeader}${actualCommand}`, { mode: 0o755 });
  return `${SCRIPT_DIRECTORY_PATH}/${fileName}`;
}

export async function runCommand(command: ConfigFileCommand): Promise<void> {
  await checkAwsInstalled();
  await checkSessionManagerPluginInstalled();

  const actualCommand = buildActualCommand(command);
  const scriptFilePath = createScriptFile(actualCommand);
  console.log(colors.cyan(`\nRunning SSM Command "${command.name}"`));
  console.log(colors.cyan(`${actualCommand}\n`));

  process.on('SIGINT', () => {
    console.log('SIGINT (Ctrl+C) received, forwarding to child process.');
  });

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');
  execSync(scriptFilePath, { stdio: 'inherit' });
  process.stdin.pause();
  process.stdin.setRawMode(false);
  process.exit(0);
}

import * as os from 'node:os';
import { $, file, write } from 'bun';
import type { ConfigFile, ConfigFileCommand } from './interface.ts';

const CONFIG_DIRECTORY_PATH = `${os.homedir()}/.ssm-commander`;
const CONFIG_FILE_PATH = `${CONFIG_DIRECTORY_PATH}/config.json`;
// BUMP UP IF ConfigFile changed
const CONFIG_VERSION = '1.0';

async function createConfigDirectory() {
  await $`mkdir -p ${CONFIG_DIRECTORY_PATH}`;
}

async function writeConfigFile(content: ConfigFile) {
  await createConfigDirectory();
  await write(CONFIG_FILE_PATH, JSON.stringify(content));
}

async function readConfigFile(): Promise<ConfigFile> {
  const configFile = file(CONFIG_FILE_PATH);

  if(!await configFile.exists()) {
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

export async function addCommand(command: ConfigFileCommand) {
  const configFile = await readConfigFile();

  configFile.commands.push(command);
  await writeConfigFile(configFile);
}

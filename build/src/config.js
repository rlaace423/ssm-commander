"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readConfigFile = readConfigFile;
exports.commandNameExists = commandNameExists;
exports.printConfigFileCommand = printConfigFileCommand;
exports.convertCreateUserInputToConfigFileCommand = convertCreateUserInputToConfigFileCommand;
exports.saveCommand = saveCommand;
exports.deleteCommand = deleteCommand;
exports.buildActualCommand = buildActualCommand;
exports.runCommand = runCommand;
const node_os_1 = __importDefault(require("node:os"));
const node_child_process_1 = require("node:child_process");
const bun_1 = require("bun");
const interface_1 = require("./interface");
const yoctocolors_cjs_1 = __importDefault(require("yoctocolors-cjs"));
const aws_1 = require("./aws");
const fs = __importStar(require("node:fs"));
const CONFIG_DIRECTORY_PATH = `${node_os_1.default.homedir()}/.ssm-commander`;
const CONFIG_FILE_PATH = `${CONFIG_DIRECTORY_PATH}/config.json`;
const CONFIG_VERSION = '1.0';
async function createConfigDirectory() {
    fs.mkdirSync(CONFIG_DIRECTORY_PATH, { recursive: true });
}
async function writeConfigFile(content) {
    await createConfigDirectory();
    await (0, bun_1.write)(CONFIG_FILE_PATH, JSON.stringify(content));
}
async function readConfigFile() {
    const configFile = (0, bun_1.file)(CONFIG_FILE_PATH);
    if (!(await configFile.exists())) {
        const emptyConfigFile = { version: CONFIG_VERSION, commands: [] };
        await writeConfigFile(emptyConfigFile);
        return emptyConfigFile;
    }
    else {
        return await configFile.json();
    }
}
async function commandNameExists(commandName) {
    const configFile = await readConfigFile();
    return !!configFile.commands.find((command) => command.name === commandName);
}
function printConfigFileCommand(command) {
    console.log(`✍️ Command Name:    ${yoctocolors_cjs_1.default.cyan(command.name)}`);
    console.log(`🤵 AWS CLI Profile: ${yoctocolors_cjs_1.default.cyan(command.profileName)}`);
    console.log(`🌏 AWS Region:      ${yoctocolors_cjs_1.default.cyan(command.region)}`);
    console.log(`🖥️ EC2 Instance:    ` + yoctocolors_cjs_1.default.cyan(`${command.instanceName} (${command.instanceId})`));
    console.log(`🚀 Command Type:    ${yoctocolors_cjs_1.default.cyan(command.commandType)}`);
    if (command.commandType === interface_1.CommandType.PortForward) {
        console.log(`    👉 Remote Service: ` + yoctocolors_cjs_1.default.cyan(`${command.remoteHost} (port ${command.remotePort})`));
        console.log(`    👉 Local Port:     ${yoctocolors_cjs_1.default.cyan(command.localPort)}`);
    }
    else if (command.commandType === interface_1.CommandType.FileTransfer) {
        console.log(`    👉 EC2 SSH Port: ${yoctocolors_cjs_1.default.cyan(command.sshPort)}`);
    }
}
function convertCreateUserInputToConfigFileCommand(data) {
    const configFileCommand = {
        name: data.name,
        profileName: data.profile.Name,
        region: data.profile.Region,
        instanceName: data.instance.Name,
        instanceId: data.instance.InstanceId,
        commandType: data.commandType,
    };
    if (data.commandType === interface_1.CommandType.PortForward) {
        configFileCommand.remoteHost = data.remoteHost;
        configFileCommand.remotePort = data.remotePort;
        configFileCommand.localPort = data.localPort;
    }
    else if (data.commandType === interface_1.CommandType.FileTransfer) {
        configFileCommand.sshPort = data.sshPort;
    }
    return configFileCommand;
}
async function saveCommand(command) {
    const configFile = await readConfigFile();
    configFile.commands.push(command);
    await writeConfigFile(configFile);
}
async function deleteCommand(target) {
    const configFile = await readConfigFile();
    configFile.commands = configFile.commands.filter((command) => command.name !== target.name);
    await writeConfigFile(configFile);
}
function buildActualCommand(configFileCommand) {
    if (configFileCommand.commandType === interface_1.CommandType.Connect) {
        return `aws ssm start-session --profile ${configFileCommand.profileName} --target ${configFileCommand.instanceId}`;
    }
    else if (configFileCommand.commandType === interface_1.CommandType.PortForward) {
        return `aws ssm start-session --profile ${configFileCommand.profileName} --target ${configFileCommand.instanceId} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host="${configFileCommand.remoteHost}",portNumber="${configFileCommand.remotePort}",localPortNumber="${configFileCommand.localPort}"`;
    }
    else if (configFileCommand.commandType === interface_1.CommandType.FileTransfer) {
        const shellStarter = node_os_1.default.type() === 'Windows_NT' ? 'powershell -Command' : 'sh -c';
        return `scp -o ProxyCommand="${shellStarter} 'aws ssm start-session --profile ${configFileCommand.profileName} --target ${configFileCommand.instanceId} --document-name AWS-StartSSHSession --parameters portNumber=${configFileCommand.sshPort}'" `;
    }
    else {
        throw new Error('unsupported CommandType');
    }
}
async function runCommand(command) {
    await (0, aws_1.checkAwsInstalled)();
    await (0, aws_1.checkSessionManagerPluginInstalled)();
    const actualCommand = buildActualCommand(command);
    console.log(yoctocolors_cjs_1.default.cyan(`\nRunning SSM Command "${command.name}"`));
    console.log(yoctocolors_cjs_1.default.cyan(`${actualCommand}\n`));
    if (node_os_1.default.type() === 'Windows_NT') {
        await (0, bun_1.$) `powershell -Command ${actualCommand}`;
    }
    else {
        process.on('SIGINT', () => {
            console.log('SIGINT (Ctrl+C) received, forwarding to child process.');
        });
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf-8');
        (0, node_child_process_1.execSync)('~/.ssm-commander/test.sh', { stdio: 'inherit' });
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.exit();
    }
    process.exit(0);
}
//# sourceMappingURL=config.js.map
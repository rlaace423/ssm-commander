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
const commander_1 = require("commander");
const prompts_1 = require("@inquirer/prompts");
const interface_1 = require("./interface");
const packageJson = __importStar(require("../package.json"));
const aws_1 = require("./aws");
const table_search_1 = require("./table-search");
const description_input_1 = __importDefault(require("./description-input"));
const config_1 = require("./config");
const table_1 = require("./table");
const program = new commander_1.Command();
program.name(packageJson.name).description(packageJson.description).version(packageJson.version);
const validatePort = (text) => {
    const number = parseInt(text, 10);
    if (/^\d+$/.test(text) && Number.isInteger(number) && number >= 1 && number <= 65535) {
        return true;
    }
    else {
        return 'Invalid port number. Please enter a value between 1 and 65535.';
    }
};
const validateName = async (text) => {
    const name = text.trim();
    if (name.length === 0) {
        return false;
    }
    return (await (0, config_1.commandNameExists)(name)) ? 'Command name already exists. Please choose another.' : true;
};
program
    .command('create')
    .description('Creates and saves a new SSM command with interactive CLI interface.')
    .option('--profile <profile>', 'Specify AWS CLI profile to use. If provided, interactive prompt for the profile will be skipped.')
    .option('--region <region>', 'Specify AWS region to use. If provided, interactive prompt for the region will be skipped. (It will overrides region set in the profile.)')
    .action(async (options) => {
    const data = {
        commandType: undefined,
        instance: undefined,
        name: undefined,
        profile: undefined,
    };
    const profiles = await (0, aws_1.getProfileNames)();
    const regions = await (0, aws_1.getRegions)();
    if (profiles.length === 0) {
        console.error('No AWS profiles found.');
        process.exit(1);
    }
    if (options.profile) {
        if (!profiles.includes(options.profile)) {
            console.error(`Profile "${options.profile}" not found.`);
            process.exit(1);
        }
        data.profile = await (0, aws_1.getProfile)(options.profile);
    }
    else {
        const profileName = await (0, prompts_1.select)({
            message: 'Select an AWS CLI profile',
            choices: profiles.map((profile) => ({ value: profile })),
        });
        data.profile = await (0, aws_1.getProfile)(profileName);
    }
    if (options.region) {
        if (!regions.includes(options.region)) {
            console.error(`Invalid region "${options.region}".`);
            process.exit(1);
        }
        data.profile.Region = options.region;
    }
    if (!data.profile.Region) {
        const region = await (0, prompts_1.search)({
            message: 'Select an AWS region',
            source: async (input) => {
                return regions.filter((region) => region.includes(input ?? '')).map((region) => ({ value: region }));
            },
        });
        data.profile.Region = region;
    }
    data.commandType = (await (0, prompts_1.select)({
        message: 'Select the type of "Command" you would like to create',
        choices: [
            {
                name: 'Connect',
                value: interface_1.CommandType.Connect,
                description: "Connect to an EC2 instance's shell environment.",
            },
            {
                name: 'Port Forward',
                value: interface_1.CommandType.PortForward,
                description: 'Establish a port forwarding connection to an EC2 instance. This command allows you to forward a port from a service running on the EC2 instance to your local machine, or use the instance as a BastionHost to forward a port from another server to your local machine.',
            },
            {
                name: 'File Transfer',
                value: interface_1.CommandType.FileTransfer,
                description: 'Transfer files between your local machine and an EC2 instance using "scp". Unlike other commands, it will prompt you interactively to enter the file paths.',
            },
        ],
    }));
    const instances = await (0, aws_1.getInstances)(data.profile.Name);
    const table = (0, table_1.createTable)(['Name', 'InstanceId', 'State', 'InstanceType', 'PublicIpAddress', 'PrivateIpAddress'], instances, ['Tag:Name', 'Instance Id', 'State', 'Type', 'Public IP', 'Private IP']);
    data.instance = (await (0, table_search_1.prompt)({
        message: 'Select an EC2 instance',
        header: table.header,
        bottom: table.footer,
        source: async (input) => {
            return table.bodies.filter((body) => body.name.includes(input ?? ''));
        },
    }));
    if (data.commandType === interface_1.CommandType.PortForward) {
        data.remoteHost = await (0, description_input_1.default)({
            message: "Enter Remote Service's Host",
            description: 'the Host of the remote service to be tunneled. If the service is running on this EC2 instance, "localhost" is also allowed.',
            default: 'localhost',
            required: true,
        });
        data.remotePort = await (0, description_input_1.default)({
            message: "Enter Remote Service's Port number",
            description: 'the Port number of the remote service to be tunneled.',
            required: true,
            validate: validatePort,
        });
        data.localPort = await (0, description_input_1.default)({
            message: "Enter Local Machine's Port number",
            description: 'the Port number on the local machine to be tunneled.',
            required: true,
            validate: validatePort,
        });
    }
    else if (data.commandType === interface_1.CommandType.FileTransfer) {
        data.sshPort = await (0, description_input_1.default)({
            message: "Enter Port Number Used by the EC2 Instance's SSH(SCP) Service",
            description: 'File Transfer command uses the SSH(SCP) service of the EC2 instance.',
            default: '22',
            required: true,
            validate: validatePort,
        });
    }
    console.log();
    data.name = await (0, description_input_1.default)({
        message: 'Please enter a "Name" for this command',
        description: 'Name will be used to identify and run commands later.',
        default: `${data.profile.Name}-${data.commandType}-${data.instance.Name}`,
        required: true,
        validate: validateName,
    });
    const configFileCommand = (0, config_1.convertCreateUserInputToConfigFileCommand)(data);
    console.log('\n\n== Review your new "SSM Command" ==');
    (0, config_1.printConfigFileCommand)(configFileCommand);
    console.log();
    const confirmSave = await (0, prompts_1.confirm)({ message: 'Save this command?', default: true });
    const confirmRun = await (0, prompts_1.confirm)({ message: 'Execute this command now?', default: true });
    if (confirmSave) {
        await (0, config_1.saveCommand)(configFileCommand);
    }
    if (confirmRun) {
        await (0, config_1.runCommand)(configFileCommand);
    }
});
program
    .command('list')
    .description('Displays a list of all saved SSM commands.')
    .action(async () => {
    const config = await (0, config_1.readConfigFile)();
    if (config.commands.length === 0) {
        console.error('No saved SSM commands found. Create one using the "create" command.');
        process.exit(1);
    }
    const table = (0, table_1.createTable)(['name', 'profileName', 'region', 'instanceName', 'instanceId', 'commandType'], config.commands);
    const command = (await (0, table_search_1.prompt)({
        message: 'Select an SSM Command',
        header: table.header,
        bottom: table.footer,
        source: async (input) => {
            return table.bodies.filter((body) => body.name.includes(input ?? ''));
        },
    }));
    console.log();
    (0, config_1.printConfigFileCommand)(command);
    console.log();
    const selection = await (0, prompts_1.select)({
        message: 'What would you like to do with this command?',
        choices: [{ value: 'Run' }, { value: 'Delete' }],
    });
    if (selection === 'Run') {
        await (0, config_1.runCommand)(command);
    }
    else if (selection === 'Delete') {
        await (0, config_1.deleteCommand)(command);
        console.log(`Successfully deleted SSM Command "${command.name}"`);
        process.exit(0);
    }
});
program
    .command('run')
    .description('Executes a saved SSM command.')
    .argument('<name>', 'The name of the SSM command you want to execute')
    .action(async (name) => {
    const config = await (0, config_1.readConfigFile)();
    const command = config.commands.find((c) => c.name === name);
    if (!command) {
        console.error(`No SSM command found with the name '${name}'. Please check the name and try again.`);
        process.exit(1);
    }
    (0, config_1.printConfigFileCommand)(command);
    await (0, config_1.runCommand)(command);
});
(async () => {
    await program.parseAsync();
})();
//# sourceMappingURL=index.js.map
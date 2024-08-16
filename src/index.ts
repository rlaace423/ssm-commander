import { Command as CommanderCommand } from 'commander';
import { search, select, confirm } from '@inquirer/prompts';
import { CommandType, ConfigFileCommand, type CreateUserInput, type Instance } from './interface.ts';
import * as packageJson from '../package.json';
import {
  getInstances,
  getProfile,
  getProfileNames,
  getRegions,
  isAwsInstalled,
  isSessionManagerPluginInstalled,
} from './aws.ts';
import { prompt as TableSearch } from './table-search.ts';
import DescriptionInput from './description-input.ts';
import {
  saveCommand,
  commandNameExists,
  convertCreateUserInputToConfigFileCommand,
  readConfigFile,
  printConfigFileCommand,
  deleteCommand,
  runCommand,
} from './config.ts';
import { createTable } from './table.ts';

if (!await isAwsInstalled()) {
  console.error('AWS CLI is not installed. Please install AWS CLI and try again.');
  process.exit(1);
}

if (!await isSessionManagerPluginInstalled()) {
  console.error('session-manager-plugin is not installed. Please install session-manager-plugin and try again.');
  process.exit(1);
}

const program = new CommanderCommand();
program.name(packageJson.name).description(packageJson.description).version(packageJson.version);

const validatePort = (text: string): boolean | string => {
  const number = parseInt(text, 10);
  if (/^\d+$/.test(text) && Number.isInteger(number) && number >= 1 && number <= 65535) {
    return true;
  } else {
    return 'Invalid port number. Please enter a value between 1 and 65535.';
  }
};

const validateName = async (text: string): Promise<boolean | string> => {
  const name = text.trim();
  if (name.length === 0) {
    return false;
  }
  return (await commandNameExists(name)) ? 'Command name already exists. Please choose another.' : true;
};

program
  .command('create')
  .description('Creates and saves a new SSM command with interactive CLI interface.')
  .option(
    '--profile <profile>',
    'Specify AWS CLI profile to use. If provided, interactive prompt for the profile will be skipped.',
  )
  .option(
    '--region <region>',
    'Specify AWS region to use. If provided, interactive prompt for the region will be skipped. (It will overrides region set in the profile.)',
  )
  .action(async (options) => {
    const data = {} as CreateUserInput;

    const profiles = await getProfileNames();
    const regions = await getRegions();

    if (profiles.length === 0) {
      console.error('No AWS profiles found.');
      process.exit(1);
    }

    if (options.profile) {
      if (!profiles.includes(options.profile)) {
        console.error(`Profile "${options.profile}" not found.`);
        process.exit(1);
      }
      data.profile = await getProfile(options.profile);
    } else {
      const profileName = await select({
        message: 'Select an AWS CLI profile',
        choices: profiles.map((profile) => ({ value: profile })),
      });
      data.profile = await getProfile(profileName as string);
    }

    if (options.region) {
      if (!regions.includes(options.region)) {
        console.error(`Invalid region "${options.region}".`);
        process.exit(1);
      }
      data.profile.Region = options.region;
    }

    if (!data.profile.Region) {
      const region = await search({
        message: 'Select an AWS region',
        source: async (input) => {
          return regions.filter((region) => region.includes(input ?? '')).map((region) => ({ value: region }));
        },
      });
      data.profile.Region = region as string;
    }

    data.commandType = (await select<CommandType>({
      message: 'Select the type of "Command" you would like to create',
      choices: [
        {
          name: 'Connect',
          value: CommandType.Connect,
          description: "Connect to an EC2 instance's shell environment.",
        },
        {
          name: 'Port Forward',
          value: CommandType.PortForward,
          description:
            'Establish a port forwarding connection to an EC2 instance. This command allows you to forward a port from a service running on the EC2 instance to your local machine, or use the instance as a BastionHost to forward a port from another server to your local machine.',
        },
        {
          name: 'File Transfer',
          value: CommandType.FileTransfer,
          description:
            'Transfer files between your local machine and an EC2 instance using "scp". Unlike other commands, it will prompt you interactively to enter the file paths.',
        },
      ],
    })) as CommandType;

    const instances = await getInstances(data.profile.Name);
    const table = createTable(
      ['Name', 'InstanceId', 'State', 'InstanceType', 'PublicIpAddress', 'PrivateIpAddress'],
      instances,
      ['Tag:Name', 'Instance Id', 'State', 'Type', 'Public IP', 'Private IP'],
    );
    data.instance = (await TableSearch({
      message: 'Select an EC2 instance',
      header: table.header,
      bottom: table.footer,
      source: async (input) => {
        return table.bodies.filter((body) => body.name.includes(input ?? ''));
      },
    })) as Instance;

    if (data.commandType === CommandType.PortForward) {
      data.remoteHost = await DescriptionInput({
        message: "Enter Remote Service's Host",
        description:
          'the Host of the remote service to be tunneled. If the service is running on this EC2 instance, "localhost" is also allowed.',
        default: 'localhost',
        required: true,
      });
      data.remotePort = await DescriptionInput({
        message: "Enter Remote Service's Port number",
        description: 'the Port number of the remote service to be tunneled.',
        required: true,
        validate: validatePort,
      });
      data.localPort = await DescriptionInput({
        message: "Enter Local Machine's Port number",
        description: 'the Port number on the local machine to be tunneled.',
        required: true,
        validate: validatePort,
      });
    } else if (data.commandType === CommandType.FileTransfer) {
      data.sshPort = await DescriptionInput({
        message: "Enter Port Number Used by the EC2 Instance's SSH(SCP) Service",
        description: 'File Transfer command uses the SSH(SCP) service of the EC2 instance.',
        default: '22',
        required: true,
        validate: validatePort,
      });
    }

    // sometimes this question overlap upper questions. I don't know why.
    console.log();
    data.name = await DescriptionInput({
      message: 'Please enter a "Name" for this command',
      description: 'Name will be used to identify and run commands later.',
      default: `${data.profile.Name}-${data.commandType}-${data.instance.Name}`,
      required: true,
      validate: validateName,
    });

    const configFileCommand = convertCreateUserInputToConfigFileCommand(data);
    console.log('\n\n== Review your new "SSM Command" ==');
    printConfigFileCommand(configFileCommand);
    console.log();

    if (await confirm({ message: 'Save this command?', default: true })) {
      await saveCommand(configFileCommand);
      if (await confirm({ message: 'Execute this command now?', default: true })) {
        await runCommand(configFileCommand);
      }
    }
  });

program
  .command('list')
  .description('Displays a list of all saved SSM commands.')
  .action(async () => {
    const config = await readConfigFile();
    if (config.commands.length === 0) {
      console.error('No saved SSM commands found. Create one using the "create" command.');
      process.exit(1);
    }

    const table = createTable(
      ['name', 'profileName', 'region', 'instanceName', 'instanceId', 'commandType'],
      config.commands,
    );
    const command = (await TableSearch({
      message: 'Select an SSM Command',
      header: table.header,
      bottom: table.footer,
      source: async (input) => {
        return table.bodies.filter((body) => body.name.includes(input ?? ''));
      },
    })) as ConfigFileCommand;

    console.log();
    printConfigFileCommand(command);
    console.log();
    const selection = await select({
      message: 'What would you like to do with this command?',
      choices: [{ value: 'Run' }, { value: 'Delete' }],
    });

    if (selection === 'Run') {
      await runCommand(command);
    } else if (selection === 'Delete') {
      await deleteCommand(command);
      console.log(`Successfully deleted SSM Command "${command.name}"`);
      process.exit(0);
    }
  });

program
  .command('run')
  .description('Executes a saved SSM command.')
  .argument('<name>', 'The name of the SSM command you want to execute')
  .action(async (name) => {
    const config = await readConfigFile();
    const command = config.commands.find((c) => c.name === name);

    if (!command) {
      console.error(`No SSM command found with the name '${name}'. Please check the name and try again.`);
      process.exit(1);
    }

    printConfigFileCommand(command);
    await runCommand(command);
  });

await program.parseAsync();

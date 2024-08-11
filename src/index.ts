import { Command as CommanderCommand } from 'commander';
import { Command, Instance, Profile } from './interface.ts';
import * as packageJson from '../package.json';
import {
  getInstances,
  getProfile,
  getProfileNames,
  getRegions,
  isAwsInstalled,
  isSessionManagerPluginInstalled,
} from './aws.ts';
import { search, select } from '@inquirer/prompts';
import { createTable, prompt as Ec2Search } from './table-search.ts';

if (!isAwsInstalled()) {
  console.error('AWS CLI is not installed. Please install AWS CLI and try again.');
  process.exit(1);
}

if (!isSessionManagerPluginInstalled()) {
  console.error('session-manager-plugin is not installed. Please install session-manager-plugin and try again.');
  process.exit(1);
}

const program = new CommanderCommand();
program.name(packageJson.name).description(packageJson.description).version(packageJson.version);

program
  .command('create')
  .description('Creates and stores a new SSM command with interactive CLI interface.')
  .option(
    '--profile <profile>',
    'Specify AWS CLI profile to use. If provided, interactive prompt for the profile will be skipped.',
  )
  .option(
    '--region <region>',
    'Specify AWS region to use. If provided, interactive prompt for the region will be skipped. (It will overrides region set in the profile.)',
  )
  .action(async (options) => {
    const data: { profile: Profile; command: Command, instance: Instance } = {};

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

    data.command = (await select<Command>({
      message: 'Select which command you would like to create',
      choices: [
        {
          name: 'Connect',
          value: Command.Connect,
          description: "Connect to an EC2 instance's shell environment.",
        },
        {
          name: 'Port Forward',
          value: Command.PortForward,
          description:
            'Establish a port forwarding connection to an EC2 instance. This command allows you to forward a port from a service running on the EC2 instance to your local machine, or use the instance as a BastionHost to forward a port from another server to your local machine.',
        },
        {
          name: 'File Transfer',
          value: Command.FileTransfer,
          description:
            'Transfer files between your local machine and an EC2 instance. Unlike other commands, it will prompt you interactively to enter the file paths.',
        },
      ],
    })) as Command;

    const instances = await getInstances();
    const table = createTable(instances);
    data.instance = await Ec2Search({
      message: 'Select an EC2 instance',
      header: table.header,
      bottom: table.bottom,
      source: async (input) => {
        return table.choices.filter((choice) => choice.name.includes(input ?? ''));
      },
    }) as Instance;

    if ()
    console.log(data);
  });

program.command('list').description('Displays a list of all stored SSM commands.');

program.command('run').description('Executes a stored SSM command.');

await program.parseAsync();

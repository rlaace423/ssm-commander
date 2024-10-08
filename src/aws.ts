import { $, ShellError } from 'bun';
import ora, { Ora } from 'ora';
import * as colors from 'yoctocolors-cjs';
import type { Instance, Profile } from './interface.ts';

export const BINARY_INSTALLED = {
  aws: false,
  sessionManagerPlugin: false,
};

class InstallationSpinner {
  name: string;
  spinner: Ora;

  constructor(name) {
    this.name = name;
    this.spinner = new ora({ text: colors.cyan(`Checking if ${this.name} installed..`), color: 'cyan' });
  }
  start() {
    this.spinner.start();
    return this;
  }
  stopForSuccess() {
    this.spinner.stopAndPersist({
      symbol: colors.green('✔'),
      text: colors.green(`Checking if ${this.name} installed..`),
    });
  }
  stopForFailure() {
    this.spinner.stopAndPersist({
      symbol: colors.red('✘'),
      text: colors.red(`${this.name} is not installed. Please install ${this.name} and try again.`),
    });
  }
}

export async function checkAwsInstalled(): Promise<void> {
  if (BINARY_INSTALLED.aws) {
    return;
  }

  const spinner = new InstallationSpinner('AWS CLI').start();
  const { exitCode } = await $`aws --version`.nothrow().quiet();
  if (exitCode !== 0) {
    spinner.stopForFailure();
    process.exit(1);
  } else {
    BINARY_INSTALLED.aws = true;
    spinner.stopForSuccess();
  }
}

export async function checkSessionManagerPluginInstalled(): Promise<void> {
  if (BINARY_INSTALLED.sessionManagerPlugin) {
    return;
  }

  const spinner = new InstallationSpinner('session-manager-plugin').start();
  const { exitCode } = await $`session-manager-plugin`.nothrow().quiet();
  if (exitCode !== 0) {
    spinner.stopForFailure();
    process.exit(1);
  } else {
    BINARY_INSTALLED.sessionManagerPlugin = true;
    spinner.stopForSuccess();
  }
}

export async function getProfileNames(): Promise<string[]> {
  await checkAwsInstalled();
  const profiles = (await $`aws configure list-profiles`.nothrow().text()).trim();
  return profiles.length === 0 ? [] : profiles.split('\n').map((profile) => profile.trim());
}

async function getProfileRegion(name: string): Promise<string | null> {
  await checkAwsInstalled();
  const region = (await $`aws configure get region --profile ${name}`.nothrow().text()).trim();
  return region.length === 0 ? null : region;
}

export async function getProfile(name: string): Promise<Profile> {
  try {
    await checkAwsInstalled();
    const profile = await $`aws configure export-credentials --format process --profile ${name}`.json();
    return { ...profile, Name: name, Region: await getProfileRegion(name) };
  } catch (e) {
    console.error(`Invalid AWS CLI profile ${name}`);
    process.exit(1);
  }
}

function sortAsc(list: any[], field?: string) {
  for (let i = 0; i < list.length - 1; i++) {
    let minIdx = i;
    for (let j = i + 1; j < list.length; j++) {
      const targetA = (field ? list[minIdx][field] : list[minIdx]) ?? '';
      const targetB = (field ? list[j][field] : list[j]) ?? '';
      if (targetA > targetB) {
        minIdx = j;
      }
    }
    if (minIdx !== i) {
      [list[i], list[minIdx]] = [list[minIdx], list[i]];
    }
  }
  return list;
}

export async function getInstances(profileName: string): Promise<Instance[]> {
  try {
    await checkAwsInstalled();
    const instances: Instance[] =
      await $`aws ec2 describe-instances --query "Reservations[].Instances[].{InstanceId: InstanceId, InstanceType: InstanceType, PrivateIpAddress: PrivateIpAddress, PublicIpAddress: PublicIpAddress, State: State.Name, Name: Tags[?Key=='Name'].Value | [0]}" --output json --no-cli-pager --profile ${profileName}`.json();
    return sortAsc(instances, 'Name');
  } catch (e) {
    throw new Error((e as ShellError).stderr.toString().trim());
  }
}

export async function getRegions() {
  // https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html#concepts-regions
  const regions = [
    'us-east-2',
    'us-east-1',
    'us-west-1',
    'us-west-2',
    'af-south-1',
    'ap-east-1',
    'ap-south-2',
    'ap-southeast-3',
    'ap-southeast-4',
    'ap-south-1',
    'ap-northeast-3',
    'ap-northeast-2',
    'ap-southeast-1',
    'ap-southeast-2',
    'ap-northeast-1',
    'ca-central-1',
    'ca-west-1',
    'eu-central-1',
    'eu-west-1',
    'eu-west-2',
    'eu-south-1',
    'eu-west-3',
    'eu-south-2',
    'eu-north-1',
    'eu-central-2',
    'il-central-1',
    'me-south-1',
    'me-central-1',
    'sa-east-1',
  ];
  return sortAsc(regions);
}

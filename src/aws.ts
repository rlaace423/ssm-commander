import { Ora } from 'ora';
import colors from 'yoctocolors-cjs';
import type { Instance, Profile } from './interface.ts';
import { execSync } from 'node:child_process';

export const BINARY_INSTALLED = {
  aws: false,
  sessionManagerPlugin: false,
};

class InstallationSpinner {
  name: string;
  spinner: Ora;

  constructor(name: string) {
    this.name = name;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    this.spinner = new Ora({ text: colors.cyan(`Checking if ${this.name} installed..`), color: 'cyan' });
  }

  start(): this {
    this.spinner.start();
    return this;
  }

  stopForSuccess(): void {
    this.spinner.stopAndPersist({
      symbol: colors.green('✔'),
      text: colors.green(`Checking if ${this.name} installed..`),
    });
  }

  stopForFailure(): void {
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
  try {
    execSync('aws --version', { encoding: 'utf-8' });
    BINARY_INSTALLED.aws = true;
    spinner.stopForSuccess();
  } catch (e) {
    spinner.stopForFailure();
    process.exit(1);
  }
}

export async function checkSessionManagerPluginInstalled(): Promise<void> {
  if (BINARY_INSTALLED.sessionManagerPlugin) {
    return;
  }

  const spinner = new InstallationSpinner('session-manager-plugin').start();
  try {
    execSync('session-manager-plugin', { encoding: 'utf-8' });
    BINARY_INSTALLED.sessionManagerPlugin = true;
    spinner.stopForSuccess();
  } catch (e) {
    spinner.stopForFailure();
    process.exit(1);
  }
}

export async function getProfileNames(): Promise<string[]> {
  await checkAwsInstalled();
  // todo: test
  let profiles;
  try {
    profiles = execSync('aws configure list-profiles', { encoding: 'utf-8' }).trim();
  } catch (e) {
    return [];
  }
  return profiles.length === 0 ? [] : profiles.split('\n').map((profile: string) => profile.trim());
}

async function getProfileRegion(name: string): Promise<string | null> {
  await checkAwsInstalled();
  // todo: test
  let region;
  try {
    region = execSync(`aws configure get region --profile ${name}`, { encoding: 'utf-8' }).trim();
  } catch (e) {
    return null;
  }
  return region.length === 0 ? null : region;
}

export async function getProfile(name: string): Promise<Profile> {
  try {
    await checkAwsInstalled();
    const profile = JSON.parse(
      execSync(`aws configure export-credentials --format process --profile ${name}`, { encoding: 'utf-8' }).trim(),
    );
    return { ...profile, Name: name, Region: await getProfileRegion(name) };
  } catch (e) {
    console.error(`Invalid AWS CLI profile ${name}`);
    process.exit(1);
  }
}

function sortAsc(list: any[], field?: string): any[] {
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
    const instances: Instance[] = JSON.parse(
      execSync(`aws ec2 describe-instances --query "Reservations[].Instances[].{InstanceId: InstanceId, InstanceType: InstanceType, PrivateIpAddress: PrivateIpAddress, PublicIpAddress: PublicIpAddress, State: State.Name, Name: Tags[?Key=='Name'].Value | [0]}" --output json --no-cli-pager --profile ${profileName}`, { encoding: 'utf-8' }).trim(),
    );
    return sortAsc(instances, 'Name');
  } catch (e) {
    // todo: test
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    throw new Error(e.stderr.toString());
  }
}

export async function getRegions(): Promise<string[]> {
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

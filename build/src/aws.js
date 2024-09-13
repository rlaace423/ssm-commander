"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BINARY_INSTALLED = void 0;
exports.checkAwsInstalled = checkAwsInstalled;
exports.checkSessionManagerPluginInstalled = checkSessionManagerPluginInstalled;
exports.getProfileNames = getProfileNames;
exports.getProfile = getProfile;
exports.getInstances = getInstances;
exports.getRegions = getRegions;
const bun_1 = require("bun");
const yoctocolors_cjs_1 = __importDefault(require("yoctocolors-cjs"));
exports.BINARY_INSTALLED = {
    aws: false,
    sessionManagerPlugin: false,
};
class InstallationSpinner {
    name;
    spinner;
    constructor(name) {
        this.name = name;
        this.spinner = new ora_1.Ora({ text: yoctocolors_cjs_1.default.cyan(`Checking if ${this.name} installed..`), color: 'cyan' });
    }
    start() {
        this.spinner.start();
        return this;
    }
    stopForSuccess() {
        this.spinner.stopAndPersist({
            symbol: yoctocolors_cjs_1.default.green('✔'),
            text: yoctocolors_cjs_1.default.green(`Checking if ${this.name} installed..`),
        });
    }
    stopForFailure() {
        this.spinner.stopAndPersist({
            symbol: yoctocolors_cjs_1.default.red('✘'),
            text: yoctocolors_cjs_1.default.red(`${this.name} is not installed. Please install ${this.name} and try again.`),
        });
    }
}
async function checkAwsInstalled() {
    if (exports.BINARY_INSTALLED.aws) {
        return;
    }
    const spinner = new InstallationSpinner('AWS CLI').start();
    const { exitCode } = await (0, bun_1.$) `aws --version`.nothrow().quiet();
    if (exitCode !== 0) {
        spinner.stopForFailure();
        process.exit(1);
    }
    else {
        exports.BINARY_INSTALLED.aws = true;
        spinner.stopForSuccess();
    }
}
async function checkSessionManagerPluginInstalled() {
    if (exports.BINARY_INSTALLED.sessionManagerPlugin) {
        return;
    }
    const spinner = new InstallationSpinner('session-manager-plugin').start();
    const { exitCode } = await (0, bun_1.$) `session-manager-plugin`.nothrow().quiet();
    if (exitCode !== 0) {
        spinner.stopForFailure();
        process.exit(1);
    }
    else {
        exports.BINARY_INSTALLED.sessionManagerPlugin = true;
        spinner.stopForSuccess();
    }
}
async function getProfileNames() {
    await checkAwsInstalled();
    const profiles = (await (0, bun_1.$) `aws configure list-profiles`.nothrow().text()).trim();
    return profiles.length === 0 ? [] : profiles.split('\n').map((profile) => profile.trim());
}
async function getProfileRegion(name) {
    await checkAwsInstalled();
    const region = (await (0, bun_1.$) `aws configure get region --profile ${name}`.nothrow().text()).trim();
    return region.length === 0 ? null : region;
}
async function getProfile(name) {
    try {
        await checkAwsInstalled();
        const profile = await (0, bun_1.$) `aws configure export-credentials --format process --profile ${name}`.json();
        return { ...profile, Name: name, Region: await getProfileRegion(name) };
    }
    catch (e) {
        console.error(`Invalid AWS CLI profile ${name}`);
        process.exit(1);
    }
}
function sortAsc(list, field) {
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
async function getInstances(profileName) {
    try {
        await checkAwsInstalled();
        const instances = await (0, bun_1.$) `aws ec2 describe-instances --query "Reservations[].Instances[].{InstanceId: InstanceId, InstanceType: InstanceType, PrivateIpAddress: PrivateIpAddress, PublicIpAddress: PublicIpAddress, State: State.Name, Name: Tags[?Key=='Name'].Value | [0]}" --output json --no-cli-pager --profile ${profileName}`.json();
        return sortAsc(instances, 'Name');
    }
    catch (e) {
        throw new Error(e.stderr.toString().trim());
    }
}
async function getRegions() {
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
//# sourceMappingURL=aws.js.map
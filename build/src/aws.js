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
const yoctocolors_cjs_1 = __importDefault(require("yoctocolors-cjs"));
const node_child_process_1 = require("node:child_process");
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
    try {
        (0, node_child_process_1.execSync)('aws --version', { encoding: 'utf-8' });
        exports.BINARY_INSTALLED.aws = true;
        spinner.stopForSuccess();
    }
    catch (e) {
        spinner.stopForFailure();
        process.exit(1);
    }
}
async function checkSessionManagerPluginInstalled() {
    if (exports.BINARY_INSTALLED.sessionManagerPlugin) {
        return;
    }
    const spinner = new InstallationSpinner('session-manager-plugin').start();
    try {
        (0, node_child_process_1.execSync)('session-manager-plugin', { encoding: 'utf-8' });
        exports.BINARY_INSTALLED.sessionManagerPlugin = true;
        spinner.stopForSuccess();
    }
    catch (e) {
        spinner.stopForFailure();
        process.exit(1);
    }
}
async function getProfileNames() {
    await checkAwsInstalled();
    let profiles;
    try {
        profiles = (0, node_child_process_1.execSync)('aws configure list-profiles', { encoding: 'utf-8' }).trim();
    }
    catch (e) {
        return [];
    }
    return profiles.length === 0 ? [] : profiles.split('\n').map((profile) => profile.trim());
}
async function getProfileRegion(name) {
    await checkAwsInstalled();
    let region;
    try {
        region = (0, node_child_process_1.execSync)(`aws configure get region --profile ${name}`, { encoding: 'utf-8' }).trim();
    }
    catch (e) {
        return null;
    }
    return region.length === 0 ? null : region;
}
async function getProfile(name) {
    try {
        await checkAwsInstalled();
        const profile = JSON.parse((0, node_child_process_1.execSync)(`aws configure export-credentials --format process --profile ${name}`, { encoding: 'utf-8' }).trim());
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
        const instances = JSON.parse((0, node_child_process_1.execSync)(`aws ec2 describe-instances --query "Reservations[].Instances[].{InstanceId: InstanceId, InstanceType: InstanceType, PrivateIpAddress: PrivateIpAddress, PublicIpAddress: PublicIpAddress, State: State.Name, Name: Tags[?Key=='Name'].Value | [0]}" --output json --no-cli-pager --profile ${profileName}`, { encoding: 'utf-8' }).trim());
        return sortAsc(instances, 'Name');
    }
    catch (e) {
        throw new Error(e.stderr.toString());
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
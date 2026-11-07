import { filterConnectable, listInstances } from '../aws/instances.js';
import { resolveContext } from '../context.js';
import { CliError, describeAwsError, IAM_ACTIONS } from '../errors.js';
import { defaultRunSessionDeps, runSession } from '../session/run-session.js';
import { configDir } from '../storage/paths.js';
import {
  type ForwardPreset,
  findPreset,
  loadPresets,
  type PresetsFile,
  removePreset,
  savePresets,
  upsertPreset,
} from '../storage/presets.js';
import type { AwsContext, InstanceRow, StartSessionInput } from '../types.js';
import { type DescriptionInputConfig, descriptionInput } from '../ui/description-input.js';
import { pickInstance } from '../ui/instance-picker.js';
import { info, type Spinner, spinner } from '../ui/output.js';
import { confirmOverwrite, promptIo, requireTty } from '../ui/prompts.js';
import { createTable } from '../ui/table.js';
import { fetchInstances } from './connect.js';
import { selectInstance } from './select-instance.js';

export const FORWARD_DOCUMENT = 'AWS-StartPortForwardingSessionToRemoteHost';
const PORT_ERROR = 'Enter a port number between 1 and 65535';

export function validatePort(text: string): true | string {
  const port = Number(text);
  return /^\d+$/.test(text) && port >= 1 && port <= 65535 ? true : PORT_ERROR;
}

export function buildForwardSessionInput(
  instanceId: string,
  remoteHost: string,
  remotePort: number,
  localPort: number,
): StartSessionInput {
  return {
    Target: instanceId,
    DocumentName: FORWARD_DOCUMENT,
    Parameters: { host: [remoteHost], portNumber: [String(remotePort)], localPortNumber: [String(localPort)] },
  };
}

export interface ForwardOptions {
  profile?: string;
  region?: string;
  target?: string;
  remoteHost?: string;
  remotePort?: string;
  localPort?: string;
  save?: string;
  list?: boolean;
  delete?: string;
  connectable?: boolean;
}

export interface ForwardDeps {
  resolveContext: (opts: { profile?: string; region?: string }) => Promise<AwsContext>;
  listInstances: (
    ctx: AwsContext,
    opts: { recentIds: string[]; connectableOnly: boolean },
  ) => Promise<{ rows: InstanceRow[]; ssmUnavailable: boolean }>;
  pickInstance: (rows: InstanceRow[], opts: { message: string; recentIds: string[] }) => Promise<InstanceRow>;
  runSession: (ctx: AwsContext, input: StartSessionInput) => Promise<number>;
  loadPresets: (dir: string) => Promise<PresetsFile>;
  savePresets: (dir: string, file: PresetsFile) => Promise<void>;
  configDir: string;
  descriptionInput: (config: DescriptionInputConfig) => Promise<string>;
  confirmOverwrite: (name: string) => Promise<boolean>;
  requireTty: () => void;
  info: (message: string) => void;
  writeStdout: (text: string) => void;
  spinner: (text: string) => Spinner;
}

export function defaultForwardDeps(): ForwardDeps {
  return {
    resolveContext: (opts) => resolveContext(opts),
    listInstances: (ctx, opts) => listInstances(ctx, opts),
    pickInstance,
    runSession: (ctx, input) => runSession(ctx, input, defaultRunSessionDeps(ctx)),
    loadPresets,
    savePresets,
    configDir: configDir(),
    descriptionInput: (config) => descriptionInput(config, promptIo),
    confirmOverwrite,
    requireTty: () => requireTty(),
    info,
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    spinner,
  };
}

function parsePortOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const valid = validatePort(value);
  if (valid !== true) throw new CliError(valid);
  return Number(value);
}

export function renderPresetList(file: PresetsFile): string {
  if (file.presets.length === 0) return 'No presets saved\n';
  const table = createTable(
    [
      { key: 'name', header: 'Name' },
      { key: 'profile', header: 'Profile' },
      { key: 'region', header: 'Region' },
      { key: 'instance', header: 'Instance' },
      { key: 'forward', header: 'Forward' },
    ],
    file.presets,
    (preset, key) => {
      switch (key) {
        case 'instance':
          return `${preset.instanceName ?? preset.instanceId} (${preset.instanceId})`;
        case 'forward':
          return `${preset.remoteHost}:${preset.remotePort} -> ${preset.localPort}`;
        default:
          return String(preset[key as keyof ForwardPreset] ?? '');
      }
    },
  );
  return `${[table.header, ...table.lines.map((line) => line.text), table.footer].join('\n')}\n`;
}

/** Port forwarding through an instance, optionally driven by or saved as a named preset. */
export async function runForward(
  presetName: string | undefined,
  opts: ForwardOptions,
  deps: ForwardDeps = defaultForwardDeps(),
): Promise<number> {
  const presets = await deps.loadPresets(deps.configDir);

  if (opts.list) {
    deps.writeStdout(renderPresetList(presets));
    return 0;
  }
  if (opts.delete !== undefined) {
    if (!findPreset(presets, opts.delete)) throw new CliError(`Preset "${opts.delete}" was not found`);
    await deps.savePresets(deps.configDir, removePreset(presets, opts.delete));
    deps.info(`Deleted preset "${opts.delete}"`);
    return 0;
  }

  const preset = presetName === undefined ? undefined : findPreset(presets, presetName);
  if (presetName !== undefined && preset === undefined) {
    throw new CliError(
      `Preset "${presetName}" was not found`,
      'Run "ssm-commander forward --list" to see saved presets',
    );
  }
  const remotePortOption = parsePortOption(opts.remotePort);
  const localPortOption = parsePortOption(opts.localPort);

  const ctx = await deps.resolveContext({
    profile: opts.profile ?? preset?.profile,
    region: opts.region ?? preset?.region,
  });

  let instance: { instanceId: string; name: string | null };
  if (preset !== undefined && opts.target === undefined) {
    instance = { instanceId: preset.instanceId, name: preset.instanceName };
  } else {
    const { rows } = await fetchInstances(ctx, [], deps);
    const pickRows = opts.connectable ? filterConnectable(rows) : rows;
    const row = await selectInstance(
      opts.target,
      rows,
      pickRows,
      { message: 'Select an instance to forward through', recentIds: [] },
      deps,
    );
    instance = { instanceId: row.instanceId, name: row.name };
  }

  const knownHost = opts.remoteHost ?? preset?.remoteHost;
  const knownRemotePort = remotePortOption ?? preset?.remotePort;
  const knownLocalPort = localPortOption ?? preset?.localPort;
  if (knownHost === undefined || knownRemotePort === undefined || knownLocalPort === undefined) deps.requireTty();

  const remoteHost =
    knownHost ??
    (await deps.descriptionInput({
      message: 'Remote service host',
      description: 'Host of the service to tunnel, as seen from the instance. "localhost" means the instance itself.',
      default: 'localhost',
      required: true,
    }));
  const remotePort =
    knownRemotePort ??
    Number(
      await deps.descriptionInput({
        message: 'Remote service port',
        description: 'Port of the service on the remote host.',
        required: true,
        validate: validatePort,
      }),
    );
  const localPort =
    knownLocalPort ??
    Number(
      await deps.descriptionInput({
        message: 'Local port',
        description: 'Port on this machine that will forward to the remote service.',
        required: true,
        validate: validatePort,
      }),
    );

  if (opts.save !== undefined) {
    const overwrite = findPreset(presets, opts.save) === undefined ? true : await deps.confirmOverwrite(opts.save);
    if (overwrite) {
      const saved: ForwardPreset = {
        name: opts.save,
        profile: ctx.profile,
        region: ctx.region,
        instanceId: instance.instanceId,
        instanceName: instance.name,
        remoteHost,
        remotePort,
        localPort,
      };
      await deps.savePresets(deps.configDir, upsertPreset(presets, saved));
    }
  }

  deps.info(
    `Forwarding localhost:${localPort} -> ${remoteHost}:${remotePort} via ${instance.name ?? instance.instanceId} (${instance.instanceId}). Press Ctrl+C to stop.`,
  );
  try {
    return await deps.runSession(ctx, buildForwardSessionInput(instance.instanceId, remoteHost, remotePort, localPort));
  } catch (err) {
    throw describeAwsError(err, { profile: ctx.profile, action: IAM_ACTIONS.ssmStart });
  }
}

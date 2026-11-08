import { buildExecTarget, type ExecTarget, isEcsTarget, parseEcsTarget, STANDALONE_SERVICE } from '../aws/ecs.js';
import { filterConnectable, listInstances } from '../aws/instances.js';
import { resolveContext } from '../context.js';
import { CliError, describeAwsError, IAM_ACTIONS } from '../errors.js';
import { defaultRunSessionDeps, runSession } from '../session/run-session.js';
import { type HistoryFile, loadHistory, recentEcsTargets, recentInstanceIds } from '../storage/history.js';
import { configDir } from '../storage/paths.js';
import {
  type EcsPreset,
  type ForwardPreset,
  findPreset,
  loadPresets,
  type PresetsFile,
  presetKind,
  removePreset,
  savePresets,
  upsertPreset,
} from '../storage/presets.js';
import type { AwsContext, InstanceRow, StartSessionInput } from '../types.js';
import { type DescriptionInputConfig, descriptionInput } from '../ui/description-input.js';
import { pickInstance } from '../ui/instance-picker.js';
import { info, type Spinner, spinner, warn } from '../ui/output.js';
import { confirmOverwrite, promptIo, requireTty } from '../ui/prompts.js';
import { createTable } from '../ui/table.js';
import { fetchInstances } from './connect.js';
import { defaultEcsSelectionDeps, type EcsSelectionDeps, selectEcsContainer } from './exec.js';
import { rowsOrTrustedId, selectInstance } from './select-instance.js';

export const FORWARD_DOCUMENT = 'AWS-StartPortForwardingSessionToRemoteHost';
export const LOCAL_FORWARD_DOCUMENT = 'AWS-StartPortForwardingSession';
/** Names of the instance or task itself: these take the plain document, which every agent accepts. */
const SELF_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const PORT_ERROR = 'Enter a port number between 1 and 65535';

export function validatePort(text: string): true | string {
  const port = Number(text);
  return /^\d+$/.test(text) && port >= 1 && port <= 65535 ? true : PORT_ERROR;
}

/**
 * `target` is an instance id or, for an ECS hop, the plugin's `ecs:<cluster>_<task>_<runtimeId>` form.
 * A port of the target itself uses AWS-StartPortForwardingSession (ECS Exec agents refuse the remote-host
 * document for localhost); any other host goes through AWS-StartPortForwardingSessionToRemoteHost.
 */
export function buildForwardSessionInput(
  target: string,
  remoteHost: string,
  remotePort: number,
  localPort: number,
): StartSessionInput {
  const ports = { portNumber: [String(remotePort)], localPortNumber: [String(localPort)] };
  return SELF_HOSTS.has(remoteHost)
    ? { Target: target, DocumentName: LOCAL_FORWARD_DOCUMENT, Parameters: ports }
    : { Target: target, DocumentName: FORWARD_DOCUMENT, Parameters: { host: [remoteHost], ...ports } };
}

export interface ForwardOptions {
  profile?: string;
  region?: string;
  target?: string;
  ecs?: boolean;
  container?: string;
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
  ecs: EcsSelectionDeps;
  runSession: (ctx: AwsContext, input: StartSessionInput) => Promise<number>;
  loadPresets: (dir: string) => Promise<PresetsFile>;
  savePresets: (dir: string, file: PresetsFile) => Promise<void>;
  configDir: string;
  descriptionInput: (config: DescriptionInputConfig) => Promise<string>;
  confirmOverwrite: (name: string) => Promise<boolean>;
  requireTty: () => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  writeStdout: (text: string) => void;
  spinner: (text: string) => Spinner;
  loadHistory: (dir: string) => Promise<HistoryFile>;
}

export function defaultForwardDeps(): ForwardDeps {
  return {
    resolveContext: (opts) => resolveContext(opts),
    listInstances: (ctx, opts) => listInstances(ctx, opts),
    pickInstance,
    ecs: defaultEcsSelectionDeps(),
    runSession: (ctx, input) => runSession(ctx, input, defaultRunSessionDeps(ctx)),
    loadPresets,
    savePresets,
    configDir: configDir(),
    descriptionInput: (config) => descriptionInput(config, promptIo),
    confirmOverwrite,
    requireTty: () => requireTty(),
    info,
    warn,
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    spinner,
    loadHistory,
  };
}

function parsePortOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const valid = validatePort(value);
  if (valid !== true) throw new CliError(valid);
  return Number(value);
}

function describeHop(preset: ForwardPreset): string {
  return preset.kind === 'ecs'
    ? `ecs:${preset.cluster}/${preset.service ?? STANDALONE_SERVICE}`
    : `${preset.instanceName ?? preset.instanceId} (${preset.instanceId})`;
}

export function renderPresetList(file: PresetsFile): string {
  if (file.presets.length === 0) return 'No presets saved\n';
  const table = createTable(
    [
      { key: 'name', header: 'Name' },
      { key: 'profile', header: 'Profile' },
      { key: 'region', header: 'Region' },
      { key: 'through', header: 'Through' },
      { key: 'forward', header: 'Forward' },
    ],
    file.presets,
    (preset, key) => {
      switch (key) {
        case 'through':
          return describeHop(preset);
        case 'forward':
          return `${preset.remoteHost}:${preset.remotePort} -> ${preset.localPort}`;
        default:
          return String(preset[key as 'name' | 'profile' | 'region']);
      }
    },
  );
  return `${[table.header, ...table.lines.map((line) => line.text), table.footer].join('\n')}\n`;
}

/** What the tunnel goes through, resolved from the command line, the picker or a preset. */
type Hop =
  | { kind: 'ec2'; instanceId: string; name: string | null }
  | {
      kind: 'ecs';
      cluster: string;
      service: string | null;
      taskId: string;
      container: string;
      runtimeId: string;
      /** The container name worth saving in a preset: only when it was chosen among several. */
      savedContainer: string | null;
    };

async function ec2Hop(ctx: AwsContext, opts: ForwardOptions, deps: ForwardDeps): Promise<Hop> {
  const recentIds = recentInstanceIds(await deps.loadHistory(deps.configDir), ctx.profile, ctx.region);
  const listing = await rowsOrTrustedId(opts.target, () => fetchInstances(ctx, recentIds, deps), deps.warn);
  const pickRows = opts.connectable ? filterConnectable(listing.rows) : listing.rows;
  const row =
    listing.trusted ??
    (await selectInstance(
      opts.target,
      listing.rows,
      pickRows,
      { message: 'Select an instance to forward through', recentIds },
      deps,
    ));
  return { kind: 'ec2', instanceId: row.instanceId, name: row.name };
}

async function ecsHop(
  ctx: AwsContext,
  preset: EcsPreset | undefined,
  opts: ForwardOptions,
  deps: ForwardDeps,
): Promise<Hop> {
  let want: ExecTarget = {};
  if (opts.target !== undefined && isEcsTarget(opts.target)) want = parseEcsTarget(opts.target);
  else if (preset !== undefined) want = { cluster: preset.cluster, service: preset.service ?? STANDALONE_SERVICE };

  const ecs = await deps.ecs.ecsClient(ctx);
  const recent = recentEcsTargets(await deps.loadHistory(deps.configDir), ctx.profile, ctx.region);
  const { task, container } = await selectEcsContainer(
    ecs,
    want,
    {
      connectableOnly: opts.connectable === true,
      container: opts.container ?? preset?.container ?? undefined,
      auto: preset !== undefined,
      recent,
    },
    { spinner: deps.spinner, info: deps.info, profile: ctx.profile },
    deps.ecs,
  );
  return {
    kind: 'ecs',
    cluster: task.cluster,
    service: task.service,
    taskId: task.taskId,
    container: container.name,
    runtimeId: container.runtimeId,
    savedContainer: opts.container ?? (task.containers.length > 1 ? container.name : null),
  };
}

/** Port forwarding through an instance or an ECS task, optionally driven by or saved as a named preset. */
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
  const viaEcs =
    preset !== undefined
      ? presetKind(preset) === 'ecs'
      : opts.ecs === true || (opts.target !== undefined && isEcsTarget(opts.target));
  if (preset === undefined && opts.target === undefined) deps.requireTty(); // the picker needs a terminal

  const ctx = await deps.resolveContext({
    profile: opts.profile ?? preset?.profile,
    region: opts.region ?? preset?.region,
  });

  let hop: Hop;
  if (viaEcs) {
    hop = await ecsHop(ctx, preset?.kind === 'ecs' ? preset : undefined, opts, deps);
  } else if (preset !== undefined && preset.kind !== 'ecs' && opts.target === undefined) {
    hop = { kind: 'ec2', instanceId: preset.instanceId, name: preset.instanceName };
  } else {
    hop = await ec2Hop(ctx, opts, deps);
  }

  const knownHost = opts.remoteHost ?? preset?.remoteHost;
  const knownRemotePort = remotePortOption ?? preset?.remotePort;
  const knownLocalPort = localPortOption ?? preset?.localPort;
  if (knownHost === undefined || knownRemotePort === undefined || knownLocalPort === undefined) deps.requireTty();

  const remoteHost =
    knownHost ??
    (await deps.descriptionInput({
      message: 'Remote service host',
      description:
        'Host of the service to tunnel, as seen from the instance or task. "localhost" means the instance or task itself.',
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
    let overwrite = true;
    if (findPreset(presets, opts.save) !== undefined) {
      deps.requireTty();
      overwrite = await deps.confirmOverwrite(opts.save);
    }
    if (overwrite) {
      const base = { name: opts.save, profile: ctx.profile, region: ctx.region, remoteHost, remotePort, localPort };
      const saved: ForwardPreset =
        hop.kind === 'ecs'
          ? { ...base, kind: 'ecs', cluster: hop.cluster, service: hop.service, container: hop.savedContainer }
          : { ...base, instanceId: hop.instanceId, instanceName: hop.name };
      await deps.savePresets(deps.configDir, upsertPreset(presets, saved));
    }
  }

  const via =
    hop.kind === 'ecs'
      ? `ECS task ${hop.taskId} (${hop.service ?? 'no service'}, cluster ${hop.cluster})`
      : `${hop.name ?? hop.instanceId} (${hop.instanceId})`;
  deps.info(`Forwarding localhost:${localPort} -> ${remoteHost}:${remotePort} via ${via}. Press Ctrl+C to stop.`);
  const target = hop.kind === 'ecs' ? buildExecTarget(hop.cluster, hop.taskId, hop.runtimeId) : hop.instanceId;
  try {
    return await deps.runSession(ctx, buildForwardSessionInput(target, remoteHost, remotePort, localPort));
  } catch (err) {
    throw describeAwsError(err, { profile: ctx.profile, action: IAM_ACTIONS.ssmStart });
  }
}

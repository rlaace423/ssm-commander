import { join } from 'node:path';
import { CliError } from '../errors.js';
import { readJsonFile, writeJsonFile } from './paths.js';

export interface ForwardPreset {
  name: string;
  profile: string;
  region: string;
  instanceId: string;
  instanceName: string | null;
  remoteHost: string;
  remotePort: number;
  localPort: number;
}

export interface PresetsFile {
  version: 1;
  presets: ForwardPreset[];
}

const FILE_NAME = 'presets.json';

export function emptyPresets(): PresetsFile {
  return { version: 1, presets: [] };
}

export function upsertPreset(file: PresetsFile, preset: ForwardPreset): PresetsFile {
  const exists = file.presets.some((p) => p.name === preset.name);
  const presets = exists ? file.presets.map((p) => (p.name === preset.name ? preset : p)) : [...file.presets, preset];
  return { version: 1, presets };
}

export function removePreset(file: PresetsFile, name: string): PresetsFile {
  return { version: 1, presets: file.presets.filter((p) => p.name !== name) };
}

export function findPreset(file: PresetsFile, name: string): ForwardPreset | undefined {
  return file.presets.find((p) => p.name === name);
}

export async function loadPresets(dir: string): Promise<PresetsFile> {
  const path = join(dir, FILE_NAME);
  let data: PresetsFile | null;
  try {
    data = await readJsonFile<PresetsFile>(path);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new CliError(`Could not read ${path}: ${err.message}`, 'Fix or delete the file and try again');
  }
  if (data?.version !== 1 || !Array.isArray(data.presets)) return emptyPresets();
  return data;
}

export async function savePresets(dir: string, file: PresetsFile): Promise<void> {
  await writeJsonFile(join(dir, FILE_NAME), file);
}

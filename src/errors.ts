export class CliError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const PLUGIN_INSTALL_URL =
  'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html';

export class PluginNotFoundError extends CliError {
  constructor() {
    super('session-manager-plugin was not found on PATH', `Install it from ${PLUGIN_INSTALL_URL}`);
    this.name = 'PluginNotFoundError';
  }
}

import { styleText } from 'node:util';
import ora from 'ora';

type Paint = (text: string) => string;
type Format = Parameters<typeof styleText>[0];

const paint =
  (format: Format): Paint =>
  (text) =>
    styleText(format, text, { stream: process.stderr });

export const color = {
  dim: paint('dim'),
  cyan: paint('cyan'),
  green: paint('green'),
  red: paint('red'),
  yellow: paint('yellow'),
  bold: paint('bold'),
} satisfies Record<string, Paint>;

/** Progress and status messages go to stderr so stdout stays clean (it is the data channel in proxy mode). */
export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${color.yellow(`Warning: ${message}`)}\n`);
}

export interface Spinner {
  stop(): void;
  fail(text: string): void;
}

export function spinner(text: string): Spinner {
  if (!process.stderr.isTTY) return { stop() {}, fail() {} };
  const instance = ora({ text, stream: process.stderr }).start();
  return { stop: () => instance.stop(), fail: (message) => instance.fail(message) };
}

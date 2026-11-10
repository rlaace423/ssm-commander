/** The public commands, for "did you mean" suggestions when the first word of a command line is not a command. */
export const COMMAND_NAMES: readonly string[] = ['connect', 'exec', 'forward', 'ssh', 'scp', 'doctor'];

/** Optimal string alignment distance: an insertion, deletion, substitution or swap of adjacent characters is one edit. */
export function editDistance(a: string, b: string): number {
  const width = b.length + 1;
  const d = new Array<number>((a.length + 1) * width).fill(0);
  const at = (i: number, j: number): number => d[i * width + j] ?? 0;
  for (let i = 0; i <= a.length; i++) d[i * width] = i;
  for (let j = 0; j <= b.length; j++) d[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, at(i - 2, j - 2) + 1);
      d[i * width + j] = best;
    }
  }
  return at(a.length, b.length);
}

const MIN_WORD_LENGTH = 3;

/**
 * The command a mistyped word most likely meant: one edit away for short words, two for longer ones. Null when
 * nothing is close, when the word is too short to tell, or when it is a command name as written (there is nothing
 * to correct).
 */
export function suggestCommand(word: string, commands: readonly string[] = COMMAND_NAMES): string | null {
  if (word.length < MIN_WORD_LENGTH || commands.includes(word)) return null;
  const lower = word.toLowerCase();
  const limit = lower.length <= 4 ? 1 : 2;
  let best: { name: string; distance: number } | null = null;
  for (const name of commands) {
    const distance = editDistance(lower, name);
    if (distance <= limit && (best === null || distance < best.distance)) best = { name, distance };
  }
  return best?.name ?? null;
}

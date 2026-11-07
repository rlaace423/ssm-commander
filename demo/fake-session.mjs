// Stand-in for session-manager-plugin, ssh and scp used only by the README demo: it prints what the
// remote side would show and answers a handful of commands from a table. Nothing is executed or sent.
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

const [, , mode = 'connect', ...rest] = process.argv;
const REGION = 'ap-northeast-2';
const hostnameOf = (ip) => `ip-${ip.replaceAll('.', '-')}.${REGION}.compute.internal`;
const sessionIdFor = (profile) => `${profile}-user-0a1b2c3d4e5f6789a`;
const UPTIME = ' 09:41:07 up 12 days,  3:14,  1 user,  load average: 0.08, 0.05, 0.01';

/** A line-based shell: known commands answer from `responses`, `exit` ends it with `farewell`. */
function shell({ banner, prompt, responses, farewell }) {
  process.stdout.write(banner);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt, terminal: true });
  rl.prompt();
  rl.on('line', (line) => {
    const command = line.trim();
    if (command === 'exit') {
      rl.close();
      return;
    }
    if (command !== '') {
      const lines = responses[command] ?? [`sh: ${command.split(' ')[0]}: command not found`];
      process.stdout.write(`${lines.join('\n')}\n`);
    }
    rl.prompt();
  });
  rl.on('close', () => {
    process.stdout.write(farewell);
    process.exit(0);
  });
}

switch (mode) {
  case 'connect': {
    const [profile = 'demo', ip = '10.0.1.13'] = rest;
    const id = sessionIdFor(profile);
    shell({
      banner: `\nStarting session with SessionId: ${id}\n`,
      prompt: 'sh-5.2$ ',
      responses: { hostname: [hostnameOf(ip)], whoami: ['ssm-user'], uptime: [UPTIME] },
      farewell: `\n\nExiting session with sessionId: ${id}.\n`,
    });
    break;
  }
  case 'forward': {
    const [profile = 'demo', port = '0'] = rest;
    const id = sessionIdFor(profile);
    process.stdout.write(`\nStarting session with SessionId: ${id}\nPort ${port} opened for sessionId ${id}.\n`);
    process.stdout.write('Waiting for connections...\n');
    process.on('SIGINT', () => {
      process.stdout.write('\nTerminate signal received, exiting.\n');
      process.exit(0);
    });
    setInterval(() => {}, 1000); // stay alive until Ctrl+C
    break;
  }
  case 'ssh': {
    // Arguments as built for the system ssh: <private ip> -o ProxyCommand=... -l <user> ... <instance id>
    const [ip = '10.0.1.13', ...args] = rest;
    const user = args[args.indexOf('-l') + 1] ?? 'ec2-user';
    const instanceId = args.find((arg) => /^i-[0-9a-f]+$/.test(arg)) ?? 'i-0';
    shell({
      banner: 'Welcome to Ubuntu 24.04 LTS (GNU/Linux 6.8.0-1021-aws aarch64)\n\n',
      prompt: `${user}@${hostnameOf(ip).split('.')[0]}:~$ `,
      responses: { hostname: [hostnameOf(ip)], whoami: [user], uptime: [UPTIME] },
      farewell: `logout\nConnection to ${instanceId} closed.\n`,
    });
    break;
  }
  case 'scp': {
    // Arguments as built for the system scp: <private ip> -o ... <local path> <instance id>:<remote path>
    const [, ...args] = rest;
    const operands = [];
    for (let i = 0; i < args.length; i++) {
      if (['-o', '-i', '-P'].includes(args[i])) i += 1;
      else if (!args[i].startsWith('-')) operands.push(args[i]);
    }
    const name = basename(operands.find((operand) => !operand.includes(':')) ?? 'file').padEnd(44);
    const steps = [
      [0, '0B', '0.0KB/s', '--:--'],
      [37, '4.4MB', '4.1MB/s', '00:02'],
      [74, '8.9MB', '4.2MB/s', '00:01'],
      [100, '12MB', '4.0MB/s', '00:03'],
    ];
    let delay = 0;
    for (const [pct, size, rate, eta] of steps) {
      setTimeout(() => {
        process.stdout.write(
          `\r${name} ${String(pct).padStart(3)}% ${size.padStart(6)} ${rate.padStart(9)} ${eta.padStart(7)}`,
        );
      }, delay);
      delay += 450;
    }
    setTimeout(() => process.stdout.write('\n'), delay);
    break;
  }
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(2);
}

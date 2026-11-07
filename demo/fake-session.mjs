// Stand-in for session-manager-plugin used only by the README demo: it looks like a remote shell
// and answers a handful of commands from a table. Nothing is executed.
import { createInterface } from 'node:readline';

const [, , profile = 'demo', privateIp = '10.0.1.13'] = process.argv;
const sessionId = `${profile}-user-0a1b2c3d4e5f6789a`;
const hostname = `ip-${privateIp.replaceAll('.', '-')}.ap-northeast-2.compute.internal`;
const responses = {
  hostname: [hostname],
  whoami: ['ssm-user'],
  uptime: [' 09:41:07 up 12 days,  3:14,  0 users,  load average: 0.08, 0.05, 0.01'],
  'cat /etc/os-release': ['NAME="Amazon Linux"', 'VERSION="2023"', 'ID="amzn"', 'PRETTY_NAME="Amazon Linux 2023.7"'],
  'df -h /': ['Filesystem      Size  Used Avail Use% Mounted on', '/dev/nvme0n1p1   30G  8.1G   22G  28% /'],
};

process.stdout.write(`\nStarting session with SessionId: ${sessionId}\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'sh-5.2$ ', terminal: true });
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
  process.stdout.write(`\n\nExiting session with sessionId: ${sessionId}.\n`);
  process.exit(0);
});

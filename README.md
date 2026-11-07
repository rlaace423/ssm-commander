# ssm-commander

Connect to EC2 instances through AWS Systems Manager Session Manager **by name instead of instance id**: pick a
profile, pick an instance from a searchable list, and you are in. Port forwarding, `ssh` and `scp` over Session
Manager are included, across all of your AWS profiles, and the AWS CLI is not required.

![Demo: pick a profile, pick an instance from the table, and you are in a shell](demo/connect.gif)

Inspired by [gossm](https://github.com/gjbae1212/gossm) (archived in 2025).

## Requirements

- Node.js 22 or newer.
- [session-manager-plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
  on your `PATH` (macOS: `brew install --cask session-manager-plugin`). If it lives somewhere else, point
  `SSM_COMMANDER_PLUGIN_PATH` at the executable.
- AWS credentials in `~/.aws/credentials` and `~/.aws/config` (as written by `aws configure`), one profile per
  account. The AWS CLI itself is not needed at runtime.
- IAM permissions for the profile you use: `ec2:DescribeInstances`, `ssm:DescribeInstanceInformation`,
  `ssm:StartSession`, `ssm:TerminateSession`. Optional: `ec2:DescribeRegions` for the region picker and
  `sts:GetCallerIdentity` for `doctor --profile`.
- On the instances: SSM Agent online and an instance profile that allows Session Manager. For `ssh` and `scp`
  additionally an SSH server and your public key in the target user's `authorized_keys`.

## Install

```bash
npm install -g ssm-commander
```

or run it without installing:

```bash
npx ssm-commander
```

## Usage

### connect (the default command)

```bash
ssm-commander                              # profile → (region) → instance → shell
ssm-commander connect web-1 -p prod        # by Name tag; no prompt when the name is unique
ssm-commander connect i-0123456789abcdef0 -p prod -r ap-northeast-2
ssm-commander connect --connectable        # list only instances that can be connected right now
```

The list shows every instance of the region except terminated ones, with the columns Name, Instance Id, State,
SSM, Type, Private IP and Public IP. Type to filter by name, instance id or IP address. Recently connected
instances come first and are marked with `*`. Instances that cannot be connected (stopped, no SSM agent, agent
connection lost) are dimmed with the reason and cannot be selected; naming one explicitly fails with that reason.

### forward

```bash
ssm-commander forward --target bastion --remote-host db.internal --remote-port 5432 --local-port 15432 --save prod-db
ssm-commander forward prod-db              # reuse the saved preset, no prompts
ssm-commander forward                      # pick the instance and answer the prompts
ssm-commander forward --list
ssm-commander forward --delete prod-db
```

![Demo: save a port-forwarding preset, then reuse it by name](demo/forward.gif)

`--remote-host localhost` forwards a port of the instance itself. Values you do not pass are prompted for.
Press Ctrl+C to stop forwarding.

### ssh and scp

```bash
ssm-commander ssh --profile prod --user ubuntu web-1 -o StrictHostKeyChecking=accept-new hostname
ssm-commander ssh --profile prod web-1                  # interactive shell as ec2-user
ssm-commander scp --profile prod ./dump.sql ubuntu@web-1:/tmp/
ssm-commander scp --profile prod -r ubuntu@web-1:/var/log/app ./logs
```

![Demo: ssh and scp by instance name](demo/ssh.gif)

Argument order for `ssh`: ssm-commander's own options (`--profile`, `--region`, `--user`, `--identity`,
`--port`, `--connectable`) first, then the target, then ssh's own options and the remote command, exactly as you
would write them for `ssh` itself. Everything after the target is passed through unchanged, so `-o ...`, port
forwards and remote commands with their own flags all work. The target may be written as `user@name`; the default
user is `ec2-user`, `--user` overrides it, and `user@` overrides both. For `scp`, exactly one side of the transfer
is `[user@]instance:path`, where `instance` is a Name tag or instance id, and `-r` and other scp flags pass
through.

Under the hood both commands run the system `ssh`/`scp` with a `ProxyCommand` that calls a hidden
`ssm-commander proxy` subcommand, which opens an `AWS-StartSSHSession` through Session Manager. Host keys are
recorded under the instance id.

### doctor

```bash
ssm-commander doctor -p prod
```

Checks Node.js, session-manager-plugin (path and version), your AWS config files and, with `--profile`, that the
credentials work (STS GetCallerIdentity). Exit code 1 if anything fails.

### Profile and region resolution

- Profile: `-p/--profile` → `AWS_PROFILE` → prompt (skipped when only one profile exists).
- Region: `-r/--region` → `AWS_REGION` / `AWS_DEFAULT_REGION` → the profile's `region` → prompt.

MFA-protected `assume-role` profiles prompt for the code in `connect`, `forward` and `doctor`; `ssh` and `scp`
cannot prompt (the SSH data channel occupies stdin), so use them with profiles that need no MFA code. SSO profiles
work while their token is valid; this tool does not run the SSO login itself.

## How it works

The AWS SDK lists instances (`DescribeInstances` joined with `DescribeInstanceInformation` for the agent status)
and calls `StartSession`. The response is handed to `session-manager-plugin` exactly the way the AWS CLI does it
(through the `AWS_SSM_START_SESSION_RESPONSE` environment variable), with the terminal inherited by the plugin, so
nothing sits between your keyboard and the remote shell. Ctrl+C goes to the remote shell, not to ssm-commander.
When the session ends, `TerminateSession` is called as a safety net.

## Files and environment variables

- `~/.ssm-commander/history.json`: recent connections (profile, region, instance id and name).
- `~/.ssm-commander/presets.json`: saved port-forwarding presets.
- Both are created with mode 0600 and never contain credentials or tokens.
- `SSM_COMMANDER_HOME`: use another directory for the files above.
- `SSM_COMMANDER_PLUGIN_PATH`: explicit path to session-manager-plugin.
- `SSM_COMMANDER_DEBUG=1`: print stack traces for unexpected errors. The equivalent `--debug` flag goes before the
  command, as in `ssm-commander --debug connect web-1`.
- Upgrading from 0.1: the old saved-command file `~/.ssm-commander/config.json` is no longer read. It is left
  untouched and can be deleted.

## Platform support

Verified on macOS; Linux uses the same code paths. Windows: untested. The code looks for
`session-manager-plugin.exe` and never goes through a shell, but ssh/scp ProxyCommand quoting and signal handling
have not been exercised there.

## Manual verification checklist

Run these against a profile and two instances you can reach (one Ubuntu, one Amazon Linux work well):

- [ ] `ssm-commander doctor -p <profile>` prints ✔ on every line.
- [ ] `ssm-commander connect <name> -p <profile>` opens a shell; `echo ok` prints `ok`; `exit` ends the session
  and the plugin prints `Exiting session with sessionId`.
- [ ] `ssm-commander connect -p <profile>` lists instances with State and SSM columns; the one you just used is
  marked `*`; non-connectable rows are dimmed with a reason and cannot be selected.
- [ ] `ssm-commander connect <stopped-instance-name> -p <profile>` fails with `cannot be connected: stopped`.
- [ ] `ssm-commander connect --connectable -p <profile>` hides the non-connectable rows.
- [ ] `ssm-commander forward -p <profile> --target <name> --remote-host localhost --remote-port 22 --local-port 2222 --save t`
  then, in another terminal, `ssh -p 2222 <user>@localhost hostname` prints the hostname; Ctrl+C stops the
  forward; `ssm-commander forward t` starts again without prompts; `ssm-commander forward --list` shows `t`.
- [ ] `ssm-commander ssh --profile <profile> --user ubuntu <ubuntu-name> hostname` prints the hostname, and
  `ssm-commander ssh --profile <profile> <amazon-linux-name> whoami` prints `ec2-user`.
- [ ] `ssm-commander scp --profile <profile> ./file user@<name>:/tmp/file` followed by the download in the other
  direction gives an identical file; `-r` copies a directory.
- [ ] Inside a session, Ctrl+C interrupts the remote command (try `sleep 30`) and ssm-commander keeps running.
- [ ] After every session no `session-manager-plugin` process is left behind (`pgrep session-manager-plugin`).

## Development

```bash
npm install
npm test            # vitest, no network needed
npm run typecheck   # tsc --noEmit
npm run lint        # biome
npm run build       # esbuild → dist/
```

Design and implementation notes live under `docs/superpowers/`.

## License

MIT

# ssm-commander

Connect to EC2 instances through AWS Systems Manager Session Manager **by name instead of instance id**: pick a
profile, pick an instance from a searchable list, and you are in. Port forwarding, `ssh` and `scp` over Session
Manager and `exec` into ECS containers are included, across all of your AWS profiles, and the AWS CLI is not
required.

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
- For `exec` (ECS): `ecs:ListClusters`, `ecs:DescribeClusters`, `ecs:ListServices`, `ecs:DescribeServices`,
  `ecs:ListTasks`, `ecs:DescribeTasks`, `ecs:ExecuteCommand`. With `--cluster` and `--task` only the last two
  are needed. Port forwarding through a task (`forward --target ecs:...`) uses `ssm:StartSession` and
  `ssm:TerminateSession` instead of `ecs:ExecuteCommand`.
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

### exec (ECS containers)

```bash
ssm-commander exec                              # cluster → service → task → shell in the container
ssm-commander exec prod/api                     # service in a cluster; the task is asked for only when there are several
ssm-commander exec api -p prod                  # service name, searched in every cluster
ssm-commander exec --cluster prod --task 0123456789abcdef0123456789abcdef --container app
ssm-commander exec prod/api --command bash
```

![Demo: pick a cluster, a service and a task, and you are in the container](demo/exec.gif)

Opens an interactive command (default `/bin/sh`) in a container through ECS Exec, the way
`aws ecs execute-command` does, without looking up the task id first. Each step shows a table (cluster, then
service, then task; a container is asked for only when the task has several), and a step given on the command
line or with a single possible choice is skipped. Tasks that cannot be reached are dimmed with the reason: not
running, `exec disabled` (the task was started without `enableExecuteCommand`), `agent pending`, `no exec
agent`. Tasks that belong to no service are listed under `(no service)`.

The task side needs what ECS Exec always needs: the service or task started with `enableExecuteCommand`, and a
task role allowing `ssmmessages:CreateControlChannel`, `ssmmessages:CreateDataChannel`,
`ssmmessages:OpenControlChannel` and `ssmmessages:OpenDataChannel`. For port forwarding through a task see
`forward --target ecs:...` above.

### forward

```bash
ssm-commander forward --target bastion --remote-host db.internal --remote-port 5432 --local-port 15432 --save prod-db
ssm-commander forward prod-db              # reuse the saved preset, no prompts
ssm-commander forward                      # pick the instance and answer the prompts
ssm-commander forward --list
ssm-commander forward --delete prod-db
ssm-commander forward --target ecs:prod/api --remote-host localhost --remote-port 8080 --local-port 18080 --save api-local
ssm-commander forward --ecs                # pick cluster, service and task from lists, then answer the prompts
```

![Demo: save a port-forwarding preset, then reuse it by name](demo/forward.gif)

`--remote-host localhost` forwards a port of the instance itself. Values you do not pass are prompted for.
Press Ctrl+C to stop forwarding.

The tunnel can also go through an ECS task: `--target ecs:cluster/service` (or `ecs:cluster/service/task-id`,
or `--ecs` to pick from lists) uses the same selection as `exec`, so the task needs ECS Exec enabled. `localhost`
then means the task itself, so `--remote-port 8080` reaches the container's port 8080, and another host is
reached from the task's network (a Fargate task as a bastion for RDS, for example). A preset saved this way
remembers the cluster and service and goes through the newest reachable task each time it runs.

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

MFA-protected `assume-role` profiles prompt for the code in `connect`, `exec`, `forward` and `doctor`; `ssh` and `scp`
cannot prompt (the SSH data channel occupies stdin), so use them with profiles that need no MFA code. SSO profiles
work while their token is valid; this tool does not run the SSO login itself.

### Working with narrow permissions

The listings are a convenience. When a profile may not call `ec2:DescribeInstances`, `connect`, `forward --target`,
`ssh` and `scp` still work with an instance id (a warning says the instance was not checked); a Name tag needs
the listing. For `exec`, `--cluster` together with `--task` calls only `ecs:DescribeTasks` and
`ecs:ExecuteCommand`, exactly what the AWS CLI needs; `forward --target ecs:cluster/service/task-id` likewise
calls only `ecs:DescribeTasks` and `ssm:StartSession`.

## How it works

The AWS SDK lists instances (`DescribeInstances` joined with `DescribeInstanceInformation` for the agent status)
and calls `StartSession`. The response is handed to `session-manager-plugin` exactly the way the AWS CLI does it
(through the `AWS_SSM_START_SESSION_RESPONSE` environment variable), with the terminal inherited by the plugin, so
nothing sits between your keyboard and the remote shell. Ctrl+C goes to the remote shell, not to ssm-commander.
When the session ends, `TerminateSession` is called as a safety net. For `exec`, `ecs:ExecuteCommand` returns the
same kind of session and the plugin is started with the `ecs:<cluster>_<task>_<runtimeId>` target, exactly as
`aws ecs execute-command` does. Port forwarding through a task is a normal `StartSession` with that same target,
which Session Manager accepts for tasks that have ECS Exec enabled.

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

## Development

```bash
npm install
npm test            # vitest, no network needed
npm run typecheck   # tsc --noEmit
npm run lint        # biome
npm run build       # esbuild → dist/
```

Design and implementation notes live under `docs/superpowers/`; the release checklist that exercises the real
plugin and AWS APIs is [docs/manual-verification.md](docs/manual-verification.md).

## License

MIT

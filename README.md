# ssm-commander

[![CI](https://github.com/rlaace423/ssm-commander/actions/workflows/ci.yml/badge.svg)](https://github.com/rlaace423/ssm-commander/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ssm-commander)](https://www.npmjs.com/package/ssm-commander)
[![node](https://img.shields.io/node/v/ssm-commander)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/ssm-commander)](LICENSE)

Connect to EC2 instances and ECS containers through AWS Systems Manager Session Manager **by name instead of
instance id**. Pick a profile, pick a target from a searchable table, and you are in: a shell, a port forward,
`ssh` and `scp`, or a command in a container, across all of your AWS profiles and without the AWS CLI.

![Demo: pick a profile, pick an instance from the table, and you are in a shell](demo/connect.gif)

- **Names, not ids.** Instances by Name tag, containers by `cluster/service`. Without a name you get a searchable
  table, with the targets you used before on top.
- **One tool for EC2 and ECS.** `connect` for a shell, `forward` for port forwarding, `ssh` and `scp` through
  Session Manager, `exec` for a command in an ECS container.
- **No inbound ports.** Everything goes through Session Manager: no public IP, no bastion, no inbound rule for
  port 22.
- **All of your profiles.** The profiles of `~/.aws`, including MFA-protected `assume-role` profiles and SSO
  profiles with a valid token. The AWS CLI is not needed at runtime.
- **Tables that tell you why.** Targets that cannot be reached (stopped, no agent, ECS Exec disabled) are dimmed
  with the reason instead of failing after you pick them.

Inspired by [gossm](https://github.com/gjbae1212/gossm), archived in 2025.

## Install

With Homebrew, which installs Node.js for you:

```bash
brew install rlaace423/tap/ssm-commander
```

With npm, on Node.js 22 or newer:

```bash
npm install -g ssm-commander
```

or without installing: `npx ssm-commander`.

Either way the sessions are carried by AWS's
[session-manager-plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html),
which must be on your `PATH` (macOS: `brew install --cask session-manager-plugin`). Then check the setup:

```bash
ssm-commander doctor -p <profile>
```

### Requirements

- AWS profiles in `~/.aws/config` and `~/.aws/credentials`, as `aws configure` writes them.
- On the instances: SSM Agent online and an instance profile that allows Session Manager
  (`AmazonSSMManagedInstanceCore`). For `ssh` and `scp` also an SSH server and your key in the login user's
  `authorized_keys`. For `exec`: ECS Exec enabled on the service or task.
- IAM permissions for your profile: see the [table below](#iam-permissions).
- macOS and Linux. Windows is untested.

## Usage

### connect

```bash
ssm-commander                              # profile → (region) → instance → shell
ssm-commander connect web-1 -p prod        # by Name tag; no prompt when the name is unique
ssm-commander connect i-0123456789abcdef0 -p prod -r ap-northeast-2
ssm-commander connect --connectable        # only instances that can be connected right now
```

Without a command, `connect` runs and takes options only (`ssm-commander -p prod`); a target always follows its
command. The table lists the instances of the region with their state and SSM status; type to search by name, id
or IP address. Instances you connected to before come first, marked `*`.

### exec

```bash
ssm-commander exec                              # cluster → service → task → shell in the container
ssm-commander exec prod/api                     # service in a cluster; the task is asked for only when there are several
ssm-commander exec api -p prod                  # service name, searched in every cluster
ssm-commander exec --cluster prod --task 0123456789abcdef0123456789abcdef --container app
ssm-commander exec prod/api --command bash
```

![Demo: pick a cluster, a service and a task, and you are in the container](demo/exec.gif)

Runs an interactive command (default `/bin/sh`) in a container through ECS Exec, the way `aws ecs execute-command`
does, without looking up the task id first. Tasks that cannot be reached are dimmed with the reason (`exec
disabled`, `agent pending`, ...). The task needs what ECS Exec always needs: `enableExecuteCommand` and a task
role with the `ssmmessages` channel actions; `doctor --ecs cluster/service` checks both.

### forward

```bash
ssm-commander forward --target bastion --remote-host db.internal --remote-port 5432 --local-port 15432 --save prod-db
ssm-commander forward prod-db              # reuse the saved preset, no prompts
ssm-commander forward                      # pick the instance and answer the prompts
ssm-commander forward --target ecs:prod/api --remote-host localhost --remote-port 8080 --local-port 18080
ssm-commander forward --list               # saved presets; --delete <name> removes one
```

![Demo: save a port-forwarding preset, then reuse it by name](demo/forward.gif)

The word after `forward` is a preset. What to go through is named with an option: `--target` for an instance, and
for an ECS task `--target ecs:prod/api` or `--ecs prod/api` (`--ecs` alone picks from lists). `--remote-host
localhost` forwards a port of the instance or task itself; any other host is reached from its network, so a Fargate
task or a small instance works as a bastion for RDS. After a run that asked questions, the equivalent command line
is printed so that the next run needs no prompts. Ctrl+C stops the tunnel.

### ssh and scp

```bash
ssm-commander ssh --profile prod web-1                  # interactive shell; the login name follows the platform
ssm-commander ssh --profile prod web-1 -o StrictHostKeyChecking=accept-new hostname
ssm-commander scp --profile prod ./dump.sql ubuntu@web-1:/tmp/
ssm-commander scp --profile prod -r ubuntu@web-1:/var/log/app ./logs
```

![Demo: ssh and scp by instance name](demo/ssh.gif)

The system `ssh` and `scp` run with a `ProxyCommand` through Session Manager, so keys, `-o` options, port forwards
and remote commands work as usual. Write ssm-commander's options (`--profile`, `--region`, `--user`) before the
target and ssh's own after it. The login name defaults to `ubuntu` on Ubuntu, `admin` on Debian and `ec2-user`
otherwise; `user@name` or `--user` overrides it. After `ssh` and `scp`, `-p` and `-r` belong to ssh and scp
themselves, so `--profile` and `--region` are written in full there; in front of the command they are the profile
and the region as everywhere (`ssm-commander -p prod ssh web-1`).

### doctor

```bash
ssm-commander doctor -p prod
ssm-commander doctor -p prod --ecs prod/api   # plus the ECS Exec prerequisites of a service
```

Checks Node.js, the plugin, the AWS config files and the credentials of the profile; with `--ecs`, also everything
a container needs for ECS Exec. Exit code 1 when something fails.

### Profiles, regions and MFA

- Profile: `-p/--profile`, then `AWS_PROFILE`, then a prompt (skipped when only one profile exists).
- Region: `-r/--region`, then `AWS_REGION` or `AWS_DEFAULT_REGION`, then the profile's `region`, then a prompt.
- `-p` and `-r` go before the command or after it: `ssm-commander -p prod exec` is `ssm-commander exec -p prod`.
  Every other option follows its command.
- MFA codes are prompted for by `connect`, `exec`, `forward` and `doctor`; `ssh` and `scp` cannot prompt, so use
  them with profiles that need no code. SSO profiles work while their token is valid; run `aws sso login` yourself.

The [reference](docs/reference.md) describes the tables, the saved files, the environment variables and how the
sessions are set up.

## IAM permissions

| Command | IAM actions |
| --- | --- |
| `connect`, `forward` through an instance, `ssh`, `scp` | `ec2:DescribeInstances`, `ssm:DescribeInstanceInformation`, `ssm:StartSession`, `ssm:TerminateSession` |
| `exec` | `ecs:ListClusters`, `ecs:DescribeClusters`, `ecs:ListServices`, `ecs:DescribeServices`, `ecs:ListTasks`, `ecs:DescribeTasks`, `ecs:ExecuteCommand`; with `--cluster` and `--task`, only the last two |
| `forward` through an ECS task | the `ecs:` listing actions of `exec` plus `ssm:StartSession` and `ssm:TerminateSession`; no `ecs:ExecuteCommand` |
| `doctor --profile` | `sts:GetCallerIdentity` |
| `doctor --ecs` | `ecs:ListServices`, `ecs:DescribeServices`, `ecs:ListTasks`, `ecs:DescribeTasks`, `ecs:DescribeTaskDefinition`, `iam:SimulatePrincipalPolicy` |
| the region picker (a profile without a region) | `ec2:DescribeRegions` |

The listings are a convenience: with an instance id, `connect`, `forward --target`, `ssh` and `scp` work without
`ec2:DescribeInstances`, and `exec --cluster --task` calls only `ecs:DescribeTasks` and `ecs:ExecuteCommand`.

## Troubleshooting

- **`Permission denied (publickey)` from ssh or scp.** The login name or the key: pass `--user <name>` or
  `name@target` for an AMI with another default, and keep the key file readable by you alone (`chmod 600`).
- **`The instance is not connected to Systems Manager`.** The SSM agent is not online: the instance is stopped, has
  no agent, or its instance profile lacks the Session Manager permissions. The table's Note column says which.
- **`session-manager-plugin was not found on PATH`.** Install it (see Install) or point
  `SSM_COMMANDER_PLUGIN_PATH` at the executable.
- **`Local port <n> is already in use`.** Another forward or another program listens there; pass another
  `--local-port` or stop it.
- **The terminal misbehaves after a session** (no echo, Ctrl+C ignored). Run `stty sane`.

`ssm-commander doctor` finds most setup problems; the [reference](docs/reference.md#troubleshooting) has more cases.

## Development

```bash
npm install
npm test                                   # vitest, no network needed
npm run lint && npm run typecheck && npm run build
```

[CHANGELOG.md](CHANGELOG.md) records what changed between versions.
[docs/manual-verification.md](docs/manual-verification.md) is the release checklist against real instances and
services; `test-infra/` creates and deletes them with CloudFormation.

## License

MIT

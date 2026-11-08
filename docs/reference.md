# ssm-commander reference

The [README](../README.md) shows the common cases. This page has the details behind them: what the tables show,
how targets are matched, how `ssh` and `scp` are wired, the files and environment variables, and how the sessions
are set up.

## connect

The list shows every instance of the region except terminated ones, with the columns Name, Instance Id, State,
SSM, Type, Private IP and Public IP. Type to filter by name, instance id or IP address. Instances you have
connected to before come first and are marked with `*` (the history is written by `connect` and `exec`; `forward`,
`ssh` and `scp` show the marks but do not add to it). Instances that cannot be connected (stopped, no SSM agent, agent
connection lost) are dimmed with the reason and cannot be selected; naming one explicitly fails with that reason.

A target on the command line is an instance id or a Name tag. The name is matched ignoring case, and when several
instances share it the list opens with just those. An id that is not in the region fails at once, naming the region
and the profile. In a narrow terminal the table drops the Public IP, Type and Private IP columns (in that order) and
shortens long names; typing still searches the hidden fields. A first word that matches no instance but looks like
a mistyped command (`ssm-commander conect`) is reported as an unknown command.

## exec

Opens an interactive command (default `/bin/sh`) in a container through ECS Exec, the way
`aws ecs execute-command` does, without looking up the task id first. Each step shows a table (cluster, then
service, then task; a container is asked for only when the task has several), and a step given on the command
line or with a single possible choice is skipped. Tasks that cannot be reached are dimmed with the reason: not
running, `exec disabled` (the task was started without `enableExecuteCommand`), `agent pending`, `no exec
agent`. Tasks that belong to no service are listed under `(no service)`. Clusters and services you have connected
to before come first and are marked with `*`, as instances do in `connect`; tasks are not remembered because
they change with every deployment.

The task side needs what ECS Exec always needs: the service or task started with `enableExecuteCommand`, and a
task role allowing `ssmmessages:CreateControlChannel`, `ssmmessages:CreateDataChannel`,
`ssmmessages:OpenControlChannel` and `ssmmessages:OpenDataChannel`. For port forwarding through a task see
`forward` below.

## forward

```bash
ssm-commander forward --target bastion --remote-host db.internal --remote-port 5432 --local-port 15432 --save prod-db
ssm-commander forward prod-db              # reuse the saved preset, no prompts
ssm-commander forward                      # pick the instance and answer the prompts
ssm-commander forward --list
ssm-commander forward --delete prod-db
ssm-commander forward --target ecs:prod/api --remote-host localhost --remote-port 8080 --local-port 18080 --save api-local
ssm-commander forward --ecs                # pick cluster, service and task from lists, then answer the prompts
```

`--remote-host localhost` forwards a port of the instance itself. Values you do not pass are prompted for, and
after such a run the equivalent command line is printed so that the next one needs no prompts. With
a preset name, options given alongside override the saved values for that run. `--list` and `--delete` cannot be
combined, nor can `--ecs` and `--target` (write the task as `--target ecs:...` instead).
Press Ctrl+C to stop forwarding. If the local port is already taken (an earlier forward still running in another
terminal, for example), the command stops with `Local port <n> is already in use` before opening a session.

The tunnel can also go through an ECS task: `--target ecs:cluster/service` (or `ecs:cluster/service/task-id`,
or `--ecs` to pick from lists) uses the same selection as `exec`, so the task needs ECS Exec enabled. `localhost`
then means the task itself, so `--remote-port 8080` reaches the container's port 8080, and another host is
reached from the task's network (a Fargate task as a bastion for RDS, for example). A preset saved this way
remembers the cluster and service and goes through the newest reachable task each time it runs.

## ssh and scp

Argument order for `ssh`: ssm-commander's own options (`--profile`, `--region`, `--user`, `--identity`,
`--port`, `--connectable`) first, then the target, then ssh's own options and the remote command, exactly as you
would write them for `ssh` itself. Everything after the target is passed through unchanged, so `-o ...`, port
forwards and remote commands with their own flags all work. The target may be written as `user@name`. The default
login name follows the platform that Systems Manager reports for the instance: `ubuntu` on Ubuntu, `admin` on Debian
and `ec2-user` otherwise (also when the platform is unknown); `--user` overrides it, and `user@` overrides both.
When ssh fails with its own exit code 255 and the name was a default, a hint says which name was tried. For `scp`,
exactly one side of the transfer is `[user@]instance:path`, where `instance` is a Name tag or instance id. Put
scp's own flags (`-r`, `-o ...`) before the two paths, as `scp` itself requires; after the paths scp would read them
as file names. Both commands take `--profile` and `--region` written in full: `-p` and `-r` belong to ssh and scp
themselves, and a `-p <profile>` is caught with a hint wherever it lands.

Under the hood both commands run the system `ssh`/`scp` with a `ProxyCommand` that calls a hidden
`ssm-commander proxy` subcommand, which opens an `AWS-StartSSHSession` through Session Manager. Host keys are
recorded under the instance id.

## doctor

Checks Node.js, session-manager-plugin (path and version), your AWS config files and, with `--profile`, that the
credentials work (STS GetCallerIdentity). With `--ecs cluster/service` (or `cluster/service/task-id`) it also
checks what ECS Exec needs on the service's newest task: execute command enabled on the service and the task, a
Fargate platform version of 1.4.0 or newer, a running ExecuteCommandAgent, and a task role that IAM confirms may
use the `ssmmessages` channel actions (`iam:SimulatePrincipalPolicy`; shown as `!` when that call is not allowed).
Exit code 1 if anything fails.

## Profile and region resolution

- Profile: `-p/--profile` → `AWS_PROFILE` → prompt (skipped when only one profile exists).
- Region: `-r/--region` → `AWS_REGION` / `AWS_DEFAULT_REGION` → the profile's `region` → prompt.

MFA-protected `assume-role` profiles prompt for the code in `connect`, `exec`, `forward` and `doctor`; `ssh` and `scp`
cannot prompt (the SSH data channel occupies stdin), so use them with profiles that need no MFA code. SSO profiles
work while their token is valid; this tool does not run the SSO login itself. Without a terminal (a pipe, a script),
anything that would prompt fails with a message naming what was needed and the option that avoids it.

## Working with narrow permissions

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
which Session Manager accepts for tasks that have ECS Exec enabled. A port of the instance or task itself is
forwarded with `AWS-StartPortForwardingSession`; any other host with `AWS-StartPortForwardingSessionToRemoteHost`.

## Files and environment variables

- `~/.ssm-commander/history.json`: recent connections: EC2 instances (profile, region, instance id and name) and
  ECS services (profile, region, cluster and service).
- `~/.ssm-commander/presets.json`: saved port-forwarding presets.
- Both are created with mode 0600 and never contain credentials or tokens.
- `SSM_COMMANDER_HOME`: use another directory for the files above.
- `SSM_COMMANDER_PLUGIN_PATH`: explicit path to session-manager-plugin. When the file is not there the command fails
  instead of silently using the plugin on `PATH`, and `doctor` reports it.
- `SSM_COMMANDER_DEBUG=1`: print stack traces for unexpected errors. The equivalent `--debug` flag goes anywhere among
  the options, before or after the command name (for `ssh` and `scp`, before the target).
- Upgrading from 0.1: the old saved-command file `~/.ssm-commander/config.json` is no longer read. It is left
  untouched and can be deleted.

## Platform support

Verified on macOS; Linux uses the same code paths. Windows: untested. The code looks for
`session-manager-plugin.exe` and never goes through a shell, but ssh/scp ProxyCommand quoting and signal handling
have not been exercised there.

## Troubleshooting

- **`Permission denied (publickey)` from ssh or scp.** Either the login name or the key. The default name follows
  the platform (`ubuntu`, `admin`, `ec2-user`); pass `--user <name>` or `name@target` for an AMI with another one.
  The key must be in that user's `authorized_keys` on the instance, and a key file given with `-i` must be readable
  by you alone (`chmod 600`).
- **`The instance is not connected to Systems Manager` (TargetNotConnected).** The SSM agent is not online: the
  instance is stopped, has no agent, or its instance profile lacks the Session Manager permissions. The table shows
  the reason in the Note column; the agent status is under Systems Manager → Fleet Manager in the console.
- **`Local port <n> is already in use`.** Another forward (perhaps in another terminal) or another program listens
  there. Pass another `--local-port`, or stop the other process.
- **`session-manager-plugin was not found on PATH`.** Install it (see the README) or point
  `SSM_COMMANDER_PLUGIN_PATH` at the executable; the variable must name a file that exists.
- **`Could not reach AWS (ENOTFOUND)`.** A region name that does not exist makes an endpoint name that does not
  resolve; check `--region` and the profile's region before suspecting the network.
- **The terminal misbehaves after a session (no echo, Ctrl+C ignored).** Run `stty sane`. The plugin restores the
  terminal when it exits normally; a session killed from outside can leave it in raw mode.
- **`exec` says the container is not reachable through ECS Exec.** `ssm-commander doctor -p <profile> --ecs
  <cluster>/<service>` checks each prerequisite: execute command on the service and the task, the platform version,
  the agent, and the `ssmmessages` actions of the task role.
- **`... needs an interactive terminal`.** The command runs behind a pipe or in a script; the message names the
  option that replaces the prompt (`--profile`, `--region`, the target, `--remote-host` and so on).

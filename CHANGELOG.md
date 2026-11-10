# Changelog

Notable changes to ssm-commander. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 2.0.0 - 2026-11-11

The first word after `ssm-commander` is now always a command. One way of writing `connect` stops working, hence the
new major version; every command line shown in the README works as before.

### Added

- `-p`/`--profile` and `-r`/`--region` before the command: `ssm-commander -p prod exec` is `ssm-commander exec -p
  prod`. There they used to be options of `connect`, so the command after them was looked up as an instance
  (`ssm-commander -p prod exec`) or refused as an argument too many (`ssm-commander -p prod connect web-1`).
- `forward --ecs cluster/service[/task-id]`: `--ecs` takes the task to go through, as `--target ecs:...` does, and
  still picks from lists without a value. `ssm-commander forward --ecs prod/api` used to look for a preset named
  `prod/api`.
- The `ecs:` prefix of `forward --target` is accepted by `exec` and `doctor --ecs` as well (`ssm-commander exec
  ecs:prod/api`), so an ECS target is written the same way in every command.

### Changed

- `ssm-commander --help` lists `ssh` and `scp` with one line each; their notes on argument order are in
  `ssm-commander ssh --help` and `ssm-commander scp --help`.
- Hints say more: an unknown preset name in `forward` shows how an instance or a service of that name is written
  (`--target`, `--ecs`), `-p` after `ssh` is answered with `-p` before `ssh` as well as `--profile`, and a
  mistyped command also shows the `connect` form in case the word was a target.

### Removed

- A target without its command. `ssm-commander web-1` used to mean `ssm-commander connect web-1`; now it fails at
  once with `Unknown command "web-1"` and a hint showing the `connect` and `exec` forms. With ECS in the tool a bare
  name could be an instance or a service, and only instances were searched. Without a command `connect` still runs,
  taking options only (`ssm-commander`, `ssm-commander -p prod`).

### Fixed

- A mistyped command (`ssm-commander exsec`) is reported at once with the closest command. It used to be taken for
  an instance name first: the profile (and, where needed, the region and an MFA code) was asked for and the
  instances were listed before the error appeared, and with arguments after it the error was about `connect`
  (`too many arguments for 'connect'`, `unknown option '--list'`).
- A command written after an option of its own (`ssm-commander --connectable exec`) is told to come first, with the
  line to write, instead of being looked up as an instance named `exec`.

## 1.0.0 - 2026-11-08

A rewrite. 0.1 wrapped the AWS CLI: it stored `aws ssm` command lines and replayed them. 1.0.0 calls AWS through
the SDK and starts `session-manager-plugin` itself, the way the AWS CLI does, so the AWS CLI is no longer needed.
The same contents were published as 0.2.0 earlier the same day; 1.0.0 is that release under its final number.

### Added

- `connect`, the default command: profile, region (when the profile has none) and instance are picked from
  searchable tables, or the instance is named on the command line by Name tag or id. Instances that cannot be
  connected are shown dimmed with the reason.
- `exec`: an interactive command in an ECS container through ECS Exec, with cluster, service, task and container
  picked from tables or given as `cluster/service[/task-id]`.
- `forward`: port forwarding through an instance or an ECS task, with named presets (`--save`, `--list`,
  `--delete`). After an interactive run the equivalent command line is printed.
- `ssh` and `scp` through Session Manager, with the instance named by its Name tag; the login name follows the
  platform of the instance.
- `doctor`: checks Node.js, the plugin, the AWS config files, the credentials of a profile and, with `--ecs`,
  the ECS Exec prerequisites of a service.
- Connection history: instances and ECS services used before come first in the tables, marked `*`.
- MFA-protected profiles (`connect`, `exec`, `forward`, `doctor`) and SSO profiles with a valid token.
- Narrow permissions: an instance id still connects when `ec2:DescribeInstances` is denied, and
  `exec --cluster --task` needs only `ecs:DescribeTasks` and `ecs:ExecuteCommand`.

### Changed

- Runs on Node.js 22 or newer as a single bundle without runtime dependencies (0.1 ran on Bun).
- Prompts, progress and messages go to stderr; stdout is left to the session.

### Removed

- The `create`, `list` and `run` commands of 0.1 and the command lines they saved. `~/.ssm-commander/config.json`
  is no longer read; it is left in place and can be deleted. Port-forwarding presets replace saved command lines
  for the case that needed them; a plain shell needs nothing saved.

## 0.1.0

The original tool, available from GitHub only: saved `aws ssm` command lines (`create`, `list`, `run`) behind
interactive prompts, running on Bun and requiring the AWS CLI.

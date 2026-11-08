# Changelog

Notable changes to ssm-commander. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.2.0 (not yet published)

A rewrite. 0.1 wrapped the AWS CLI: it stored `aws ssm` command lines and replayed them. 0.2.0 calls AWS through
the SDK and starts `session-manager-plugin` itself, the way the AWS CLI does, so the AWS CLI is no longer needed.

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

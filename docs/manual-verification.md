# Manual verification checklist

Automated tests cover the logic with fakes; these steps exercise the real session-manager-plugin, AWS APIs and
terminals. Run them before a release, against a profile with two instances you can reach (one Ubuntu, one Amazon
Linux work well) and, for `exec`, an ECS service with `enableExecuteCommand` on.

## Test environment

`test-infra/ssm-commander-test.yaml` is a CloudFormation template that creates everything these steps need and
nothing the account keeps: a VPC of its own with one public subnet, two `t3.micro` instances (Ubuntu 24.04 and
Amazon Linux 2023) registered with Systems Manager, and a Fargate cluster with the service `api` (nginx, execute
command on) plus, by default, `noexec` (execute command off) and `noperm` (task role without the `ssmmessages`
actions) for the doctor checks. `test-infra/stack.sh` wraps the AWS CLI calls:

```bash
sh test-infra/stack.sh up -p <profile> -r <region> KeyName=<key pair>   # about 3 minutes; KeyName only for ssh/scp
sh test-infra/stack.sh outputs -p <profile> -r <region>                 # the names used below
sh test-infra/stack.sh down -p <profile> -r <region>                    # deletes everything, about 5 minutes
```

Parameters (`Key=Value` after `up`): `NamePrefix` (default `ssm-commander-test`; the instances are named
`<prefix>-ubuntu` and `<prefix>-al2023`, the cluster `<prefix>`), `CreateEc2` and `CreateEcs` (`false` skips that
half), `EcsFixtures=minimal` (the `api` service only), `InstanceType` with matching `UbuntuAmi` and
`AmazonLinuxAmi` for arm64 types. For the ssh and scp steps pass the key after the target, with the file in mode
0600 (ssh ignores a key other users can read): `ssm-commander ssh --profile <profile> ubuntu@<prefix>-ubuntu -i
<key.pem>`. While the stack is up, the instances fall inside the 12-month free tier, but
Fargate has none: the three services and the public IPv4 addresses together cost a few cents per hour, so delete
the stack when you are done. If the first `up` in an account fails on a service with "Unable to assume the service
linked role", ECS was still creating its service-linked role; run `up` again.

## EC2 (connect, forward, ssh, scp)

- [ ] `ssm-commander doctor -p <profile>` prints ✔ on every line.
- [ ] `ssm-commander connect <name> -p <profile>` opens a shell; `echo ok` prints `ok`; `exit` ends the session
  and the plugin prints `Exiting session with sessionId`.
- [ ] `ssm-commander connect -p <profile>` lists instances with State and SSM columns; the one you just used is
  marked `*`; non-connectable rows are dimmed with a reason and cannot be selected.
- [ ] `ssm-commander connect <stopped-instance-name> -p <profile>` fails with `cannot be connected: stopped` (the
  test-infra stack creates running instances only: stop one first with `aws ec2 stop-instances`).
- [ ] `ssm-commander connect --connectable -p <profile>` hides the non-connectable rows.
- [ ] `ssm-commander connect <NAME-IN-ANOTHER-CASE> -p <profile>` connects all the same (names match ignoring case).
- [ ] `ssm-commander connect i-0123456789abcdef0 -p <profile>` fails at once with `was not found in <region>
  (profile <profile>)` and does not open the list; `ssm-commander connect no-such-name -p <profile> < /dev/null`
  prints one line naming the region and profile.
- [ ] `ssm-commander conect -p <profile>` prints `Unknown command "conect"` with the `Did you mean` hint.
- [ ] In a 70-column terminal, `ssm-commander connect -p <profile>` shows the table without wrapped lines (the Public
  IP, Type and Private IP columns are gone and long names end in `…`), with `(type to search, ↑↓ to move, Enter to
  select)` under it.
- [ ] `ssm-commander connect --debug -p <profile> -r nowhere-1` fails with `Could not reach AWS (ENOTFOUND)`, a hint
  naming the region, and a stack trace (`--debug` after the command name works).
- [ ] `SSM_COMMANDER_PLUGIN_PATH=/nope ssm-commander doctor` prints ✘ for the plugin with that path, and `connect`
  with the same variable fails before any session is opened.
- [ ] `ssm-commander forward --list --delete x` and `ssm-commander forward --ecs --target <name> --remote-host localhost --remote-port 22 --local-port 2222`
  fail with `cannot be combined`; `--local-port abc` names the option in its error.
- [ ] `ssm-commander forward -p <profile> --target <name> --remote-host localhost --remote-port 22 --local-port 2222 --save t`
  then, in another terminal, `ssh -p 2222 <user>@localhost hostname` prints the hostname; Ctrl+C stops the
  forward; `ssm-commander forward t` starts again without prompts; `ssm-commander forward --list` shows `t`.
- [ ] `ssm-commander ssh --profile <profile> <ubuntu-name> whoami` prints `ubuntu` without `--user` (the login name
  follows the platform), `ssm-commander ssh --profile <profile> <amazon-linux-name> whoami` prints `ec2-user`, and
  `--user admin` or `admin@<name>` wins over the default.
- [ ] `ssm-commander ssh -p <profile> <name>` and `ssm-commander ssh --profile <profile> <name> -p <profile> hostname`
  both stop with a hint about `--profile` before any AWS call.
- [ ] `ssm-commander scp --profile <profile> ./file user@<name>:/tmp/file` followed by the download in the other
  direction gives an identical file; `-r` copies a directory.
- [ ] Inside a session, Ctrl+C interrupts the remote command (try `sleep 30`) and ssm-commander keeps running.
- [ ] Ctrl+C pressed right after `ssm-commander connect -p <profile>` starts (while the spinner runs) ends the
  command with exit code 130 and leaves the terminal usable: `stty -a` still lists `isig`, and a later Ctrl+C
  stops `forward`.
- [ ] `ssm-commander forward <preset>` while the same preset is still running in another terminal fails at once
  with `Local port <n> is already in use` instead of hanging.
- [ ] After every session no `session-manager-plugin` process is left behind (`pgrep session-manager-plugin`).

## ECS (exec)

- [ ] `ssm-commander exec -p <profile>` shows the cluster table (or uses the only cluster), then the service table
  where a service without ECS Exec is dimmed with `exec disabled`, then the task table (or uses the only task),
  and opens a shell in the container; `hostname` prints the task's hostname; `exit` ends the session.
- [ ] Running `ssm-commander exec -p <profile>` again lists the cluster and the service of that session first,
  marked with `*`; `~/.ssm-commander/history.json` gained an entry with `"kind": "ecs"` and the service, not the
  task id. `ssm-commander forward -p <profile> --ecs` shows the same marks.
- [ ] `ssm-commander exec -p <profile> --cluster <cluster> --task <task-id>` opens the shell directly, without
  listing clusters or services.
- [ ] `ssm-commander exec -p <profile> <cluster>/<service-without-exec>` fails with `cannot be reached: exec disabled`.
- [ ] `ssm-commander exec -p <profile> --connectable` skips the services that cannot be reached.
- [ ] Inside the container shell, Ctrl+C interrupts the remote command (try `sleep 30`).
- [ ] `ssm-commander forward -p <profile> --target ecs:<cluster>/<service> --remote-host localhost --remote-port <container-port> --local-port 18080 --save t2`
  opens the tunnel; `curl localhost:18080` answers from the container; Ctrl+C stops it; `ssm-commander forward t2`
  runs again without prompts and names the task it went through.
- [ ] After every session no `session-manager-plugin` process is left behind (`pgrep session-manager-plugin`).
- [ ] `ssm-commander doctor -p <profile> --ecs <cluster>/<service>` prints ✔ for the service, task, exec agent and
  task role of a working service, and ✘ with the `update-service` hint for a service without execute command.

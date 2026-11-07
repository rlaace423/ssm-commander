# Manual verification checklist

Automated tests cover the logic with fakes; these steps exercise the real session-manager-plugin, AWS APIs and
terminals. Run them before a release, against a profile with two instances you can reach (one Ubuntu, one Amazon
Linux work well) and, for `exec`, an ECS service with `enableExecuteCommand` on.

## EC2 (connect, forward, ssh, scp)

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

## ECS (exec)

- [ ] `ssm-commander exec -p <profile>` shows the cluster table (or uses the only cluster), then the service table
  where a service without ECS Exec is dimmed with `exec disabled`, then the task table (or uses the only task),
  and opens a shell in the container; `hostname` prints the task's hostname; `exit` ends the session.
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

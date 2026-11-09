#!/usr/bin/env bash
# One-off disposable GitHub-hosted VM experiment; never run against a fleet user.
set -euo pipefail
probe_user="maskprobe${GITHUB_RUN_ID:-$$}"
useradd -m "$probe_user"
loginctl enable-linger "$probe_user"
uid=$(id -u "$probe_user")
probe_home=$(getent passwd "$probe_user" | cut -d: -f6)
for _ in {1..30}; do
  test -S "/run/user/$uid/bus" && break
  sleep 1
done
test -S "/run/user/$uid/bus" || { echo 'UNSUPPORTED: no user manager bus'; exit 1; }
ctl() { runuser -u "$probe_user" -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user "$@"; }
dir="$probe_home/.config/systemd/user"
mkdir -p "$dir" "$probe_home/state"
cat > "$dir/probe.service" <<UNIT
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo run >> $probe_home/state/runs; sleep 3'
UNIT
cat > "$dir/probe.timer" <<'UNIT'
[Timer]
OnActiveSec=1h
Unit=probe.service
[Install]
WantedBy=timers.target
UNIT
cat > "$dir/probe.path" <<UNIT
[Path]
PathChanged=$probe_home/state/watched
Unit=probe.service
[Install]
WantedBy=default.target
UNIT
cat > "$dir/probe-dependency.service" <<'UNIT'
[Unit]
Requires=probe.service
After=probe.service
[Service]
Type=oneshot
ExecStart=/bin/true
UNIT
chown -R "$probe_user:$probe_user" "$probe_home/.config" "$probe_home/state"
ctl --version | head -1
ctl daemon-reload
ctl enable probe.timer
ctl start probe.path
ctl is-enabled probe.timer
ctl is-active probe.path
cp -p "$dir/probe.service" "$probe_home/state/original"
mask() {
  ln -s /dev/null "$dir/.probe-mask"
  mv -Tf "$dir/.probe-mask" "$dir/probe.service"
  ctl daemon-reload
}
restore() {
  cp -p "$probe_home/state/original" "$dir/.probe-restore"
  mv -Tf "$dir/.probe-restore" "$dir/probe.service"
  ctl daemon-reload
}
mask
ctl stop probe.path
ctl stop probe.service
if ctl start probe.service; then echo 'FAIL direct start accepted'; exit 1; fi
if ctl start probe-dependency.service; then echo 'FAIL dependency start accepted'; exit 1; fi
test ! -e "$probe_home/state/runs"
restore
ctl start probe.service &
start_pid=$!
sleep 1
mask
ctl stop probe.service
wait "$start_pid" || true
ctl show probe.service -p ActiveState -p SubState -p Job -p LoadState
before=$(wc -l < "$probe_home/state/runs")
if ctl start probe.service; then echo 'FAIL start after in-flight stop'; exit 1; fi
test "$(wc -l < "$probe_home/state/runs")" = "$before"
# Repeat recovery from a retained mask; leave enablement links untouched.
for _ in 1 2; do
  restore
  cmp "$probe_home/state/original" "$dir/probe.service"
  ctl is-enabled probe.timer
  ctl start probe.path
  ctl is-active probe.path
  ctl stop probe.path
  mask
done
restore
ctl start probe.path
ctl is-active probe.path
ctl is-enabled probe.timer
ctl is-active probe.timer && { echo 'FAIL timer became active'; exit 1; }
ctl start probe.service
printf 'PASS: direct/dependency mask, in-flight stop, repeated restoration, mixed activation\n'
printf 'Initial primitive restoration checks complete\n'
# A queued target waits behind a synthetic oneshot ordering dependency.
cat > "$dir/probe-blocker.service" <<'UNIT'
[Service]
Type=oneshot
ExecStart=/bin/sleep 12
UNIT
mkdir -p "$dir/probe.service.d"
cat > "$dir/probe.service.d/queue.conf" <<'UNIT'
[Unit]
Requires=probe-blocker.service
After=probe-blocker.service
UNIT
chown -R "$probe_user:$probe_user" "$dir/probe.service.d" "$dir/probe-blocker.service"
ctl daemon-reload
ctl start --no-block probe.service
sleep 1
queued=$(ctl show probe.service -p Job --value)
test -n "$queued" || { echo 'FAIL target job was not queued'; exit 1; }
echo "QUEUED before mask: $queued"
before=$(wc -l < "$probe_home/state/runs")
mask
ctl show probe.service -p LoadState -p ActiveState -p Job
sleep 14
echo "RELEASE without stop: runs before=$before after=$(wc -l < "$probe_home/state/runs")"
ctl show probe.service -p LoadState -p ActiveState -p Job -p Result
ctl stop probe.service probe-blocker.service
restore
ctl reset-failed probe.service probe-blocker.service
ctl start --no-block probe.service
sleep 1
queued=$(ctl show probe.service -p Job --value)
test -n "$queued" || { echo 'FAIL second target job was not queued'; exit 1; }
before=$(wc -l < "$probe_home/state/runs")
mask
ctl stop probe.service
ctl show probe.service -p LoadState -p ActiveState -p Job
sleep 14
test "$(wc -l < "$probe_home/state/runs")" = "$before" || { echo 'FAIL drained job ran'; exit 1; }
echo 'PASS stop queued target then allow blocker to complete: no target run'
ctl stop probe-blocker.service
ctl show probe.service -p LoadState -p ActiveState -p Job
restore
mv "$dir/probe.service.d/queue.conf" "$probe_home/state/queue.conf"
ctl daemon-reload
# Concurrent start attempts during masking: report count; then assert fence after reload.
for _ in {1..15}; do ctl start --no-block probe.service >/dev/null 2>&1 || true; done &
racer=$!
mask
wait "$racer"
ctl stop probe.service
before=$(wc -l < "$probe_home/state/runs")
for _ in {1..5}; do
  if ctl start --no-block probe.service; then echo 'FAIL masked race follow-up accepted'; exit 1; fi
done
test "$(wc -l < "$probe_home/state/runs")" = "$before"
echo 'PASS race followed by masked rejection and drain'
restore
# Recover twice after real SIGKILL at each durable transition.
for boundary in intent mask reload drain restore unmask; do
  set +e
  python3 scripts/systemd-mask-crash-probe.py "$probe_home" "$probe_user" "$uid" "$boundary"
  result=$?
  set -e
  test "$result" -eq 137 || { echo "FAIL crash $boundary exit $result"; exit 1; }
  for _ in 1 2; do
    python3 scripts/systemd-mask-crash-probe.py "$probe_home" "$probe_user" "$uid" recover
    cmp "$probe_home/state/original" "$dir/probe.service"
    ctl is-active probe.path
    ctl is-enabled probe.timer
    if ctl is-active --quiet probe.timer; then echo 'FAIL timer active'; exit 1; fi
  done
  echo "PASS SIGKILL recovery $boundary"
done
# Restart the disposable user's manager while masked, not the VM.
mask
echo 'MANAGER ENVIRONMENT BEFORE RESTART (selected paths only)'
ctl show-environment | rg '^(HOME|XDG_(CONFIG_HOME|DATA_HOME|RUNTIME_DIR)|DBUS_SESSION_BUS_ADDRESS)=' || true
ctl cat dbus.socket gpg-agent-ssh.socket || true
ctl show dbus.socket gpg-agent-ssh.socket -p FragmentPath -p DropInPaths -p Before -p After -p Requires -p Wants -p ExecStartPre -p ExecStartPost -p ActiveState -p SubState || true
systemctl cat "user@$uid.service" || true
systemctl restart "user@$uid.service" &
restart_pid=$!
sleep 10
echo 'MANAGER STARTUP SAMPLE'
systemctl show "user@$uid.service" -p ActiveState -p SubState -p Result -p MainPID -p ControlGroup || true
ps -u "$probe_user" -o pid,ppid,state,wchan:24,args || true
manager_pid=$(systemctl show "user@$uid.service" -p MainPID --value)
if test "$manager_pid" != 0 && test -r "/proc/$manager_pid/environ"; then
  tr '\0' '\n' < "/proc/$manager_pid/environ" | rg '^(HOME|XDG_(CONFIG_HOME|DATA_HOME|RUNTIME_DIR)|DBUS_SESSION_BUS_ADDRESS)=' || true
fi
timeout 3 runuser -u "$probe_user" -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user list-jobs --no-pager || true
ls -la "/run/user/$uid" "/run/user/$uid/bus" || true
if ! wait "$restart_pid"; then
  echo 'RESTART DIAGNOSTICS'
  systemctl status "user@$uid.service" --no-pager -l || true
  systemctl show "user@$uid.service" -p ActiveState -p SubState -p Result -p TimeoutStopUSec -p ControlGroup -p MainPID || true
  journalctl -u "user@$uid.service" --no-pager -n 100 || true
  ps -u "$probe_user" -o pid,ppid,state,args || true
  ls -la "/run/user/$uid" "/run/user/$uid/bus" || true
  exit 1
fi
for _ in {1..30}; do ctl show-environment >/dev/null 2>&1 && break; sleep 1; done
ctl show probe.service -p LoadState
if ctl start probe.service; then echo 'FAIL mask after manager restart'; exit 1; fi
restore
ctl start probe.service
echo 'PASS user-manager restart with persistent mask; NOT a machine reboot'

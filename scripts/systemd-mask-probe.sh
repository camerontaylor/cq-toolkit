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
printf 'NOT TESTED: queued start race, crash boundaries, manager restart, reboot, power loss\n'

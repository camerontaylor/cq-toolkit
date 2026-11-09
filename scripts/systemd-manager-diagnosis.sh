#!/usr/bin/env bash
# Disposable hosted VM only: compare user-manager startup environments.
set -uo pipefail
filter='^(HOME|USER|LOGNAME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)='
for mode in inherited hermetic; do
  user="diag${mode}${$}"
  useradd -m "$user" || exit 1
  uid=$(id -u "$user")
  user_home=$(getent passwd "$user" | cut -d: -f6)
  if test "$mode" = hermetic; then
    systemctl set-environment "HOME=$user_home" "USER=$user" "LOGNAME=$user" "XDG_CONFIG_HOME=$user_home/.config" "XDG_DATA_HOME=$user_home/.local/share" "XDG_RUNTIME_DIR=/run/user/$uid" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus"
  fi
  loginctl enable-linger "$user" || exit 1
  for _ in {1..45}; do test -S "/run/user/$uid/bus" && break; sleep 1; done
  ctl() { runuser -u "$user" -- env HOME="$user_home" USER="$user" LOGNAME="$user" XDG_CONFIG_HOME="$user_home/.config" XDG_DATA_HOME="$user_home/.local/share" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user "$@"; }
  echo "CASE $mode uid=$uid home=$user_home"
  systemctl show "user@$uid.service" -p ActiveState -p SubState -p MainPID -p Result
  ctl show-environment 2>/dev/null | rg "$filter" || true
  ctl cat dbus.socket gpg-agent-ssh.socket || true
  ctl show dbus.socket gpg-agent-ssh.socket -p FragmentPath -p DropInPaths -p Before -p After -p Requires -p Wants -p Listen -p ExecStartPre -p ExecStartPost -p ActiveState -p SubState || true
  ls -ld "$user_home" "/run/user/$uid" "/run/user/$uid/bus" || true
  systemctl restart "user@$uid.service" & restart_pid=$!
  sleep 10
  echo "CASE $mode startup sample"
  systemctl show "user@$uid.service" -p ActiveState -p SubState -p MainPID -p Result
  ps -u "$user" -o pid,ppid,state,wchan:24,args || true
  pid=$(systemctl show "user@$uid.service" -p MainPID --value)
  if test "$pid" != 0 && test -r "/proc/$pid/environ"; then tr '\0' '\n' < "/proc/$pid/environ" | rg "$filter" || true; fi
  timeout 3 runuser -u "$user" -- env HOME="$user_home" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user list-jobs --no-pager || true
  ls -ld "$user_home" "/run/user/$uid" "/run/user/$uid/bus" || true
  if wait "$restart_pid"; then echo "CASE $mode restart PASS"; else echo "CASE $mode restart FAILED"; fi
  journalctl -u "user@$uid.service" --no-pager -n 100 || true
  if test "$mode" = hermetic; then systemctl unset-environment HOME USER LOGNAME XDG_CONFIG_HOME XDG_DATA_HOME XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS; fi
done
echo 'No machine reboot tested.'

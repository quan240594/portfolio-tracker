#!/usr/bin/env bash
# Source this file (`. scripts/use-supported-node.sh`) to make sure `node` is a version the test suite supports.
#
# CI runs Node 22 (.nvmrc). The web tests fail on Node >= 24 (fetch/AbortController behaviour differs), so a
# developer machine whose default Node is newer would fail the pre-push hook for no real reason. If the current
# `node` is not 22 or 20, prepend the newest installed 22/20 (nvm or Homebrew) that actually runs on this CPU.
# Does nothing when the current Node is fine; warns (never fails) when no supported Node is installed.

_node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true; }
# The CPU the machine really has. `uname -m` is wrong when this runs under Rosetta (e.g. spawned by an Intel build of
# git, which is what the pre-push hook is), so ask the kernel whether arm64 is available.
_native_arch() {
  if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" = "1" ]; then echo arm64; else uname -m | sed 's/x86_64/x64/'; fi
}
_node_runs_natively() {
  local have
  have="$("$1" -p 'process.arch' 2>/dev/null || true)"
  [ -n "$have" ] && [ "$have" = "$(_native_arch)" ]
}

_current_major="$(_node_major node)"
if [ "$_current_major" != "22" ] && [ "$_current_major" != "20" ]; then
  _found=""
  for _major in 22 20; do
    for _candidate in \
      $(find "$HOME/.nvm/versions/node" -maxdepth 3 -path "*/v$_major.*/bin/node" 2>/dev/null | sort -V -r) \
      /opt/homebrew/opt/node@"$_major"/bin/node \
      /usr/local/opt/node@"$_major"/bin/node; do
      [ -x "$_candidate" ] || continue
      if [ "$(_node_major "$_candidate")" = "$_major" ] && _node_runs_natively "$_candidate"; then
        _found="$_candidate"
        break 2
      fi
    done
  done
  if [ -n "$_found" ]; then
    PATH="$(dirname "$_found"):$PATH"
    export PATH
    echo "use-supported-node: using $("$_found" -v) from $(dirname "$_found") (default node is v${_current_major:-unknown})" >&2
  else
    echo "use-supported-node: no Node 22/20 found (default is v${_current_major:-unknown}); tests may fail on Node >= 24" >&2
  fi
  unset _found _major _candidate
fi
unset _current_major

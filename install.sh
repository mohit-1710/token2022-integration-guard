#!/usr/bin/env bash
# Installer for the token2022-integration-guard skill.
# Copies the skill + agent + commands + rules into a Claude Code config dir.
set -euo pipefail

SKILL_NAME="token2022-integration-guard"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<EOF
Install the ${SKILL_NAME} skill.

Usage:
  ./install.sh [--project] [--dir <path>] [-y] [--help]

Targets (pick one):
  (default)      Personal:  ~/.claude
  --project      Project:   ./.claude   (current repo)
  --dir <path>   Custom:    <path>/.claude  is NOT assumed; installs into <path> directly

Options:
  -y, --yes      Non-interactive (assume yes)
  -h, --help     Show this help

Installs:
  skill/*    -> <config>/skills/${SKILL_NAME}/
  agents/*   -> <config>/agents/
  commands/* -> <config>/commands/
  rules/*    -> <config>/rules/
EOF
}

TARGET=""
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project) TARGET="$(pwd)/.claude" ;;
    --dir) shift; TARGET="$1" ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
  shift
done
[ -z "$TARGET" ] && TARGET="$HOME/.claude"

echo "Installing ${SKILL_NAME} into: ${TARGET}"
if [ "$ASSUME_YES" -ne 1 ]; then
  printf "Continue? [y/N] "
  read -r reply
  case "$reply" in [yY]*) ;; *) echo "Aborted."; exit 0 ;; esac
fi

mkdir -p "$TARGET/skills/$SKILL_NAME" "$TARGET/agents" "$TARGET/commands" "$TARGET/rules"

cp -R "$SRC_DIR/skill/." "$TARGET/skills/$SKILL_NAME/"
[ -d "$SRC_DIR/agents" ]   && cp -R "$SRC_DIR/agents/."   "$TARGET/agents/"
[ -d "$SRC_DIR/commands" ] && cp -R "$SRC_DIR/commands/." "$TARGET/commands/"
[ -d "$SRC_DIR/rules" ]    && cp -R "$SRC_DIR/rules/."    "$TARGET/rules/"

echo "Done."
echo "  skill   -> $TARGET/skills/$SKILL_NAME/SKILL.md"
echo "  agent   -> $TARGET/agents/token2022-integration-auditor.md"
echo "  cmds    -> $TARGET/commands/{scan-mint,audit-t22-integration}.md"
echo "  rules   -> $TARGET/rules/token2022-integration.md"
echo ""
echo "The runnable scanner (tools/t22-scan) and reference program (examples/guard)"
echo "stay in this repo — see README.md to run them."

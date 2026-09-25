#!/usr/bin/env sh
# Install Pi (if missing) and the pi-verboo-provider package.
#
# Works on POSIX sh (dash, bash, zsh) on macOS and Linux.
# Usage:
#   sh install.sh
#   VERBOO_PI_SOURCE=npm:@ivan-cavero/pi-verboo-provider sh install.sh
#
# This script never handles your API key and never runs sudo.

set -eu

NPM_PACKAGE="npm:@ivan-cavero/pi-verboo-provider"
GIT_SOURCE="git:github.com/ivan-cavero/pi-verboo-provider"
PI_PACKAGE="@earendil-works/pi-coding-agent"

print_usage() {
	cat <<'EOF'
Install Pi (if missing) and the pi-verboo-provider package.

Usage:
  sh install.sh

Environment:
  VERBOO_PI_SOURCE   Override the source passed to `pi install`.
                     Default: npm:@ivan-cavero/pi-verboo-provider when the npm
                     registry has it, otherwise git:github.com/ivan-cavero/pi-verboo-provider.

After install:
  export VERBOO_API_KEY=...   # or run /login verboo inside pi
  pi --list-models verboo
EOF
}

case "${1:-}" in
	-h | --help)
		print_usage
		exit 0
		;;
	"") ;;
	*)
		printf 'Unknown argument: %s\n\n' "$1" >&2
		print_usage >&2
		exit 2
		;;
esac

# Prefer the published npm package, but only when the registry actually has it.
# Fall back to the git source otherwise. Never guess.
resolve_source() {
	if [ -n "${VERBOO_PI_SOURCE:-}" ]; then
		printf '%s\n' "$VERBOO_PI_SOURCE"
		return 0
	fi
	if command -v npm >/dev/null 2>&1; then
		if npm view "${NPM_PACKAGE#npm:}" version --silent >/dev/null 2>&1; then
			printf '%s\n' "$NPM_PACKAGE"
			return 0
		fi
	fi
	printf '%s\n' "$GIT_SOURCE"
}

SOURCE="$(resolve_source)"
printf 'Resolved source: %s\n' "$SOURCE"
if [ -z "${VERBOO_PI_SOURCE:-}" ] && [ "$SOURCE" = "$GIT_SOURCE" ]; then
	printf 'The npm package is not available (unpublished or npm unavailable); using the git source.\n'
fi

if ! command -v pi >/dev/null 2>&1; then
	printf 'pi is not on PATH; installing Pi...\n'
	if ! command -v npm >/dev/null 2>&1; then
		printf 'Error: pi is not installed and npm was not found. Install Node.js (which includes npm), then re-run this script.\n' >&2
		exit 1
	fi
	if ! install_output=$(npm install -g --ignore-scripts "$PI_PACKAGE" 2>&1); then
		printf 'Error: failed to install Pi.\n' >&2
		printf '%s\n' "$install_output" >&2
		case "$install_output" in
			*EACCES* | *permission* | *Permission*)
				printf 'Re-run with appropriate permissions (for example, configure a user-level npm prefix or use a Node version manager). Do not use sudo blindly.\n' >&2
				;;
		esac
		exit 1
	fi
	printf 'Pi installed.\n'
fi

if ! command -v pi >/dev/null 2>&1; then
	printf 'Error: Pi was installed but `pi` is still not on PATH. Add npm'\''s global bin directory to PATH and re-run this script.\n' >&2
	exit 1
fi

if ! install_output=$(pi install "$SOURCE" 2>&1); then
	printf 'Error: `pi install %s` failed.\n' "$SOURCE" >&2
	printf '%s\n' "$install_output" >&2
	exit 1
fi
printf '%s\n' "$install_output"

printf '\nInstalled %s\n' "$SOURCE"
printf '\nNext steps:\n'
printf '  1. Set your Verboo API key:\n'
printf '       export VERBOO_API_KEY=...\n'
printf '     Or run /login verboo inside pi to store a key instead.\n'
printf '  2. List the models:\n'
printf '       pi --list-models verboo\n'
printf '  3. Select one inside pi with /model.\n'

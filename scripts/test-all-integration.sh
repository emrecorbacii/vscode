#!/usr/bin/env bash
set -eo pipefail

# Create a temp file to store exit codes
tmpfile=$(mktemp)

# Function to run command and store its exit code
run_with_prefix() {
	local prefix=$1
	shift
	("$@" 2>&1 | sed "s/^/[$prefix] /") || echo $? > "$tmpfile"
}

# Run all in parallel
run_with_prefix "Electron" ./scripts/test-integration.sh --tfs "Integration Tests" &
run_with_prefix "Browser" ./scripts/test-web-integration.sh --browser chromium &
run_with_prefix "Remote" ./scripts/test-remote-integration.sh &

# Wait for all background processes
wait

# Check if any command failed
if [ -s "$tmpfile" ]; then
	exit $(cat "$tmpfile")
fi

rm -f "$tmpfile"

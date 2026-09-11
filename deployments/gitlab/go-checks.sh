#!/usr/bin/env sh
set -eu

gofmt_files="$(gofmt -l internal protocol)"
if [ -n "$gofmt_files" ]; then
  printf '%s\n' 'gofmt required for:' >&2
  printf '%s\n' "$gofmt_files" >&2
  exit 1
fi

go install golang.org/x/tools/cmd/goimports@v0.36.0
export PATH="$PATH:$(go env GOPATH)/bin"
goimports_files="$(goimports -l internal protocol)"
if [ -n "$goimports_files" ]; then
  printf '%s\n' 'goimports required for:' >&2
  printf '%s\n' "$goimports_files" >&2
  exit 1
fi

go test ./...
go test -race ./...
# Go 1.25 rejects a -fuzz expression that matches multiple fuzz targets. List
# only valid Fuzz names, then run each target independently so every protocol
# parser still receives the same bounded fuzz budget.
fuzz_targets="$(go test ./protocol/v0 -list '^Fuzz' | grep -E '^Fuzz[[:alnum:]_]*$')"
if [ -z "$fuzz_targets" ]; then
	printf '%s\n' 'no protocol fuzz targets discovered' >&2
	exit 1
fi
for fuzz_target in $fuzz_targets; do
	go test ./protocol/v0 -run=^$ -fuzz="^${fuzz_target}$" -fuzztime=10s
done
go vet ./...

go install honnef.co/go/tools/cmd/staticcheck@v0.6.1
staticcheck ./...

go install golang.org/x/vuln/cmd/govulncheck@v1.7.0
govulncheck ./...

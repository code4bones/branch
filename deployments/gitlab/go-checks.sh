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
go test ./protocol/v0 -run=^$ -fuzz=Fuzz -fuzztime=10s
go vet ./...

go install honnef.co/go/tools/cmd/staticcheck@v0.6.1
staticcheck ./...

go install golang.org/x/vuln/cmd/govulncheck@v1.7.0
govulncheck ./...

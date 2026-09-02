#!/usr/bin/env sh
set -eu

test -z "$(gofmt -l internal protocol)"

go install golang.org/x/tools/cmd/goimports@v0.36.0
export PATH="$PATH:$(go env GOPATH)/bin"
test -z "$(goimports -l internal protocol)"

go test ./...
go test -race ./...
go test ./protocol/v0 -run=^$ -fuzz=Fuzz -fuzztime=10s
go vet ./...

go install honnef.co/go/tools/cmd/staticcheck@v0.6.1
staticcheck ./...

go install golang.org/x/vuln/cmd/govulncheck@v1.7.0
govulncheck ./...

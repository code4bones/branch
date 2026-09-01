package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/code4bones/branch/internal/node"
)

func main() {
	config, err := parseConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config rejected: %v\n", err)
		os.Exit(2)
	}
	app, err := node.New(config)
	if err != nil {
		fmt.Fprintf(os.Stderr, "node start failed: %v\n", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	slog.Info("process.started", "service_name", "branch-node", "public_addr", config.PublicAddr, "admin_addr", config.AdminAddr)
	if err := app.Run(ctx); err != nil {
		slog.Error("process.stopped", "error", err)
		os.Exit(1)
	}
	slog.Info("process.stopped", "service_name", "branch-node")
}

func parseConfig() (node.Config, error) {
	config := node.DefaultConfig()
	defaultIdentityPath, err := defaultNodeIdentityPath()
	if err != nil {
		return node.Config{}, err
	}
	flag.StringVar(&config.PublicAddr, "listen", config.PublicAddr, "public relay HTTP listen address")
	flag.StringVar(&config.AdminAddr, "admin-listen", config.AdminAddr, "protected admin HTTP listen address")
	flag.StringVar(&config.IdentityPath, "identity", defaultIdentityPath, "node identity file path")
	flag.StringVar(&config.AdminToken, "admin-token", os.Getenv("BRANCH_ADMIN_TOKEN"), "admin bearer token; defaults to BRANCH_ADMIN_TOKEN")
	flag.Parse()
	return config, nil
}

func defaultNodeIdentityPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "branch", "node-identity.json"), nil
}

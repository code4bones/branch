package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

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
	flag.StringVar(&config.MonitorToken, "monitor-ingest-token", os.Getenv("BRANCH_MONITOR_INGEST_TOKEN"), "relay monitor ingest bearer token; defaults to BRANCH_MONITOR_INGEST_TOKEN")
	flag.StringVar(&config.Monitor.RelayID, "monitor-relay-id", os.Getenv("BRANCH_MONITOR_RELAY_ID"), "relay monitor reporter id; defaults to BRANCH_MONITOR_RELAY_ID")
	flag.StringVar(&config.Monitor.PublicEndpoint, "monitor-public-endpoint", os.Getenv("BRANCH_MONITOR_PUBLIC_ENDPOINT"), "relay monitor public endpoint; defaults to BRANCH_MONITOR_PUBLIC_ENDPOINT")
	flag.StringVar(&config.Monitor.MasterURL, "monitor-master-url", os.Getenv("BRANCH_MONITOR_MASTER_URL"), "relay monitor MASTER webhook URL; defaults to BRANCH_MONITOR_MASTER_URL")
	flag.StringVar(&config.Monitor.PushToken, "monitor-push-token", os.Getenv("BRANCH_MONITOR_PUSH_TOKEN"), "relay monitor push bearer token; defaults to BRANCH_MONITOR_PUSH_TOKEN")
	wssOriginPatterns := os.Getenv("BRANCH_WSS_ORIGIN_PATTERNS")
	flag.StringVar(&wssOriginPatterns, "wss-origin-patterns", wssOriginPatterns, "comma-separated WebSocket Origin host patterns; defaults to BRANCH_WSS_ORIGIN_PATTERNS")
	monitorInterval, err := envDuration("BRANCH_MONITOR_INTERVAL")
	if err != nil {
		return node.Config{}, err
	}
	flag.DurationVar(&config.Monitor.Interval, "monitor-interval", monitorInterval, "relay monitor reporter interval; defaults to BRANCH_MONITOR_INTERVAL")
	flag.Parse()
	config.WSSOrigins = splitCSV(wssOriginPatterns)
	return config, nil
}

func defaultNodeIdentityPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "branch", "node-identity.json"), nil
}

func envDuration(name string) (time.Duration, error) {
	raw := os.Getenv(name)
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, nil
	}
	value, err := time.ParseDuration(trimmed)
	if err != nil {
		return 0, fmt.Errorf("invalid %s: %w", name, err)
	}
	return value, nil
}

func splitCSV(raw string) []string {
	values := []string{}
	for _, part := range strings.Split(raw, ",") {
		value := strings.TrimSpace(part)
		if value != "" {
			values = append(values, value)
		}
	}
	return values
}

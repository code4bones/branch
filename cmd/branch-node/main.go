package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/code4bones/branch/internal/node"
	"github.com/code4bones/branch/internal/observability"
	"github.com/code4bones/branch/internal/relay/wss"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
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
	flag.StringVar(&config.ClientMonitorToken, "client-monitor-ingest-token", os.Getenv("BRANCH_CLIENT_MONITOR_INGEST_TOKEN"), "development PWA client monitor ingest bearer token; defaults to BRANCH_CLIENT_MONITOR_INGEST_TOKEN")
	flag.StringVar(&config.Monitor.RelayID, "monitor-relay-id", os.Getenv("BRANCH_MONITOR_RELAY_ID"), "relay monitor reporter id; defaults to BRANCH_MONITOR_RELAY_ID")
	flag.StringVar(&config.Monitor.PublicEndpoint, "monitor-public-endpoint", os.Getenv("BRANCH_MONITOR_PUBLIC_ENDPOINT"), "relay monitor public endpoint; defaults to BRANCH_MONITOR_PUBLIC_ENDPOINT")
	flag.StringVar(&config.Monitor.MasterURL, "monitor-master-url", os.Getenv("BRANCH_MONITOR_MASTER_URL"), "relay monitor MASTER webhook URL; defaults to BRANCH_MONITOR_MASTER_URL")
	flag.StringVar(&config.Monitor.PushToken, "monitor-push-token", os.Getenv("BRANCH_MONITOR_PUSH_TOKEN"), "relay monitor push bearer token; defaults to BRANCH_MONITOR_PUSH_TOKEN")
	wssOriginPatterns := os.Getenv("BRANCH_WSS_ORIGIN_PATTERNS")
	flag.StringVar(&wssOriginPatterns, "wss-origin-patterns", wssOriginPatterns, "comma-separated WebSocket Origin host patterns; defaults to BRANCH_WSS_ORIGIN_PATTERNS")
	allowFederationWS, err := envBool("BRANCH_FEDERATION_ALLOW_INSECURE_WS")
	if err != nil {
		return node.Config{}, err
	}
	flag.BoolVar(&allowFederationWS, "federation-allow-insecure-ws", allowFederationWS, "allow ws federation peers for local development only")
	allowFederationPrivateAddresses, err := envBool("BRANCH_FEDERATION_ALLOW_PRIVATE_ADDRESSES")
	if err != nil {
		return node.Config{}, err
	}
	flag.BoolVar(&allowFederationPrivateAddresses, "federation-allow-private-addresses", allowFederationPrivateAddresses, "allow private federation addresses for local development only")
	githubIdentityLookup, err := envBool("BRANCH_IDENTITY_GITHUB_ENABLED")
	if err != nil {
		return node.Config{}, err
	}
	flag.BoolVar(&githubIdentityLookup, "identity-github-enabled", githubIdentityLookup, "enable bounded anonymous GitHub IdentityContact lookup; defaults to BRANCH_IDENTITY_GITHUB_ENABLED")
	githubFederationDiscovery, err := envBool("BRANCH_FEDERATION_GITHUB_ENABLED")
	if err != nil {
		return node.Config{}, err
	}
	flag.BoolVar(&githubFederationDiscovery, "federation-github-enabled", githubFederationDiscovery, "enable on-demand signed BootstrapBeacon federation discovery; defaults to BRANCH_FEDERATION_GITHUB_ENABLED")
	observabilityMode := string(config.ObservabilityMode)
	if raw := strings.TrimSpace(os.Getenv("BRANCH_OBSERVABILITY_MODE")); raw != "" {
		observabilityMode = raw
	}
	flag.StringVar(&observabilityMode, "observability-mode", observabilityMode, "off, operator, development, or diagnostic; defaults to BRANCH_OBSERVABILITY_MODE")
	monitorInterval, err := envDuration("BRANCH_MONITOR_INTERVAL")
	if err != nil {
		return node.Config{}, err
	}
	flag.DurationVar(&config.Monitor.Interval, "monitor-interval", monitorInterval, "relay monitor reporter interval; defaults to BRANCH_MONITOR_INTERVAL")
	flag.Parse()
	config.WSSOrigins = splitCSV(wssOriginPatterns)
	config.FederationEndpointPolicy = wss.FederationEndpointPolicy{
		AllowInsecureWS:       allowFederationWS,
		AllowPrivateAddresses: allowFederationPrivateAddresses,
	}
	config.GitHubIdentityLookup = githubIdentityLookup
	config.GitHubFederationDiscovery = githubFederationDiscovery
	config.ObservabilityMode = observability.Mode(observabilityMode)
	if !observability.KnownMode(config.ObservabilityMode) {
		return node.Config{}, fmt.Errorf("invalid observability mode %q", observabilityMode)
	}
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

func envBool(name string) (bool, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return false, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("invalid %s: %w", name, err)
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

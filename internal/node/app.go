package node

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/code4bones/branch/internal/admin"
	"github.com/code4bones/branch/internal/identity"
	"github.com/code4bones/branch/internal/relay"
	"github.com/code4bones/branch/internal/relay/wss"
	protocol "github.com/code4bones/branch/protocol/v0"
)

var ErrInvalidConfig = errors.New("node invalid config")

// Config is parsed once at startup and then treated as immutable.
type Config struct {
	PublicAddr   string
	AdminAddr    string
	IdentityPath string
	AdminToken   string
	Relay        relay.Config
	Version      string
	Monitor      RelayMonitorConfig
	MonitorToken string
}

// DefaultConfig returns development-safe defaults for a relay behind a local
// reverse proxy.
func DefaultConfig() Config {
	return Config{
		PublicAddr: ":8080",
		AdminAddr:  "127.0.0.1:8081",
		Relay:      relay.DefaultConfig(),
		Version:    "0.0.0-dev",
	}
}

// App owns the process-local relay, public HTTP surface, and protected admin
// surface. It does not persist relay sessions or user traffic.
type App struct {
	config       Config
	hub          *relay.Hub
	publicServer *http.Server
	adminServer  *http.Server
	monitor      *relayMonitorReporter
}

// New creates the node composition root.
func New(config Config) (*App, error) {
	if config.PublicAddr == "" {
		return nil, ErrInvalidConfig
	}
	if config.Relay == (relay.Config{}) {
		config.Relay = relay.DefaultConfig()
	}
	nodeIdentity, err := identity.LoadOrCreate(config.IdentityPath)
	if err != nil {
		return nil, fmt.Errorf("load node identity: %w", err)
	}
	hub, err := relay.NewHub(config.Relay)
	if err != nil {
		return nil, fmt.Errorf("create relay hub: %w", err)
	}
	relayHandler, err := wss.NewHandler(wss.Config{
		Hub:              hub,
		Identity:         nodeIdentity,
		MaxFrameBytes:    int64(config.Relay.MaxFrameBytes),
		HandshakeTimeout: 10 * time.Second,
		WriteTimeout:     5 * time.Second,
	})
	if err != nil {
		return nil, fmt.Errorf("create wss relay handler: %w", err)
	}

	publicMux := http.NewServeMux()
	publicMux.Handle(wss.Path, relayHandler)

	baseStatus := admin.StatusSnapshot{
		ServiceName:      "branch-node",
		ServiceVersion:   config.Version,
		Readiness:        admin.ReadinessReady,
		ProtocolVersions: []string{protocol.ProtocolID},
		Capabilities:     []string{"relay.forward.live/0", "route.relay.wss/0"},
	}
	statusProvider := admin.NewRelayStatusProvider(baseStatus, hub)
	relayMonitorRegistry := admin.NewRelayMonitorRegistry(admin.RelayMonitorConfig{})
	bootstrapProvider := newBootstrapBeaconProvider(nodeIdentity)
	adminMux := admin.NewHTTPHandler(
		admin.NewHandler(
			statusProvider,
			admin.WithBootstrapBeaconProvider(bootstrapProvider),
			admin.WithRelayMonitorRegistry(relayMonitorRegistry),
		),
		admin.AuthorizerFunc(func(request *http.Request) bool {
			return config.AdminToken != "" && request.Header.Get("authorization") == "Bearer "+config.AdminToken
		}),
		admin.WithRelayMonitorAuthorizer(admin.AuthorizerFunc(func(request *http.Request) bool {
			return config.MonitorToken != "" && request.Header.Get("authorization") == "Bearer "+config.MonitorToken
		})),
	)
	monitorReporter, err := newRelayMonitorReporter(config.Monitor, statusProvider, bootstrapProvider)
	if err != nil {
		return nil, err
	}

	return &App{
		config:  config,
		hub:     hub,
		monitor: monitorReporter,
		publicServer: &http.Server{
			Addr:              config.PublicAddr,
			Handler:           publicMux,
			ReadHeaderTimeout: 5 * time.Second,
		},
		adminServer: &http.Server{
			Addr:              config.AdminAddr,
			Handler:           adminMux,
			ReadHeaderTimeout: 5 * time.Second,
		},
	}, nil
}

// PublicHandler returns the public client/relay HTTP surface for tests and
// embedding.
func (app *App) PublicHandler() http.Handler {
	return app.publicServer.Handler
}

// AdminHandler returns the protected operator HTTP surface for tests.
func (app *App) AdminHandler() http.Handler {
	return app.adminServer.Handler
}

// Hub returns the process-local relay hub for tests.
func (app *App) Hub() *relay.Hub {
	return app.hub
}

// Run starts configured listeners until ctx is cancelled.
func (app *App) Run(ctx context.Context) error {
	errs := make(chan error, 3)
	go serve(app.publicServer, errs)
	if app.config.AdminAddr != "" {
		go serve(app.adminServer, errs)
	}
	if app.monitor != nil {
		go app.monitor.run(ctx)
	}

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = app.publicServer.Shutdown(shutdownCtx)
		if app.config.AdminAddr != "" {
			_ = app.adminServer.Shutdown(shutdownCtx)
		}
		app.hub.Close()
		return nil
	case err := <-errs:
		app.hub.Close()
		if err == nil || errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func serve(server *http.Server, errs chan<- error) {
	errs <- server.ListenAndServe()
}

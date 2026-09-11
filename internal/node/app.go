package node

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/code4bones/branch/internal/admin"
	githubcarrier "github.com/code4bones/branch/internal/carrier/github"
	"github.com/code4bones/branch/internal/discovery"
	"github.com/code4bones/branch/internal/identity"
	"github.com/code4bones/branch/internal/observability"
	"github.com/code4bones/branch/internal/relay"
	"github.com/code4bones/branch/internal/relay/wss"
	protocol "github.com/code4bones/branch/protocol/v0"
)

var ErrInvalidConfig = errors.New("node invalid config")

// Config is parsed once at startup and then treated as immutable.
type Config struct {
	PublicAddr                string
	AdminAddr                 string
	IdentityPath              string
	AdminToken                string
	Relay                     relay.Config
	Version                   string
	Monitor                   RelayMonitorConfig
	MonitorToken              string
	WSSOrigins                []string
	FederationEndpointPolicy  wss.FederationEndpointPolicy
	GitHubIdentityLookup      bool
	GitHubFederationDiscovery bool
	ObservabilityMode         observability.Mode
}

// DefaultConfig returns development-safe defaults for a relay behind a local
// reverse proxy.
func DefaultConfig() Config {
	return Config{
		PublicAddr:        ":8080",
		AdminAddr:         "127.0.0.1:8081",
		Relay:             relay.DefaultConfig(),
		Version:           "0.0.0-dev",
		ObservabilityMode: observability.ModeOperator,
	}
}

// App owns the process-local relay, public HTTP surface, and protected admin
// surface. It does not persist relay sessions or user traffic.
type App struct {
	config         Config
	hub            *relay.Hub
	publicServer   *http.Server
	adminServer    *http.Server
	monitor        *relayMonitorReporter
	identityLookup *discovery.IdentityContactLookup
	diagnostics    *observability.Recorder
	exporter       *observability.AsyncSink
}

// New creates the node composition root.
func New(config Config) (*App, error) {
	if config.PublicAddr == "" {
		return nil, ErrInvalidConfig
	}
	if config.Relay == (relay.Config{}) {
		config.Relay = relay.DefaultConfig()
	}
	if config.ObservabilityMode == "" {
		config.ObservabilityMode = observability.ModeOperator
	}
	if !observability.KnownMode(config.ObservabilityMode) {
		return nil, ErrInvalidConfig
	}
	diagnostics := observability.NewRecorder(observability.RecorderOptions{})
	federationObserver, fanout := newFederationObserver(config.ObservabilityMode, diagnostics, config.Version)
	nodeIdentity, err := identity.LoadOrCreate(config.IdentityPath)
	if err != nil {
		return nil, fmt.Errorf("load node identity: %w", err)
	}
	hub, err := relay.NewHub(config.Relay)
	if err != nil {
		return nil, fmt.Errorf("create relay hub: %w", err)
	}
	identityContactCache, err := discovery.NewIdentityContactCache(discovery.IdentityContactCacheConfig{})
	if err != nil {
		return nil, fmt.Errorf("create identity contact cache: %w", err)
	}
	peerRouter, err := wss.NewStaticPeerRouter(wss.StaticPeerRouterConfig{
		LocalHub:       hub,
		EndpointPolicy: config.FederationEndpointPolicy,
		MaxFrameBytes:  int64(config.Relay.MaxFrameBytes),
		DialTimeout:    2 * time.Second,
		WriteTimeout:   5 * time.Second,
	})
	if err != nil {
		return nil, fmt.Errorf("create relay federation router: %w", err)
	}
	identitySources := []discovery.IdentityContactLookupSource{peerRouter}
	var forwardingPeerRouter wss.PeerRouter = peerRouter
	var federationMonitor interface {
		FederationSnapshot() []wss.FederationPeerObservation
	} = peerRouter
	var federationCarrierMonitor interface {
		FederationCarrierSnapshot() *wss.FederationCarrierObservation
	}
	if config.GitHubFederationDiscovery {
		githubSource, sourceErr := githubcarrier.NewIdentityContactSource(githubcarrier.IdentityContactSourceConfig{})
		if sourceErr != nil {
			return nil, fmt.Errorf("create github federation carrier: %w", sourceErr)
		}
		discoveredRouter, routerErr := wss.NewDiscoveredPeerRouter(wss.DiscoveredPeerRouterConfig{
			Source:         githubSource,
			Identity:       nodeIdentity,
			LocalHub:       hub,
			EndpointPolicy: config.FederationEndpointPolicy,
			MaxFrameBytes:  int64(config.Relay.MaxFrameBytes),
			DialTimeout:    2 * time.Second,
			WriteTimeout:   5 * time.Second,
			Observer:       federationObserver,
		})
		if routerErr != nil {
			return nil, fmt.Errorf("create discovered relay federation router: %w", routerErr)
		}
		forwardingPeerRouter = discoveredRouter
		federationMonitor = discoveredRouter
		federationCarrierMonitor = discoveredRouter
		identitySources = []discovery.IdentityContactLookupSource{discoveredRouter}
	}
	if config.GitHubIdentityLookup {
		githubSource, sourceErr := githubcarrier.NewIdentityContactSource(githubcarrier.IdentityContactSourceConfig{})
		if sourceErr != nil {
			return nil, fmt.Errorf("create github identity carrier: %w", sourceErr)
		}
		identitySources = append(identitySources, githubSource)
	}
	identityLookup, err := discovery.NewIdentityContactLookup(discovery.IdentityContactLookupConfig{
		Cache:   identityContactCache,
		Sources: identitySources,
	})
	if err != nil {
		return nil, fmt.Errorf("create identity contact lookup: %w", err)
	}
	relayHandler, err := wss.NewHandler(wss.Config{
		Hub:              hub,
		Identity:         nodeIdentity,
		IdentityContacts: identityContactCache,
		PeerRouter:       forwardingPeerRouter,
		OriginPatterns:   config.WSSOrigins,
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
		Capabilities:     relayCapabilities(config.GitHubFederationDiscovery),
	}
	statusProvider := admin.NewRelayStatusProvider(baseStatus, hub)
	relayMonitorRegistry := admin.NewRelayMonitorRegistry(admin.RelayMonitorConfig{})
	bootstrapProvider := newBootstrapBeaconProvider(nodeIdentity)
	adminMux := admin.NewHTTPHandler(
		admin.NewHandler(
			statusProvider,
			admin.WithDiagnosticsProvider(diagnostics),
			admin.WithBootstrapBeaconProvider(bootstrapProvider),
			admin.WithIdentityContactLookupProvider(identityLookup),
			admin.WithRelayMonitorRegistry(relayMonitorRegistry),
		),
		admin.AuthorizerFunc(func(request *http.Request) bool {
			return config.AdminToken != "" && request.Header.Get("authorization") == "Bearer "+config.AdminToken
		}),
		admin.WithRelayMonitorAuthorizer(admin.AuthorizerFunc(func(request *http.Request) bool {
			return config.MonitorToken != "" && request.Header.Get("authorization") == "Bearer "+config.MonitorToken
		})),
	)
	monitorReporter, err := newRelayMonitorReporter(config.Monitor, statusProvider, bootstrapProvider, staticFederationMonitor{router: federationMonitor, carrierRouter: federationCarrierMonitor}, diagnostics)
	if err != nil {
		return nil, err
	}
	var exporter *observability.AsyncSink
	if fanout != nil {
		exporter, err = observability.NewAsyncSink(context.Background(), observability.NewSlogSink(nil, config.ObservabilityMode), observability.DefaultExporterQueueCapacity)
		if err != nil {
			return nil, fmt.Errorf("create observability exporter: %w", err)
		}
		fanout.slog = exporter
	}

	return &App{
		config:         config,
		hub:            hub,
		monitor:        monitorReporter,
		identityLookup: identityLookup,
		diagnostics:    diagnostics,
		exporter:       exporter,
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

type noopNodeFederationObserver struct{}

func (noopNodeFederationObserver) ObserveFederation(context.Context, wss.FederationObservation) {}

func relayCapabilities(githubFederationDiscovery bool) []string {
	capabilities := []string{"relay.forward.live/0", "route.relay.wss/0"}
	if githubFederationDiscovery {
		capabilities = append(capabilities, protocol.RelayFederationLiveRole)
	}
	return capabilities
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
	defer app.closeObservability()
	runCtx, cancel := context.WithCancel(ctx)
	sweepDone := make(chan struct{})
	go app.sweepExpired(runCtx, sweepDone)
	defer func() {
		cancel()
		<-sweepDone
	}()

	errs := make(chan error, 3)
	go serve(app.publicServer, errs)
	if app.config.AdminAddr != "" {
		go serve(app.adminServer, errs)
	}
	if app.monitor != nil {
		go app.monitor.run(runCtx)
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

func (app *App) closeObservability() {
	if app.exporter != nil {
		app.exporter.Close()
	}
}

func (app *App) sweepExpired(ctx context.Context, done chan<- struct{}) {
	defer close(done)
	interval := app.hub.PresenceTTL() / 2
	if interval < time.Second {
		interval = time.Second
	}
	if interval > 10*time.Second {
		interval = 10 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			app.hub.SweepExpired(now)
		}
	}
}

func serve(server *http.Server, errs chan<- error) {
	errs <- server.ListenAndServe()
}

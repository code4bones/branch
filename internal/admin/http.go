package admin

import (
	"encoding/json"
	"net/http"
	"time"
)

const (
	RelayMonitorReportsPath        = "/relay-monitor/reports"
	maxRelayMonitorReportBodyBytes = 16 * 1024
)

// Authorizer decides whether a request may access protected admin endpoints.
type Authorizer interface {
	Authorized(*http.Request) bool
}

// AuthorizerFunc adapts a function to Authorizer.
type AuthorizerFunc func(*http.Request) bool

// Authorized calls fn(request).
func (fn AuthorizerFunc) Authorized(request *http.Request) bool {
	return fn(request)
}

// HTTPHandler serves protected admin endpoint contracts without binding a
// listener or owning operator authentication material.
type HTTPHandler struct {
	handler           *Handler
	authorizer        Authorizer
	monitorAuthorizer Authorizer
	now               func() time.Time
}

// HTTPHandlerOption configures optional protected HTTP surfaces.
type HTTPHandlerOption func(*HTTPHandler)

// WithRelayMonitorAuthorizer protects relay monitor report ingestion with a
// dedicated operator token.
func WithRelayMonitorAuthorizer(authorizer Authorizer) HTTPHandlerOption {
	return func(handler *HTTPHandler) {
		handler.monitorAuthorizer = authorizer
	}
}

// WithClock sets the HTTP handler clock for deterministic tests.
func WithClock(now func() time.Time) HTTPHandlerOption {
	return func(handler *HTTPHandler) {
		handler.now = now
	}
}

// NewHTTPHandler creates a protected HTTP adapter over an admin Handler.
func NewHTTPHandler(handler *Handler, authorizer Authorizer, options ...HTTPHandlerOption) *HTTPHandler {
	if authorizer == nil {
		authorizer = denyAuthorizer{}
	}
	httpHandler := &HTTPHandler{
		handler:           handler,
		authorizer:        authorizer,
		monitorAuthorizer: denyAuthorizer{},
		now:               time.Now,
	}
	for _, option := range options {
		option(httpHandler)
	}
	if httpHandler.monitorAuthorizer == nil {
		httpHandler.monitorAuthorizer = denyAuthorizer{}
	}
	if httpHandler.now == nil {
		httpHandler.now = time.Now
	}
	return httpHandler
}

// ServeHTTP routes minimal protected admin endpoints.
func (handler *HTTPHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path == RelayMonitorReportsPath && request.Method == http.MethodPost {
		handler.ingestRelayMonitorReport(response, request)
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("allow", http.MethodGet)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !handler.authorizer.Authorized(request) {
		http.Error(response, "forbidden", http.StatusForbidden)
		return
	}

	switch request.URL.Path {
	case "/livez":
		writeResponse(response, handler.handler.Liveness())
	case "/readyz":
		writeResponse(response, handler.handler.Readiness())
	case "/diagnostics":
		writeResponse(response, handler.handler.Diagnostics())
	case "/metrics":
		writeResponse(response, handler.handler.Metrics())
	case "/bootstrap/beacon":
		bootstrapRequest, err := ParseBootstrapBeaconRequest(request.URL.Query())
		if err != nil {
			writeResponse(response, jsonResponse(http.StatusBadRequest, map[string]string{"error": err.Error()}))
			return
		}
		writeResponse(response, handler.handler.BootstrapBeacon(bootstrapRequest))
	case IdentityContactLookupPath:
		lookupRequest, err := ParseIdentityContactLookupRequest(request.URL.Query())
		if err != nil {
			writeResponse(response, jsonResponse(http.StatusBadRequest, map[string]string{"error": err.Error()}))
			return
		}
		writeResponse(response, handler.handler.IdentityContactLookup(request.Context(), lookupRequest))
	case RelayMonitorReportsPath:
		writeResponse(response, handler.handler.RelayMonitorReports(handler.now()))
	default:
		http.NotFound(response, request)
	}
}

func (handler *HTTPHandler) ingestRelayMonitorReport(response http.ResponseWriter, request *http.Request) {
	if !handler.monitorAuthorizer.Authorized(request) {
		http.Error(response, "forbidden", http.StatusForbidden)
		return
	}
	defer request.Body.Close()
	request.Body = http.MaxBytesReader(response, request.Body, maxRelayMonitorReportBodyBytes)

	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var report RelayMonitorReport
	if err := decoder.Decode(&report); err != nil {
		writeResponse(response, jsonResponse(http.StatusBadRequest, map[string]string{"error": "invalid json"}))
		return
	}
	writeResponse(response, handler.handler.AcceptRelayMonitorReport(report, handler.now()))
}

type denyAuthorizer struct{}

func (denyAuthorizer) Authorized(*http.Request) bool {
	return false
}

func writeResponse(response http.ResponseWriter, adminResponse Response) {
	response.Header().Set("content-type", "application/json")
	response.Header().Set("cache-control", "no-store")
	response.WriteHeader(adminResponse.StatusCode)
	_, _ = response.Write(adminResponse.Body)
}

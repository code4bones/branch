package admin

import (
	"net/http"
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
	handler    *Handler
	authorizer Authorizer
}

// NewHTTPHandler creates a protected HTTP adapter over an admin Handler.
func NewHTTPHandler(handler *Handler, authorizer Authorizer) *HTTPHandler {
	if authorizer == nil {
		authorizer = denyAuthorizer{}
	}
	return &HTTPHandler{
		handler:    handler,
		authorizer: authorizer,
	}
}

// ServeHTTP routes minimal protected admin endpoints.
func (handler *HTTPHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
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
	default:
		http.NotFound(response, request)
	}
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

package admin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientMonitorRegistryBoundsAndExpiresReports(t *testing.T) {
	now := time.Date(2026, 9, 12, 9, 0, 0, 0, time.UTC)
	registry := NewClientMonitorRegistry(ClientMonitorConfig{TTL: time.Minute, MaxClients: 1, MaxEvents: 2})
	report := sampleClientMonitorReport()
	if err := registry.Accept(report, now); err != nil {
		t.Fatalf("accept report: %v", err)
	}
	report.Events = append(report.Events, ClientMonitorEvent{At: now.Add(time.Second), Category: "outbox", Event: "outbox.retry_sent"})
	if err := registry.Accept(report, now.Add(time.Second)); err != nil {
		t.Fatalf("accept updated report: %v", err)
	}
	observations := registry.List(now.Add(2 * time.Second))
	if len(observations) != 1 || len(observations[0].Events) != 2 {
		t.Fatalf("observations = %+v, want one bounded entry", observations)
	}
	if got := observations[0].Events[0].Event; got != "receipt.read_matched" {
		t.Fatalf("first retained event = %q", got)
	}
	if got := registry.List(now.Add(time.Minute + time.Second)); len(got) != 0 {
		t.Fatalf("expired observations = %+v", got)
	}
}

func TestClientMonitorRegistryRejectsRawTraceAndIdentifiers(t *testing.T) {
	registry := NewClientMonitorRegistry(ClientMonitorConfig{})
	report := sampleClientMonitorReport()
	report.Events[0].Event = "delivery receipt: read_matched"
	if err := registry.Accept(report, time.Now()); err != ErrClientMonitorInvalidReport {
		t.Fatalf("raw event error = %v, want %v", err, ErrClientMonitorInvalidReport)
	}
	report = sampleClientMonitorReport()
	report.ClientRef = "peer-identity-or-message-id"
	if err := registry.Accept(report, time.Now()); err != ErrClientMonitorInvalidReport {
		t.Fatalf("identifier error = %v, want %v", err, ErrClientMonitorInvalidReport)
	}
}

func TestClientMonitorHTTPUsesDedicatedIngestBearerAndAdminListing(t *testing.T) {
	now := time.Date(2026, 9, 12, 9, 0, 0, 0, time.UTC)
	registry := NewClientMonitorRegistry(ClientMonitorConfig{})
	handler := NewHTTPHandler(
		NewHandler(staticProvider{}, WithClientMonitorRegistry(registry)),
		AuthorizerFunc(func(request *http.Request) bool { return request.Header.Get("authorization") == "Bearer admin-token" }),
		WithClientMonitorAuthorizer(AuthorizerFunc(func(request *http.Request) bool { return request.Header.Get("authorization") == "Bearer client-token" })),
		WithClock(func() time.Time { return now }),
	)
	body := encodeClientMonitorReport(t, sampleClientMonitorReport())
	post := httptest.NewRequest(http.MethodPost, ClientMonitorReportsPath, bytes.NewReader(body))
	post.Header.Set("authorization", "Bearer admin-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, post)
	if response.Code != http.StatusForbidden {
		t.Fatalf("admin bearer post status = %d", response.Code)
	}

	post = httptest.NewRequest(http.MethodPost, ClientMonitorReportsPath, bytes.NewReader(body))
	post.Header.Set("authorization", "Bearer client-token")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, post)
	if response.Code != http.StatusOK {
		t.Fatalf("ingest status = %d, body = %s", response.Code, response.Body.String())
	}

	list := httptest.NewRequest(http.MethodGet, ClientMonitorReportsPath, nil)
	list.Header.Set("authorization", "Bearer client-token")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, list)
	if response.Code != http.StatusForbidden {
		t.Fatalf("ingest bearer list status = %d", response.Code)
	}

	list.Header.Set("authorization", "Bearer admin-token")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, list)
	if response.Code != http.StatusOK {
		t.Fatalf("list status = %d", response.Code)
	}
	for _, forbidden := range []string{"client-token", "admin-token", "detail", "delivery_id", "message_id"} {
		if strings.Contains(response.Body.String(), forbidden) {
			t.Fatalf("client report leaked %q: %s", forbidden, response.Body.String())
		}
	}
}

func TestClientMonitorHTTPRejectsUnknownFields(t *testing.T) {
	handler := NewHTTPHandler(NewHandler(staticProvider{}, WithClientMonitorRegistry(NewClientMonitorRegistry(ClientMonitorConfig{}))), AuthorizerFunc(func(*http.Request) bool { return true }), WithClientMonitorAuthorizer(AuthorizerFunc(func(*http.Request) bool { return true })))
	body := []byte(`{"client_ref":"0123456789abcdef0123456789abcdef","release":"0.1.0-beta.149","events":[{"at":"2026-09-12T09:00:00Z","category":"receipts","event":"receipt.read_matched","detail":"forbidden"}]}`)
	request := httptest.NewRequest(http.MethodPost, ClientMonitorReportsPath, bytes.NewReader(body))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status = %d", response.Code)
	}
}

func sampleClientMonitorReport() ClientMonitorReport {
	return ClientMonitorReport{ClientRef: "0123456789abcdef0123456789abcdef", Release: "0.1.0-beta.149", Events: []ClientMonitorEvent{{At: time.Date(2026, 9, 12, 9, 0, 0, 0, time.UTC), Category: "receipts", Event: "receipt.read_matched"}}}
}

func encodeClientMonitorReport(t *testing.T, report ClientMonitorReport) []byte {
	t.Helper()
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	return body
}

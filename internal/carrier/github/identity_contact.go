// Package github implements the optional public GitHub SearchCarrier adapter.
package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/code4bones/branch/internal/discovery"
	protocol "github.com/code4bones/branch/protocol/v0"
)

const (
	defaultAPIBaseURL        = "https://api.github.com"
	defaultRawBaseURL        = "https://raw.githubusercontent.com"
	defaultLocator           = "branchbootstrapv0"
	defaultTimeout           = 3 * time.Second
	defaultMaxRepositories   = 5
	maxRepositoriesLimit     = 10
	defaultMaxResponse       = 128 * 1024
	maxResponse              = 256 * 1024
	defaultMaxRecordBytes    = 64 * 1024
	maxRecordBytesLimit      = 64 * 1024
	maxWrappersPerRecord     = 16
	maxBootstrapCandidates   = 8
	maxGitHubOwnerBytes      = 39
	maxGitHubRepositoryBytes = 100
	maxGitHubBranchBytes     = 256
)

var ErrInvalidConfig = errors.New("invalid github identity carrier config")

// HTTPClient is the small outbound HTTP port consumed by the carrier adapter.
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// IdentityContactSourceConfig defines the bounded anonymous GitHub read path.
// It intentionally has no token or publication credential field.
type IdentityContactSourceConfig struct {
	APIBaseURL       string
	RawBaseURL       string
	HTTPClient       HTTPClient
	Timeout          time.Duration
	MaxRepositories  int
	MaxResponseBytes int
	MaxRecordBytes   int
}

// IdentityContactSource finds exact signed identity.announce candidates from
// public repositories carrying the v0 topic. It stores nothing itself.
type IdentityContactSource struct {
	apiBaseURL       *url.URL
	rawBaseURL       *url.URL
	client           HTTPClient
	timeout          time.Duration
	maxRepositories  int
	maxResponseBytes int
	maxRecordBytes   int
}

// NewIdentityContactSource constructs one bounded GitHub topic-search adapter.
func NewIdentityContactSource(config IdentityContactSourceConfig) (*IdentityContactSource, error) {
	baseURL, err := parseAPIBaseURL(config.APIBaseURL)
	if err != nil {
		return nil, err
	}
	rawBaseURL, err := parseRawBaseURL(config.RawBaseURL)
	if err != nil {
		return nil, err
	}
	timeout := config.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	if timeout <= 0 || timeout > 10*time.Second {
		return nil, ErrInvalidConfig
	}
	maxRepositories := config.MaxRepositories
	if maxRepositories == 0 {
		maxRepositories = defaultMaxRepositories
	}
	if maxRepositories < 1 || maxRepositories > maxRepositoriesLimit {
		return nil, ErrInvalidConfig
	}
	maxResponseBytes := config.MaxResponseBytes
	if maxResponseBytes == 0 {
		maxResponseBytes = defaultMaxResponse
	}
	if maxResponseBytes < 4*1024 || maxResponseBytes > maxResponse {
		return nil, ErrInvalidConfig
	}
	recordBytesLimit := config.MaxRecordBytes
	if recordBytesLimit == 0 {
		recordBytesLimit = defaultMaxRecordBytes
	}
	if recordBytesLimit < 1 || recordBytesLimit > maxRecordBytesLimit {
		return nil, ErrInvalidConfig
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("github carrier redirect forbidden")
			},
		}
	}
	return &IdentityContactSource{
		apiBaseURL:       baseURL,
		rawBaseURL:       rawBaseURL,
		client:           client,
		timeout:          timeout,
		maxRepositories:  maxRepositories,
		maxResponseBytes: maxResponseBytes,
		maxRecordBytes:   recordBytesLimit,
	}, nil
}

// ID identifies the public GitHub carrier failure domain.
func (*IdentityContactSource) ID() string {
	return "github"
}

// LookupIdentityContact performs at most one repository search and one bounded
// records read for each selected public repository. The caller validates every
// returned wrapper before admitting it to its volatile observation cache.
func (source *IdentityContactSource) LookupIdentityContact(ctx context.Context, branchID string) ([]discovery.IdentityContactCandidate, error) {
	if err := protocol.ParseBranchID(branchID); err != nil {
		return nil, fmt.Errorf("validate branch id: %w", err)
	}
	requestCtx, cancel := context.WithTimeout(ctx, source.timeout)
	defer cancel()

	repositories, err := source.searchRepositories(requestCtx)
	if err != nil {
		return nil, err
	}
	candidates := make([]discovery.IdentityContactCandidate, 0, maxWrappersPerRecord)
	var recordsErr error
	for _, repository := range repositories {
		if len(candidates) >= maxWrappersPerRecord {
			break
		}
		wrappers, err := source.readRepositoryRecords(requestCtx, repository)
		if err != nil {
			if requestCtx.Err() != nil {
				return nil, requestCtx.Err()
			}
			if errors.Is(err, errRecordsMissing) {
				continue
			}
			recordsErr = err
			continue
		}
		for _, wrapper := range wrappers {
			candidates = append(candidates, discovery.IdentityContactCandidate{
				Wrapper: wrapper,
				Source:  repository.FullName + "/.branch/records.br0",
			})
			if len(candidates) >= maxWrappersPerRecord {
				break
			}
		}
	}
	if len(candidates) == 0 && recordsErr != nil {
		return nil, fmt.Errorf("read github repository records: %w", recordsErr)
	}
	return candidates, nil
}

// LookupBootstrapBeacons performs the same bounded anonymous carrier pass as
// identity lookup, but returns public BRANCH0 candidates without assigning
// carrier authority. The federation adapter validates each beacon signature,
// freshness, profile, capability, and endpoint before any dial.
func (source *IdentityContactSource) LookupBootstrapBeacons(ctx context.Context) ([]discovery.BootstrapBeaconCandidate, error) {
	requestCtx, cancel := context.WithTimeout(ctx, source.timeout)
	defer cancel()

	repositories, err := source.searchRepositories(requestCtx)
	if err != nil {
		return nil, githubBootstrapLookupFailure(err)
	}
	candidates := make([]discovery.BootstrapBeaconCandidate, 0, maxBootstrapCandidates)
	var recordsErr error
	for _, repository := range repositories {
		if len(candidates) >= maxBootstrapCandidates {
			break
		}
		wrappers, err := source.readRepositoryRecords(requestCtx, repository)
		if err != nil {
			if requestCtx.Err() != nil {
				return nil, githubBootstrapLookupFailure(requestCtx.Err())
			}
			if errors.Is(err, errRecordsMissing) {
				continue
			}
			recordsErr = err
			continue
		}
		for _, wrapper := range wrappers {
			candidates = append(candidates, discovery.BootstrapBeaconCandidate{
				Wrapper: wrapper,
				Source:  repository.FullName + "/.branch/records.br0",
			})
			if len(candidates) >= maxBootstrapCandidates {
				break
			}
		}
	}
	if len(candidates) == 0 && recordsErr != nil {
		return nil, githubBootstrapLookupFailure(recordsErr)
	}
	return candidates, nil
}

func githubBootstrapLookupFailure(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return discovery.NewBootstrapBeaconLookupFailure("github_timeout", err)
	}
	var statusErr githubHTTPStatusError
	if errors.As(err, &statusErr) {
		if statusErr.status == http.StatusForbidden || statusErr.status == http.StatusTooManyRequests {
			return discovery.NewBootstrapBeaconLookupFailure("github_rate_limited", err)
		}
		return discovery.NewBootstrapBeaconLookupFailure("github_http_error", err)
	}
	return discovery.NewBootstrapBeaconLookupFailure("github_lookup_failed", err)
}

type githubRepositorySearch struct {
	Items []githubRepository `json:"items"`
}

type githubRepository struct {
	FullName      string `json:"full_name"`
	Fork          bool   `json:"fork"`
	DefaultBranch string `json:"default_branch"`
	Owner         struct {
		Login string `json:"login"`
	} `json:"owner"`
	Name string `json:"name"`
}

var errRecordsMissing = errors.New("github records missing")

type githubHTTPStatusError struct {
	operation string
	status    int
}

func (err githubHTTPStatusError) Error() string {
	return fmt.Sprintf("github %s status %d", err.operation, err.status)
}

func (source *IdentityContactSource) searchRepositories(ctx context.Context) ([]githubRepository, error) {
	endpoint := source.apiBaseURL.JoinPath("search", "repositories")
	query := endpoint.Query()
	query.Set("q", "topic:"+defaultLocator)
	query.Set("per_page", fmt.Sprintf("%d", source.maxRepositories))
	query.Set("page", "1")
	endpoint.RawQuery = query.Encode()

	body, status, err := source.get(ctx, endpoint.String())
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, githubHTTPStatusError{operation: "repository_search", status: status}
	}
	var response githubRepositorySearch
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, fmt.Errorf("decode github repository search: %w", err)
	}
	repositories := make([]githubRepository, 0, source.maxRepositories)
	for _, repository := range response.Items {
		if len(repositories) == source.maxRepositories {
			break
		}
		if repository.Fork || !validRepository(repository) {
			continue
		}
		repositories = append(repositories, repository)
	}
	return repositories, nil
}

func (source *IdentityContactSource) readRepositoryRecords(ctx context.Context, repository githubRepository) ([]string, error) {
	if !validRepository(repository) {
		return nil, ErrInvalidConfig
	}
	endpoint := source.rawBaseURL.JoinPath(repository.Owner.Login, repository.Name, repository.DefaultBranch, ".branch", "records.br0")

	body, status, err := source.getRaw(ctx, endpoint.String())
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, errRecordsMissing
	}
	if status != http.StatusOK {
		return nil, githubHTTPStatusError{operation: "records_read", status: status}
	}
	if len(body) == 0 {
		return nil, errors.New("github records response is empty")
	}
	return extractWrappers(string(body), maxWrappersPerRecord), nil
}

func (source *IdentityContactSource) get(ctx context.Context, endpoint string) ([]byte, int, error) {
	return source.getBounded(ctx, endpoint, source.maxResponseBytes, "application/vnd.github+json", true)
}

func (source *IdentityContactSource) getRaw(ctx context.Context, endpoint string) ([]byte, int, error) {
	return source.getBounded(ctx, endpoint, source.maxRecordBytes, "text/plain", false)
}

func (source *IdentityContactSource) getBounded(ctx context.Context, endpoint string, limit int, accept string, apiVersion bool) ([]byte, int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("create github request: %w", err)
	}
	request.Header.Set("accept", accept)
	if apiVersion {
		request.Header.Set("x-github-api-version", "2022-11-28")
	}
	response, err := source.client.Do(request)
	if err != nil {
		return nil, 0, fmt.Errorf("request github carrier: %w", err)
	}
	defer response.Body.Close()
	body, err := readBounded(response.Body, limit)
	if err != nil {
		return nil, 0, err
	}
	return body, response.StatusCode, nil
}

func parseAPIBaseURL(value string) (*url.URL, error) {
	if value == "" {
		value = defaultAPIBaseURL
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, ErrInvalidConfig
	}
	return parsed, nil
}

func parseRawBaseURL(value string) (*url.URL, error) {
	if value == "" {
		value = defaultRawBaseURL
	}
	return parseAPIBaseURL(value)
}

func validRepository(repository githubRepository) bool {
	return repository.FullName == repository.Owner.Login+"/"+repository.Name &&
		validGitHubOwner(repository.Owner.Login) &&
		validGitHubRepositoryName(repository.Name) &&
		validGitHubBranch(repository.DefaultBranch)
}

func validGitHubOwner(value string) bool {
	if len(value) == 0 || len(value) > maxGitHubOwnerBytes || value[0] == '-' || value[len(value)-1] == '-' {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	return true
}

func validGitHubRepositoryName(value string) bool {
	return validGitHubPathSegment(value, maxGitHubRepositoryBytes)
}

// validGitHubBranch accepts Git's ordinary slash-separated refs only after
// validating every raw-content path segment independently. This keeps common
// refs such as release/2026 valid without permitting dot-segment traversal or
// path-confusing bytes in a GitHub raw-content URL.
func validGitHubBranch(value string) bool {
	if len(value) == 0 || len(value) > maxGitHubBranchBytes || strings.HasPrefix(value, "/") || strings.HasSuffix(value, "/") || strings.Contains(value, "..") {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if !validGitHubPathSegment(segment, maxGitHubBranchBytes) || strings.HasSuffix(segment, ".lock") {
			return false
		}
	}
	return true
}

func validGitHubPathSegment(value string, maximumLength int) bool {
	if len(value) == 0 || len(value) > maximumLength || value == "." || value == ".." {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') && character != '-' && character != '_' && character != '.' {
			return false
		}
	}
	return true
}

func extractWrappers(content string, limit int) []string {
	wrappers := make([]string, 0, limit)
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSuffix(line, "\r")
		if !strings.HasPrefix(line, protocol.BranchTextWrapperPrefix) {
			continue
		}
		wrappers = append(wrappers, line)
		if len(wrappers) == limit {
			break
		}
	}
	return wrappers
}

func readBounded(reader io.Reader, limit int) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
	if err != nil {
		return nil, fmt.Errorf("read github response: %w", err)
	}
	if len(body) > limit {
		return nil, errors.New("github response too large")
	}
	return body, nil
}

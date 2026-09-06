// Package github implements the optional public GitHub SearchCarrier adapter.
package github

import (
	"context"
	"encoding/base64"
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
	defaultAPIBaseURL      = "https://api.github.com"
	defaultLocator         = "branchbootstrapv0"
	defaultTimeout         = 3 * time.Second
	defaultMaxRepositories = 5
	maxRepositoriesLimit   = 10
	defaultMaxResponse     = 128 * 1024
	maxResponse            = 256 * 1024
	defaultMaxRecordBytes  = 64 * 1024
	maxRecordBytesLimit    = 64 * 1024
	maxWrappersPerRecord   = 16
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

type githubContentFile struct {
	Type     string `json:"type"`
	Encoding string `json:"encoding"`
	Content  string `json:"content"`
}

var errRecordsMissing = errors.New("github records missing")

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
		return nil, fmt.Errorf("github repository search status %d", status)
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
	endpoint := source.apiBaseURL.JoinPath("repos", repository.Owner.Login, repository.Name, "contents", ".branch", "records.br0")
	query := endpoint.Query()
	query.Set("ref", repository.DefaultBranch)
	endpoint.RawQuery = query.Encode()

	body, status, err := source.get(ctx, endpoint.String())
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, errRecordsMissing
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("github records status %d", status)
	}
	var response githubContentFile
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, fmt.Errorf("decode github records response: %w", err)
	}
	if response.Type != "file" || response.Encoding != "base64" || response.Content == "" {
		return nil, errors.New("invalid github records response")
	}
	decoded, err := base64.StdEncoding.DecodeString(response.Content)
	if err != nil {
		return nil, fmt.Errorf("decode github records content: %w", err)
	}
	if len(decoded) > source.maxRecordBytes {
		return nil, errors.New("github records content too large")
	}
	return extractWrappers(string(decoded), maxWrappersPerRecord), nil
}

func (source *IdentityContactSource) get(ctx context.Context, endpoint string) ([]byte, int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("create github request: %w", err)
	}
	request.Header.Set("accept", "application/vnd.github+json")
	request.Header.Set("x-github-api-version", "2022-11-28")
	response, err := source.client.Do(request)
	if err != nil {
		return nil, 0, fmt.Errorf("request github carrier: %w", err)
	}
	defer response.Body.Close()
	body, err := readBounded(response.Body, source.maxResponseBytes)
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

func validRepository(repository githubRepository) bool {
	return repository.FullName != "" && len(repository.FullName) <= 256 &&
		repository.Owner.Login != "" && len(repository.Owner.Login) <= 128 &&
		repository.Name != "" && len(repository.Name) <= 128 &&
		repository.DefaultBranch != "" && len(repository.DefaultBranch) <= 256
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

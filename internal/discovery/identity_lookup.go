package discovery

import (
	"context"
	"errors"
	"time"

	protocolv0 "github.com/code4bones/branch/protocol/v0"
)

const (
	defaultIdentityLookupMaxSources    = 8
	defaultIdentityLookupMaxCandidates = 16
)

var ErrInvalidIdentityLookupConfig = errors.New("invalid identity lookup config")

// IdentityContactLookupSource is a bounded adapter for one carrier, peer relay,
// or local observation source. Implementations must not return durable mailbox
// state or plaintext payloads.
type IdentityContactLookupSource interface {
	ID() string
	LookupIdentityContact(ctx context.Context, branchID string) ([]IdentityContactCandidate, error)
}

// IdentityContactCandidate is one exact signed source record candidate returned
// by a lookup source.
type IdentityContactCandidate struct {
	Wrapper string
	Source  string
}

// IdentityContactLookupConfig defines bounded on-demand BranchID lookup.
type IdentityContactLookupConfig struct {
	Cache         *IdentityContactCache
	Sources       []IdentityContactLookupSource
	Now           func() time.Time
	MaxSources    int
	MaxCandidates int
}

// IdentityContactLookup resolves exact BranchID queries through the volatile
// local cache first, then a bounded source fanout. It is not a global directory.
type IdentityContactLookup struct {
	cache         *IdentityContactCache
	sources       []IdentityContactLookupSource
	now           func() time.Time
	maxCandidates int
}

// IdentityContactLookupResult returns the selected observation and a bounded
// operator trace of where the lookup went.
type IdentityContactLookupResult struct {
	BranchID    string
	Observation *IdentityContactObservation
	Trace       []IdentityContactLookupTrace
}

// IdentityContactLookupTrace is a redacted per-source lookup outcome.
type IdentityContactLookupTrace struct {
	Source    string
	Step      string
	Accepted  bool
	Reason    string
	Candidate int
}

// NewIdentityContactLookup creates an exact BranchID lookup coordinator.
func NewIdentityContactLookup(config IdentityContactLookupConfig) (*IdentityContactLookup, error) {
	if config.Cache == nil {
		return nil, ErrInvalidIdentityLookupConfig
	}
	maxSources := config.MaxSources
	if maxSources == 0 {
		maxSources = defaultIdentityLookupMaxSources
	}
	if maxSources < 0 || len(config.Sources) > maxSources {
		return nil, ErrInvalidIdentityLookupConfig
	}
	maxCandidates := config.MaxCandidates
	if maxCandidates == 0 {
		maxCandidates = defaultIdentityLookupMaxCandidates
	}
	if maxCandidates <= 0 {
		return nil, ErrInvalidIdentityLookupConfig
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	sources := make([]IdentityContactLookupSource, 0, len(config.Sources))
	for _, source := range config.Sources {
		if source == nil || source.ID() == "" {
			return nil, ErrInvalidIdentityLookupConfig
		}
		sources = append(sources, source)
	}
	return &IdentityContactLookup{
		cache:         config.Cache,
		sources:       sources,
		now:           now,
		maxCandidates: maxCandidates,
	}, nil
}

// Lookup resolves one exact BranchID. It stops after the first accepted signed
// contact observation and leaves all accepted candidates in the volatile cache.
func (lookup *IdentityContactLookup) Lookup(ctx context.Context, branchID string) IdentityContactLookupResult {
	result := IdentityContactLookupResult{BranchID: branchID}
	if err := protocolv0.ParseBranchID(branchID); err != nil {
		result.Trace = append(result.Trace, IdentityContactLookupTrace{
			Source:   "request",
			Step:     "validate_branch_id",
			Reason:   "invalid_branch_id",
			Accepted: false,
		})
		return result
	}
	if observation, ok := lookup.cache.Lookup(branchID); ok {
		result.Observation = &observation
		result.Trace = append(result.Trace, IdentityContactLookupTrace{
			Source:   "local_cache",
			Step:     "lookup",
			Reason:   "accepted",
			Accepted: true,
		})
		return result
	}
	result.Trace = append(result.Trace, IdentityContactLookupTrace{
		Source:   "local_cache",
		Step:     "lookup",
		Reason:   "miss",
		Accepted: false,
	})

	candidateCount := 0
	for _, source := range lookup.sources {
		if err := ctx.Err(); err != nil {
			result.Trace = append(result.Trace, IdentityContactLookupTrace{
				Source:   source.ID(),
				Step:     "lookup",
				Reason:   "aborted",
				Accepted: false,
			})
			return result
		}
		candidates, err := source.LookupIdentityContact(ctx, branchID)
		if err != nil {
			result.Trace = append(result.Trace, IdentityContactLookupTrace{
				Source:   source.ID(),
				Step:     "lookup",
				Reason:   "source_failed",
				Accepted: false,
			})
			continue
		}
		if len(candidates) == 0 {
			result.Trace = append(result.Trace, IdentityContactLookupTrace{
				Source:   source.ID(),
				Step:     "lookup",
				Reason:   "empty",
				Accepted: false,
			})
			continue
		}
		for _, candidate := range candidates {
			if candidateCount >= lookup.maxCandidates {
				result.Trace = append(result.Trace, IdentityContactLookupTrace{
					Source:   source.ID(),
					Step:     "candidate",
					Reason:   "candidate_limit",
					Accepted: false,
				})
				return result
			}
			candidateCount++
			validationOptions := protocolv0.IdentityContactValidationOptions{
				NowUnix: lookup.now().Unix(),
			}
			validation := protocolv0.ValidateBranchTextIdentityContact(candidate.Wrapper, validationOptions)
			if !validation.Accepted || validation.Contact == nil {
				result.Trace = append(result.Trace, IdentityContactLookupTrace{
					Source:    source.ID(),
					Step:      "candidate",
					Accepted:  false,
					Reason:    string(validation.Reason),
					Candidate: candidateCount,
				})
				continue
			}
			if validation.Contact.Payload.BranchID != branchID {
				result.Trace = append(result.Trace, IdentityContactLookupTrace{
					Source:    source.ID(),
					Step:      "candidate",
					Accepted:  false,
					Reason:    string(protocolv0.IdentityContactBranchIDMismatch),
					Candidate: candidateCount,
				})
				continue
			}
			cacheResult := lookup.cache.Accept(candidate.Wrapper, candidateSource(source.ID(), candidate.Source), validationOptions)
			trace := IdentityContactLookupTrace{
				Source:    source.ID(),
				Step:      "candidate",
				Accepted:  cacheResult.Accepted,
				Reason:    string(cacheResult.Reason),
				Candidate: candidateCount,
			}
			result.Trace = append(result.Trace, trace)
			if cacheResult.Accepted && cacheResult.Observation != nil && cacheResult.Observation.BranchID == branchID {
				result.Observation = cacheResult.Observation
				return result
			}
		}
	}
	return result
}

func candidateSource(sourceID string, candidateSource string) string {
	if candidateSource == "" {
		return sourceID
	}
	return sourceID + ":" + candidateSource
}

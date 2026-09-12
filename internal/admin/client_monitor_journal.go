package admin

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

const (
	DefaultClientMonitorJournalMaxBytes = 8 * 1024 * 1024
	DefaultClientMonitorJournalMaxFiles = 3
	DefaultClientMonitorJournalQueue    = 256
)

var ErrClientMonitorJournalConfig = errors.New("client monitor journal invalid config")

// ClientMonitorJournal is a best-effort development observer. Its Record
// method is non-blocking: pressure or a failed disk must never delay a client
// report handler, relay operation, or connectivity state transition.
type ClientMonitorJournal interface {
	Record(ClientMonitorReport, time.Time)
	Close() error
}

// ClientMonitorJournalConfig bounds a local development JSONL journal. Path is
// intentionally opt-in: no relay/node deployment gets durable client reports
// unless its local operator explicitly configures this sink.
type ClientMonitorJournalConfig struct {
	Path          string
	MaxBytes      int64
	MaxFiles      int
	QueueCapacity int
}

// ClientMonitorJournalEntry is one fully redacted accepted report. session_ref
// is random per browser refresh and is not a person, device, BranchID, or
// protocol session identifier.
type ClientMonitorJournalEntry struct {
	ObservedAt time.Time             `json:"observed_at"`
	SessionRef string                `json:"session_ref"`
	Release    string                `json:"release"`
	Sequence   uint64                `json:"sequence"`
	Snapshot   ClientMonitorSnapshot `json:"snapshot"`
	Events     []ClientMonitorEvent  `json:"events"`
}

type clientMonitorJournal struct {
	path     string
	maxBytes int64
	maxFiles int
	queue    chan ClientMonitorJournalEntry
	done     chan struct{}
	once     sync.Once
	recordMu sync.RWMutex
	dropped  atomic.Uint64
	errMu    sync.Mutex
	err      error
}

// NewClientMonitorJournal starts the bounded asynchronous local writer.
func NewClientMonitorJournal(config ClientMonitorJournalConfig) (ClientMonitorJournal, error) {
	if config.Path == "" {
		return nil, nil
	}
	if !filepath.IsAbs(config.Path) {
		return nil, fmt.Errorf("%w: path must be absolute", ErrClientMonitorJournalConfig)
	}
	if config.MaxBytes <= 0 {
		config.MaxBytes = DefaultClientMonitorJournalMaxBytes
	}
	if config.MaxFiles <= 0 {
		config.MaxFiles = DefaultClientMonitorJournalMaxFiles
	}
	if config.QueueCapacity <= 0 {
		config.QueueCapacity = DefaultClientMonitorJournalQueue
	}
	if config.MaxFiles > 9 || config.QueueCapacity > 4096 || config.MaxBytes < 1024 {
		return nil, ErrClientMonitorJournalConfig
	}
	journal := &clientMonitorJournal{
		path:     filepath.Clean(config.Path),
		maxBytes: config.MaxBytes,
		maxFiles: config.MaxFiles,
		queue:    make(chan ClientMonitorJournalEntry, config.QueueCapacity),
		done:     make(chan struct{}),
	}
	go journal.run()
	return journal, nil
}

func (journal *clientMonitorJournal) Record(report ClientMonitorReport, observedAt time.Time) {
	journal.recordMu.RLock()
	defer journal.recordMu.RUnlock()
	entry := ClientMonitorJournalEntry{
		ObservedAt: observedAt.UTC(),
		SessionRef: report.SessionRef,
		Release:    report.Release,
		Sequence:   report.Sequence,
		Snapshot:   cloneClientMonitorSnapshot(report.Snapshot),
		Events:     cloneClientMonitorEvents(report.Events),
	}
	select {
	case journal.queue <- entry:
	default:
		journal.dropped.Add(1)
	}
}

func (journal *clientMonitorJournal) Close() error {
	journal.once.Do(func() {
		journal.recordMu.Lock()
		close(journal.queue)
		journal.recordMu.Unlock()
		<-journal.done
	})
	journal.errMu.Lock()
	defer journal.errMu.Unlock()
	return journal.err
}

func (journal *clientMonitorJournal) run() {
	defer close(journal.done)
	for entry := range journal.queue {
		if err := journal.write(entry); err != nil {
			journal.dropped.Add(1)
			journal.errMu.Lock()
			journal.err = err
			journal.errMu.Unlock()
		}
	}
}

func (journal *clientMonitorJournal) write(entry ClientMonitorJournalEntry) error {
	line, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("marshal client monitor journal: %w", err)
	}
	line = append(line, '\n')
	info, err := os.Stat(journal.path)
	if err == nil && info.Size()+int64(len(line)) > journal.maxBytes {
		if err := journal.rotate(); err != nil {
			return err
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("stat client monitor journal: %w", err)
	}
	file, err := os.OpenFile(journal.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open client monitor journal: %w", err)
	}
	_, writeErr := file.Write(line)
	closeErr := file.Close()
	if writeErr != nil {
		return fmt.Errorf("write client monitor journal: %w", writeErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close client monitor journal: %w", closeErr)
	}
	return nil
}

func (journal *clientMonitorJournal) rotate() error {
	oldest := fmt.Sprintf("%s.%d.jsonl", journal.path, journal.maxFiles)
	if err := os.Remove(oldest); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove rotated client monitor journal: %w", err)
	}
	for index := journal.maxFiles - 1; index >= 1; index-- {
		from := fmt.Sprintf("%s.%d.jsonl", journal.path, index)
		to := fmt.Sprintf("%s.%d.jsonl", journal.path, index+1)
		if err := os.Rename(from, to); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("rotate client monitor journal: %w", err)
		}
	}
	if err := os.Rename(journal.path, fmt.Sprintf("%s.1.jsonl", journal.path)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("rotate client monitor journal: %w", err)
	}
	return nil
}

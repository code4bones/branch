package admin

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestClientMonitorJournalWritesRedactedJSONLAndRotates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client-monitor.jsonl")
	journal, err := NewClientMonitorJournal(ClientMonitorJournalConfig{Path: path, MaxBytes: 1024, MaxFiles: 2, QueueCapacity: 8})
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	for sequence := uint64(1); sequence <= 8; sequence++ {
		report := sampleClientMonitorReport()
		report.Sequence = sequence
		journal.Record(report, time.Date(2026, 9, 12, 9, 0, int(sequence), 0, time.UTC))
	}
	if err := journal.Close(); err != nil {
		t.Fatalf("close journal: %v", err)
	}
	files, err := filepath.Glob(path + "*")
	if err != nil {
		t.Fatalf("glob journal: %v", err)
	}
	if len(files) < 2 || len(files) > 3 {
		t.Fatalf("journal files = %v, want current plus bounded rotations", files)
	}
	for _, file := range files {
		lines, err := readJournalLines(file)
		if err != nil {
			t.Fatalf("read journal: %v", err)
		}
		for _, line := range lines {
			var entry ClientMonitorJournalEntry
			if err := json.Unmarshal(line, &entry); err != nil {
				t.Fatalf("journal JSON: %v", err)
			}
			if entry.SessionRef == "" || entry.Snapshot.Relay != "relay04" || len(entry.Events) != 1 {
				t.Fatalf("journal entry = %+v", entry)
			}
		}
	}
}

func TestClientMonitorJournalRejectsRelativePath(t *testing.T) {
	if _, err := NewClientMonitorJournal(ClientMonitorJournalConfig{Path: "client-monitor.jsonl"}); err == nil {
		t.Fatal("relative journal path accepted")
	}
}

func readJournalLines(path string) ([][]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	lines := [][]byte{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		lines = append(lines, append([]byte(nil), scanner.Bytes()...))
	}
	return lines, scanner.Err()
}

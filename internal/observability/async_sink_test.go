package observability

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type countingSink struct {
	count uint64
	err   error
}

func (sink *countingSink) Emit(context.Context, Envelope) error {
	atomic.AddUint64(&sink.count, 1)
	return sink.err
}

func TestAsyncSinkRejectsInvalidCapacity(t *testing.T) {
	_, err := NewAsyncSink(context.Background(), NoopSink{}, 0)
	if !errors.Is(err, ErrInvalidExporterQueue) {
		t.Fatalf("err = %v, want ErrInvalidExporterQueue", err)
	}
}

func TestAsyncSinkRejectsInvalidEnvelope(t *testing.T) {
	sink, err := NewAsyncSink(context.Background(), NoopSink{}, 1)
	if err != nil {
		t.Fatalf("new async sink: %v", err)
	}
	defer sink.Close()

	err = sink.Emit(context.Background(), Envelope{Event: "unknown", Level: LevelInfo})
	if !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("err = %v, want ErrInvalidEvent", err)
	}
}

func TestAsyncSinkDropsWhenQueueIsFull(t *testing.T) {
	block := make(chan struct{})
	target := SinkFunc(func(context.Context, Envelope) error {
		<-block
		return nil
	})
	sink, err := NewAsyncSink(context.Background(), target, 1)
	if err != nil {
		t.Fatalf("new async sink: %v", err)
	}
	defer func() {
		close(block)
		sink.Close()
	}()

	envelope, err := NewEnvelope(EventProcessStarted, LevelInfo)
	if err != nil {
		t.Fatalf("new envelope: %v", err)
	}
	for index := 0; index < 4; index++ {
		if err := sink.Emit(context.Background(), envelope); err != nil {
			t.Fatalf("emit: %v", err)
		}
	}

	if sink.ExporterDropped() == 0 {
		t.Fatal("expected dropped events")
	}
}

func TestAsyncSinkCountsExporterFailuresWithoutReturningThem(t *testing.T) {
	target := &countingSink{err: errors.New("exporter unavailable")}
	sink, err := NewAsyncSink(context.Background(), target, 4)
	if err != nil {
		t.Fatalf("new async sink: %v", err)
	}
	defer sink.Close()

	envelope, err := NewEnvelope(EventProcessStarted, LevelInfo)
	if err != nil {
		t.Fatalf("new envelope: %v", err)
	}

	if err := sink.Emit(context.Background(), envelope); err != nil {
		t.Fatalf("emit: %v", err)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if sink.ExporterFailed() == 1 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("exporter failure was not counted")
}

func TestAsyncSinkCancelledEmitIsNoop(t *testing.T) {
	target := &countingSink{}
	sink, err := NewAsyncSink(context.Background(), target, 1)
	if err != nil {
		t.Fatalf("new async sink: %v", err)
	}
	defer sink.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	envelope, err := NewEnvelope(EventProcessStarted, LevelInfo)
	if err != nil {
		t.Fatalf("new envelope: %v", err)
	}

	if err := sink.Emit(ctx, envelope); err != nil {
		t.Fatalf("emit: %v", err)
	}
	if got := atomic.LoadUint64(&target.count); got != 0 {
		t.Fatalf("target count = %d, want 0", got)
	}
}

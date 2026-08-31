package observability

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
)

const DefaultExporterQueueCapacity = 256

var ErrInvalidExporterQueue = errors.New("invalid observability exporter queue")

// AsyncSink forwards validated events to a possibly slow exporter through a
// bounded queue. Exporter failures and full queues are counted but not returned
// to connectivity callers.
type AsyncSink struct {
	target Sink
	queue  chan Envelope
	done   chan struct{}
	once   sync.Once
	cancel context.CancelFunc

	dropped uint64
	failed  uint64
}

// NewAsyncSink starts a bounded exporter worker owned by parent.
func NewAsyncSink(parent context.Context, target Sink, capacity int) (*AsyncSink, error) {
	if parent == nil {
		parent = context.Background()
	}
	if target == nil {
		target = NoopSink{}
	}
	if capacity <= 0 {
		return nil, ErrInvalidExporterQueue
	}

	ctx, cancel := context.WithCancel(parent)
	sink := &AsyncSink{
		target: target,
		queue:  make(chan Envelope, capacity),
		done:   make(chan struct{}),
		cancel: cancel,
	}
	go sink.run(ctx)
	return sink, nil
}

// Emit enqueues a valid event without blocking. A full queue drops the event.
func (sink *AsyncSink) Emit(ctx context.Context, envelope Envelope) error {
	if ctx.Err() != nil {
		return nil
	}
	if err := envelope.Validate(); err != nil {
		return err
	}

	select {
	case sink.queue <- envelope:
	default:
		atomic.AddUint64(&sink.dropped, 1)
	}
	return nil
}

// Close stops the exporter worker.
func (sink *AsyncSink) Close() {
	sink.once.Do(func() {
		sink.cancel()
		<-sink.done
	})
}

// ExporterDropped returns the number of events dropped before export.
func (sink *AsyncSink) ExporterDropped() uint64 {
	return atomic.LoadUint64(&sink.dropped)
}

// ExporterFailed returns the number of exporter emit failures.
func (sink *AsyncSink) ExporterFailed() uint64 {
	return atomic.LoadUint64(&sink.failed)
}

func (sink *AsyncSink) run(ctx context.Context) {
	defer close(sink.done)

	for {
		select {
		case <-ctx.Done():
			return
		case envelope := <-sink.queue:
			if err := sink.target.Emit(ctx, envelope); err != nil {
				atomic.AddUint64(&sink.failed, 1)
			}
		}
	}
}

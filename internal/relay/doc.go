// Package relay owns bounded, memory-only live transit state.
//
// It does not define wire bytes, authenticate peers, persist messages, or act
// as an identity directory. Transport adapters attach live sessions, pair them
// into routes after admission, and forward opaque encrypted frames while both
// sessions remain connected.
package relay

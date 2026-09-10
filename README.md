# B.R.A.N.C.H.

[![B.R.A.N.C.H. — Carry the Ribbon](samples/logos/branch-github-badge.svg)](docs/HERITAGE.md)

**Blue Ribbon Autonomous Network for Carrier Hopping**

> **The Blue Ribbon is alive again.**  
> **From symbol to protocol.**

B.R.A.N.C.H. is an open communication protocol built around portable identity,
public rendezvous surfaces, direct peer-to-peer connections, and a community-run
mesh of interchangeable relays.

The project is an independent technical tribute to the
[Blue Ribbon Online Free Speech Campaign](https://www.eff.org/pages/blue-ribbon-campaign)
and its defence of freedom of speech, press, and association on the Internet.
It is not affiliated with or endorsed by the Electronic Frontier Foundation.

## The idea

The original Blue Ribbon was displayed on websites as a symbol of free speech
online. B.R.A.N.C.H. brings it back not merely as a symbol, but as a protocol.

The ribbon no longer merely hangs on the Web. It becomes a route through it.

In B.R.A.N.C.H.:

- identity belongs to the person, not to a server;
- any public writable surface may carry a rendezvous event;
- clients prefer direct P2P communication;
- any enthusiast may operate a compatible relay;
- no relay, platform, directory, or project-controlled service is mandatory;
- carriers can change while identity and conversation continuity remain intact.

## What “Carrier Hopping” means

A carrier is any medium capable of carrying a signed rendezvous event or an
encrypted packet: a GitHub Issue, a forum, a public comment feed, Nostr, DHT,
email, a community relay, or a direct peer connection.

A session may begin on one carrier and continue on another:

```text
public board -> rendezvous -> community relay -> direct P2P -> another relay
```

The carrier is replaceable. The relationship between people is not.

## Project status

This repository currently contains the founding documents and the first
protocol sketch. The next milestone is a desktop proof of concept with two
clients, one public-board adapter, direct connectivity, and two independently
operated relays.

## Documents

- [MANIFESTO.md](docs/MANIFESTO.md) — purpose and non-negotiable principles.
- [HERITAGE.md](docs/HERITAGE.md) — the Blue Ribbon historical foundation.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — system boundaries and components.
- [PROTOCOL_V0.md](docs/PROTOCOL_V0.md) — initial protocol sketch.
- [ROADMAP.md](docs/ROADMAP.md) — staged path to a working prototype.
- [OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md) — questions intentionally left open.
- [ENGINEERING.md](docs/ENGINEERING.md) — repository architecture, code style,
  test strategy, and quality gates.
- [OBSERVABILITY.md](docs/OBSERVABILITY.md) — logs, metrics, traces,
  diagnostics, privacy boundaries, and optional development monitoring.

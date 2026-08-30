# B.R.A.N.C.H. Roadmap

The roadmap begins by proving independence from project-owned infrastructure.
Features are secondary until that property works end to end.

## Phase 0 — Foundation

- Publish the manifesto and Blue Ribbon heritage statement.
- Define project terminology and non-negotiable principles.
- Draft the signed event envelope.
- Define the board adapter boundary.
- Define relay responsibilities and explicit non-responsibilities.
- Choose a license and governance model.

Exit condition: independent implementers can understand what the project is and
what it refuses to become.

## Phase 1 — Public rendezvous proof

- Create two local identities.
- Implement one public-board adapter.
- Publish encrypted offer and answer events.
- Verify signatures, expiry, replay protection, and deduplication.
- Establish an authenticated session on the same local network.

Exit condition: the public board is used only to establish the session and can
be removed afterward.

## Phase 2 — Internet connectivity proof

- Add ICE-based connectivity discovery.
- Attempt direct IPv6 and UDP paths.
- Implement the smallest usable relay daemon.
- Run two relays under independent operator configurations.
- Migrate an active session between direct and relayed paths.

Exit condition: two clients behind unrelated networks can communicate and
survive loss of their current carrier.

## Phase 3 — Community operation

- Package the relay as a single binary and container image.
- Add signed relay announcements.
- Add capability-based admission and resource limits.
- Add multiple rendezvous adapters.
- Document home relay and public relay operation.
- Build interoperability tests independent of the reference client.

Exit condition: a third party can run a relay and a second implementation can
join without project approval.

## Phase 4 — Mobile exploration

- Prototype Android background behaviour.
- Separate wake-up signals from encrypted message delivery.
- Add store-and-forward with strict quotas and expiry.
- Explore multi-device identity and recovery.
- Test carrier changes between Wi-Fi and mobile networks.

Exit condition: mobile limitations are documented from working prototypes, not
assumed away.

## Deferred

Groups, calls, large files, public channels, sophisticated anonymity, reputation,
and incentive systems begin only after the two-party carrier-hopping path is
proven.


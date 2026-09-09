import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applicationControlSigningBytes,
  betaHpkeCiphertextBytesForPlaintext,
  createBetaPayloadKeyPair,
  decodeBase64URL,
  decodeDraftRelayAttachmentFrameText,
  developmentProfileMultihash,
  encodeApplicationControl,
  encodeBase64URL,
  makeBetaPayloadAAD,
  maxDraftRelayCiphertextBytes,
  prepareOutboundApplicationControl,
  protocolID,
  sealBetaPayload,
  SameRelayTransportClient,
  type ApplicationControlDescriptor
} from "@code4bones/branch-core";

import { openIncomingEnvelope } from "../src/connectivity/open-envelope.js";
import { createDeliveryID } from "../src/connectivity/seal-and-send.js";
import { classifyIncomingMessage } from "../src/connectivity/incoming-message.js";
import { receiveTypingControl, typingControlKind, typingControlPayloadPrefix, typingControlTTLms } from "../src/connectivity/typing-control.js";
import {
  betaPwaMessageType,
  betaPwaPresencePingType,
  betaPwaPresencePongType,
  decodeBetaPwaApplicationPayload,
  decodeBetaPwaMessagePayload,
  encodeBetaPwaMessagePayload,
  encodeBetaPwaPresencePing,
  encodeBetaPwaPresencePong
} from "../src/connectivity/message-payload.js";
import { createAppStore } from "../src/state/store.js";
import { groupMessagesByContactId, orderConversationMessages } from "../src/state/slices/conversations-slice.js";
import { orderedAttachmentRoutes } from "../src/connectivity/relay-route-selection.js";

const indexHtmlPath = resolve(process.cwd(), "public/index.html");
const manifestPath = resolve(process.cwd(), "public/manifest.json");
const swPath = resolve(process.cwd(), "src/sw.ts");
const appPath = resolve(process.cwd(), "src/app/App.tsx");
const appShellPath = resolve(process.cwd(), "src/app/AppShell.tsx");
const requireIdentityPath = resolve(process.cwd(), "src/app/RequireIdentity.tsx");
const storePath = resolve(process.cwd(), "src/state/store.ts");
const storeProviderPath = resolve(process.cwd(), "src/state/StoreProvider.tsx");
const hooksPath = resolve(process.cwd(), "src/state/hooks.ts");
const mainPath = resolve(process.cwd(), "src/main.tsx");
const chatListSidebarPath = resolve(process.cwd(), "src/app/ChatListSidebar.tsx");
const formatTimePath = resolve(process.cwd(), "src/app/format-time.ts");
const detailHeaderPath = resolve(process.cwd(), "src/app/DetailHeader.tsx");
const useMediaQueryPath = resolve(process.cwd(), "src/app/use-media-query.ts");
const chatPagePath = resolve(process.cwd(), "src/pages/ChatPage.tsx");
const buildScriptPath = resolve(process.cwd(), "scripts/build-static.mjs");
const nginxConfigPath = resolve(process.cwd(), "../deployments/nginx/branch.undoo.ru.conf");
const requireRoutePath = resolve(process.cwd(), "src/app/RequireRoute.tsx");
const discoveryPagePath = resolve(process.cwd(), "src/pages/DiscoveryPage.tsx");
const findRelayRoutePath = resolve(process.cwd(), "src/discovery/find-relay-route.ts");
const transportSlicePath = resolve(process.cwd(), "src/state/slices/transport-slice.ts");
const relaySessionPath = resolve(process.cwd(), "src/connectivity/relay-session.ts");
const sealAndSendPath = resolve(process.cwd(), "src/connectivity/seal-and-send.ts");
const openEnvelopePath = resolve(process.cwd(), "src/connectivity/open-envelope.ts");
const useRelayTransportPath = resolve(process.cwd(), "src/connectivity/use-relay-transport.ts");
const settingsPagePath = resolve(process.cwd(), "src/pages/SettingsPage.tsx");
const chatListSidebarForContactPath = resolve(process.cwd(), "src/app/ChatListSidebar.tsx");
const packageJsonPath = resolve(process.cwd(), "package.json");
const createLocalIdentityPath = resolve(process.cwd(), "src/identity/create-local-identity.ts");
const identityKeysPath = resolve(process.cwd(), "src/identity/identity-keys.ts");
const identitySlicePath = resolve(process.cwd(), "src/state/slices/identity-slice.ts");
const srcDir = resolve(process.cwd(), "src");
const databasePath = resolve(process.cwd(), "src/storage/database.ts");
const contactsStorePath = resolve(process.cwd(), "src/storage/contacts-store.ts");
const messagesStorePath = resolve(process.cwd(), "src/storage/messages-store.ts");
const readStateStorePath = resolve(process.cwd(), "src/storage/read-state-store.ts");
const conversationsBootstrapPath = resolve(process.cwd(), "src/storage/use-conversations-bootstrap.ts");
const contactsSlicePath = resolve(process.cwd(), "src/state/slices/contacts-slice.ts");
const conversationsSlicePath = resolve(process.cwd(), "src/state/slices/conversations-slice.ts");
const readStateSlicePath = resolve(process.cwd(), "src/state/slices/read-state-slice.ts");
const hydrationSlicePath = resolve(process.cwd(), "src/state/slices/hydration-slice.ts");
const connectionSlicePath = resolve(process.cwd(), "src/state/slices/connection-slice.ts");
const echoChatPagePath = resolve(process.cwd(), "src/pages/EchoChatPage.tsx");
const appPathsPath = resolve(process.cwd(), "src/app/paths.ts");
const branchIdPath = resolve(process.cwd(), "src/identity/branch-id.ts");
const lookupIdentityContactPath = resolve(process.cwd(), "src/discovery/lookup-identity-contact.ts");
const contactRouteLookupPath = resolve(process.cwd(), "src/app/ContactRouteLookup.tsx");
const messagePayloadPath = resolve(process.cwd(), "src/connectivity/message-payload.ts");
const incomingMessagePath = resolve(process.cwd(), "src/connectivity/incoming-message.ts");
const messageRequestsSlicePath = resolve(process.cwd(), "src/state/slices/message-requests-slice.ts");
const messageRequestsPagePath = resolve(process.cwd(), "src/pages/MessageRequestsPage.tsx");
const contactPresencePath = resolve(process.cwd(), "src/app/ContactPresence.tsx");
const contactPresenceSlicePath = resolve(process.cwd(), "src/state/slices/contact-presence-slice.ts");
const messageLogPath = resolve(process.cwd(), "src/app/MessageLog.tsx");
const typingControlPath = resolve(process.cwd(), "src/connectivity/typing-control.ts");
const contactTypingSlicePath = resolve(process.cwd(), "src/state/slices/contact-typing-slice.ts");
const relayRouteSelectionPath = resolve(process.cwd(), "src/connectivity/relay-route-selection.ts");
const pwaReleasePath = resolve(process.cwd(), "src/app/pwa-release.ts");

void test("pwa shell html references the bundled app and manifest under /pwa/", async () => {
  const html = await readFile(indexHtmlPath, "utf8");

  assert.match(html, /\/pwa\/pwa-app\.js/);
  assert.match(html, /\/pwa\/pwa-app\.css/);
  assert.match(html, /\/pwa\/pwa\.css/);
  assert.match(html, /rel="manifest" href="\/pwa\/manifest\.json"/);
  assert.match(html, /id="pwa-root"/);
  assert.doesNotMatch(html, /login|password|token/i);
});

void test("pwa manifest is scoped under /pwa/", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    readonly start_url: string;
    readonly scope: string;
    readonly icons: readonly { readonly src: string }[];
  };

  assert.equal(manifest.start_url, "/pwa/");
  assert.equal(manifest.scope, "/pwa/");
  assert.ok(manifest.icons.length > 0);
  assert.ok(manifest.icons.every((icon) => icon.src.startsWith("/pwa/")));
});

void test("service worker only caches the /pwa/ shell and never intercepts cross-origin or non-GET requests", async () => {
  const source = await readFile(swPath, "utf8");
  const releaseSource = await readFile(pwaReleasePath, "utf8");

  assert.match(source, /addEventListener\("install"/);
  assert.match(source, /addEventListener\("activate"/);
  assert.match(source, /addEventListener\("fetch"/);
  assert.match(source, /request\.method !== "GET"/);
  assert.match(source, /url\.origin !== self\.location\.origin/);
  assert.match(source, /!url\.pathname\.startsWith\("\/pwa\/"\)/);
  assert.doesNotMatch(source, /wss:\/\/|fetch\(\s*["'`]https/);
  assert.match(source, /branch-pwa-shell-\$\{pwaReleaseVersion\}/);
  assert.match(releaseSource, /__BRANCH_PWA_VERSION__/);
});

void test("app composition uses provider + hooks, not prop drilling", async () => {
  const app = await readFile(appPath, "utf8");
  const appShell = await readFile(appShellPath, "utf8");
  const requireIdentity = await readFile(requireIdentityPath, "utf8");
  const store = await readFile(storePath, "utf8");
  const storeProvider = await readFile(storeProviderPath, "utf8");
  const hooks = await readFile(hooksPath, "utf8");
  const main = await readFile(mainPath, "utf8");

  assert.match(app, /AppStoreProvider/);
  assert.match(app, /useThemeControls/);
  assert.match(app, /BrowserRouter basename="\/pwa"/);
  assert.match(app, /RequireIdentity/);
  assert.doesNotMatch(app, /identity=\{|theme=\{[a-zA-Z]+\}\s*\/>/);
  assert.match(appShell, /useLocation/);
  assert.match(appShell, /useIsMobile/);
  assert.match(appShell, /ChatListSidebar/);
  assert.match(requireIdentity, /useIdentity/);
  assert.match(requireIdentity, /Navigate replace to="\/onboarding"/);
  assert.match(store, /zustand\/vanilla/);
  assert.match(store, /createUiSlice/);
  assert.match(store, /createIdentitySlice/);
  assert.match(store, /createContactsSlice/);
  assert.match(store, /createConversationsSlice/);
  assert.match(store, /createReadStateSlice/);
  assert.match(storeProvider, /createContext<AppStoreApi \| null>/);
  assert.match(storeProvider, /useStore\(store, selector\)/);
  assert.match(hooks, /export function useThemeControls/);
  assert.match(hooks, /export function useIdentity/);
  assert.match(hooks, /export function useContacts/);
  assert.match(hooks, /export function useConversation/);
  assert.match(hooks, /export function useChatList/);
  assert.match(hooks, /export function useMarkContactRead/);
  assert.match(main, /createRoot/);
  assert.match(main, /antd\/dist\/reset\.css/);
  assert.match(main, /registerServiceWorker/);
});

void test("chat list sidebar and mobile back navigation stay decoupled via hooks, not props", async () => {
  const chatListSidebar = await readFile(chatListSidebarPath, "utf8");
  const detailHeader = await readFile(detailHeaderPath, "utf8");
  const useMediaQuery = await readFile(useMediaQueryPath, "utf8");
  const chatPage = await readFile(chatPagePath, "utf8");

  assert.match(chatListSidebar, /useChatList/);
  assert.match(chatListSidebar, /useNavigate/);
  assert.match(chatListSidebar, /Input\.Search/);
  assert.match(chatListSidebar, /Badge/);
  assert.doesNotMatch(chatListSidebar, /useIsMobile/);
  assert.match(detailHeader, /useIsMobile/);
  assert.match(detailHeader, /isMobile &&/);
  assert.match(detailHeader, /ArrowLeftOutlined/);
  assert.match(useMediaQuery, /export function useIsMobile/);
  assert.match(useMediaQuery, /max-width: 767px/);
  assert.match(chatPage, /DetailHeader/);
  assert.match(chatPage, /useMarkContactRead/);
});

void test("build script bundles the app and service worker from local dependencies only", async () => {
  const source = await readFile(buildScriptPath, "utf8");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    readonly scripts: Record<string, string>;
    readonly version: string;
  };
  const settingsPage = await readFile(settingsPagePath, "utf8");

  assert.match(source, /src\/main\.tsx/);
  assert.match(source, /src\/sw\.ts/);
  assert.match(source, /pwa-app\.js/);
  assert.match(source, /sw\.js/);
  assert.match(source, /esbuild/);
  assert.match(source, /__BRANCH_PWA_VERSION__/);
  assert.match(packageJson.version, /^\d+\.\d+\.\d+-beta\.\d+$/);
  assert.match(packageJson.scripts.release ?? "", /npm version prerelease/);
  assert.match(settingsPage, /pwaReleaseVersion/);
});

void test("identity uses @code4bones/branch-core, persists via IndexedDB, and keeps private keys out of the Zustand store", async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    readonly dependencies: Record<string, string>;
  };
  const createLocalIdentity = await readFile(createLocalIdentityPath, "utf8");
  const identityKeys = await readFile(identityKeysPath, "utf8");
  const identitySlice = await readFile(identitySlicePath, "utf8");

  assert.match(packageJson.dependencies["@code4bones/branch-core"] ?? "", /^file:/);
  assert.match(createLocalIdentity, /from "@code4bones\/branch-core"/);
  assert.match(createLocalIdentity, /SameRelayTransportClient\.createIdentity/);
  assert.match(createLocalIdentity, /createBetaPayloadKeyPair/);
  assert.match(createLocalIdentity, /saveStoredIdentity/);
  assert.match(identityKeys, /CryptoKey/);
  assert.doesNotMatch(identitySlice, /CryptoKey/);
});

void test("the messenger interface only appears after relay discovery finds a route", async () => {
  const app = await readFile(appPath, "utf8");
  const requireRoute = await readFile(requireRoutePath, "utf8");
  const discoveryPage = await readFile(discoveryPagePath, "utf8");
  const findRelayRoute = await readFile(findRelayRoutePath, "utf8");

  assert.match(app, /path="discovery"/);
  assert.match(app, /<RequireRoute>/);
  assert.match(requireRoute, /routeStatus !== "found"/);
  assert.match(requireRoute, /Navigate replace to=\{DISCOVERY_PATH\}/);
  assert.match(discoveryPage, /findRelayRouteViaGitHub/);
  assert.match(discoveryPage, /routeStatus === "found"/);
  assert.match(findRelayRoute, /from "@code4bones\/branch-core"/);
  assert.match(findRelayRoute, /createGitHubSearchCarrier/);
  assert.match(findRelayRoute, /routesFromBeaconObservations/);
});

void test("no pwa source file imports from web/**", async () => {
  const offenders: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) {
        continue;
      }
      const source = await readFile(entryPath, "utf8");
      if (/from\s+["'].*\/web\//.test(source) || /from\s+["']\.\.\/web\//.test(source)) {
        offenders.push(entryPath);
      }
    }
  }

  await walk(srcDir);
  assert.deepEqual(offenders, []);
});

void test("relay attach and message sealing keep canonical protocol state out of Zustand and the AAD conventions consistent", async () => {
  const transportSlice = await readFile(transportSlicePath, "utf8");
  const relaySession = await readFile(relaySessionPath, "utf8");
  const sealAndSend = await readFile(sealAndSendPath, "utf8");
  const openEnvelope = await readFile(openEnvelopePath, "utf8");
  const useRelayTransport = await readFile(useRelayTransportPath, "utf8");

  assert.doesNotMatch(transportSlice, /from "@code4bones\/branch-core"|: CryptoKey/);
  assert.match(relaySession, /SameRelayTransportClient/);
  assert.match(relaySession, /trackedDeliveries/);
  assert.match(relaySession, /hasAttachedRelaySession/);
  assert.match(relaySession, /client !== null && client\.routeId !== null/);
  assert.match(relaySession, /maxTrackedDeliveries = 64/);
  assert.match(relaySession, /relayAcknowledgementTimeoutMs = 12_000/);
  assert.match(relaySession, /client = nextClient/);
  assert.match(relaySession, /relay attachment cancelled/);
  assert.match(sealAndSend, /sealBetaPayload/);
  assert.match(sealAndSend, /betaHpkeCiphertextBytesForPlaintext/);
  assert.match(sealAndSend, /const originRouteId = client\.routeId/);
  assert.match(sealAndSend, /client === null \|\| client\.routeId === null/);
  assert.match(sealAndSend, /senderPeerKey: options\.senderPeerId/);
  assert.match(sealAndSend, /recipientPeerKey: options\.recipientPeerId/);
  assert.match(sealAndSend, /hpkeCiphertextBytes: expectedCiphertextBytes/);
  assert.match(sealAndSend, /expectedCiphertextBytes/);
  assert.match(sealAndSend, /createDeliveryID/);
  assert.match(sealAndSend, /encodeBase64URL/);
  assert.match(sealAndSend, /client\.rendezvous\(options\.recipientPeerId\)/);
  assert.doesNotMatch(sealAndSend, /crypto\.randomUUID/);
  assert.match(sealAndSend, /sendSealedEnvelope\(sealed, \{ deliveryId: options\.deliveryId, originRouteId, ackRequested: fixedAckRequested \}\)/);
  assert.match(sealAndSend, /from "\.\/payload-aad-defaults\.js"/);
  assert.match(openEnvelope, /openBetaPayload/);
  assert.match(openEnvelope, /betaHpkeCiphertextBytesFromSealedPayload/);
  assert.match(openEnvelope, /originRouteId: options\.originRouteId/);
  assert.match(openEnvelope, /senderPeerKey: options\.senderPeerId/);
  assert.match(openEnvelope, /recipientPeerKey: options\.recipientPeerId/);
  assert.match(openEnvelope, /expectedCiphertextBytes/);
  assert.match(openEnvelope, /from "\.\/payload-aad-defaults\.js"/);
  assert.match(useRelayTransport, /case "relay_ack"/);
  assert.match(useRelayTransport, /case "peer_receipt"/);
  assert.match(useRelayTransport, /case "peer_unavailable"/);
  assert.match(useRelayTransport, /case "envelope_received"/);
  assert.match(useRelayTransport, /event\.originRouteId/);
  assert.match(useRelayTransport, /originRouteId,/);
  assert.match(useRelayTransport, /storeApi\.getState\(\)/);
  assert.match(useRelayTransport, /ERROR has no delivery_id/);
  assert.match(useRelayTransport, /reconnectMaxAttempts = 6/);
  assert.match(useRelayTransport, /scheduleReconnect/);
  assert.match(useRelayTransport, /client\.heartbeatIntervalSeconds/);
  assert.match(useRelayTransport, /for \(const \[index, route\] of attachmentRoutes\.entries\(\)\)/);
  assert.match(useRelayTransport, /No discovered relay accepted attachment/);
  assert.match(useRelayTransport, /attachmentKey\(route, identity\.peerId\)/);
  assert.match(useRelayTransport, /orderedAttachmentRoutes\(discoveredRoutes\)/);
  assert.match(useRelayTransport, /getRelaySessionClient\(\) !== attachedClient/);
  assert.match(useRelayTransport, /lifecycle\.connectingKey = null;/);
  assert.match(useRelayTransport, /READY -> attached window/);
  assert.match(useRelayTransport, /operation-level rejection/);
  assert.match(useRelayTransport, /getRelaySessionClient\(\)\?\.routeId !== null/);
  assert.match(useRelayTransport, /disconnectTraceDetail/);
  assert.match(useRelayTransport, /relay closed remotely; code=/);
  assert.doesNotMatch(useRelayTransport, /HEARTBEAT_INTERVAL_MS/);
});

void test("PWA message delivery identifiers are canonical random 16-byte base64url tokens", () => {
  const deliveryId = createDeliveryID((bytes) => {
    bytes.set(Array.from({ length: 16 }, (_, index) => index));
    return bytes;
  });

  assert.deepEqual(Array.from(decodeBase64URL(deliveryId)), Array.from({ length: 16 }, (_, index) => index));
  assert.match(deliveryId, /^[A-Za-z0-9_-]{22}$/);
  assert.doesNotMatch(deliveryId, /=/);
});

void test("PWA relay trace is bounded local diagnostic state and never protocol state", async () => {
  const store = createAppStore();
  for (let index = 0; index < 30; index += 1) {
    store.getState().recordTransportTrace(`event-${String(index)}`);
  }
  const trace = store.getState().transportTrace;
  assert.equal(trace.length, 24);
  assert.equal(trace[0]?.detail, "event-6");
  assert.equal(trace.at(-1)?.detail, "event-29");

  const slice = await readFile(transportSlicePath, "utf8");
  const settings = await readFile(settingsPagePath, "utf8");
  assert.match(slice, /maxTransportTraceEntries = 24/);
  assert.match(slice, /recordTransportTrace/);
  assert.doesNotMatch(slice, /IndexedDB|saveStored|fetch\(|WebSocket/);
  assert.match(settings, /Relay trace/);
});

void test("PWA chooses a deterministic local attachment order from the same validated relay set", async () => {
  const selection = await readFile(relayRouteSelectionPath, "utf8");
  const routes = orderedAttachmentRoutes([
    { endpointUri: "wss://relay05.example.test:443/relay/v0", relayPublicKey: "b", profileMultihash: "profile" },
    { endpointUri: "wss://relay01.example.test:443/relay/v0", relayPublicKey: "z", profileMultihash: "profile" },
    { endpointUri: "wss://relay01.example.test:443/relay/v0", relayPublicKey: "a", profileMultihash: "profile" }
  ]);

  assert.deepEqual(routes.map((route) => route.relayPublicKey), ["a", "z", "b"]);
  assert.match(selection, /Carrier ordering is untrusted presentation data/);
});

void test("PWA correlates a sent message with the relay delivery acknowledgement", async () => {
  const chatPage = await readFile(chatPagePath, "utf8");
  assert.match(chatPage, /const deliveryId = createDeliveryID\(\);/);
  assert.match(chatPage, /messageId: deliveryId,/);
  assert.match(chatPage, /deliveryId,\n\s*plaintext: body/);
  assert.doesNotMatch(chatPage, /messageId: crypto\.randomUUID\(\)/);
});

void test("PWA beta message payload is strict, bounded, and carries a reply key", () => {
  const replyHpkePublicKey = Buffer.alloc(32, 17).toString("base64url");
  const senderDisplayName = "Alice";
  const encoded = encodeBetaPwaMessagePayload({ body: "first contact", replyHpkePublicKey, senderDisplayName });

  assert.equal(encoded, JSON.stringify({
    type: betaPwaMessageType,
    body: "first contact",
    reply_hpke_public_key: replyHpkePublicKey,
    sender_display_name: senderDisplayName
  }));
  assert.deepEqual(decodeBetaPwaMessagePayload(encoded), {
    type: betaPwaMessageType,
    body: "first contact",
    replyHpkePublicKey,
    senderDisplayName
  });
  assert.throws(() => { decodeBetaPwaMessagePayload(JSON.stringify({ type: betaPwaMessageType, body: "first contact" })); });
  assert.throws(() => { encodeBetaPwaMessagePayload({ body: "first contact", replyHpkePublicKey: "not-a-key", senderDisplayName }); });
});

void test("PWA classifies an authenticated unknown sender as a local message request", () => {
  const senderPeerId = Buffer.alloc(32, 8).toString("base64url");
  const replyHpkePublicKey = Buffer.alloc(32, 9).toString("base64url");
  const senderDisplayName = "Alice";
  const plaintext = encodeBetaPwaMessagePayload({ body: "request body", replyHpkePublicKey, senderDisplayName });

  assert.deepEqual(classifyIncomingMessage({ plaintext, senderPeerId, knownContactId: "contact-1" }), {
    kind: "known_contact_message",
    contactId: "contact-1",
    body: "request body"
  });
  assert.deepEqual(classifyIncomingMessage({ plaintext, senderPeerId, knownContactId: null }), {
    kind: "message_request",
    senderPeerId,
    senderHpkePublicKey: replyHpkePublicKey,
    senderDisplayName,
    body: "request body"
  });
  assert.deepEqual(classifyIncomingMessage({ plaintext: "legacy text", senderPeerId, knownContactId: null }), {
    kind: "drop_unknown_legacy"
  });
  assert.throws(() => { classifyIncomingMessage({ plaintext, senderPeerId: "bad", knownContactId: null }); });
});

void test("PWA presence controls are strict encrypted ping-pong payloads and never invite unknown traffic", () => {
  const senderPeerId = Buffer.alloc(32, 8).toString("base64url");
  const pingId = Buffer.alloc(16, 13).toString("base64url");
  const ping = encodeBetaPwaPresencePing(pingId);
  const pong = encodeBetaPwaPresencePong(pingId);

  assert.equal(ping, JSON.stringify({ type: betaPwaPresencePingType, ping_id: pingId }));
  assert.equal(pong, JSON.stringify({ type: betaPwaPresencePongType, ping_id: pingId }));
  assert.deepEqual(decodeBetaPwaApplicationPayload(ping), { type: betaPwaPresencePingType, pingId });
  assert.deepEqual(decodeBetaPwaApplicationPayload(pong), { type: betaPwaPresencePongType, pingId });
  assert.deepEqual(classifyIncomingMessage({ plaintext: ping, senderPeerId, knownContactId: "contact-1" }), {
    kind: "known_contact_presence_ping", contactId: "contact-1", pingId
  });
  assert.deepEqual(classifyIncomingMessage({ plaintext: pong, senderPeerId, knownContactId: "contact-1" }), {
    kind: "known_contact_presence_pong", contactId: "contact-1", pingId
  });
  assert.deepEqual(classifyIncomingMessage({ plaintext: ping, senderPeerId, knownContactId: null }), { kind: "drop_unknown_control" });
  assert.throws(() => { decodeBetaPwaApplicationPayload(JSON.stringify({ type: betaPwaPresencePingType, ping_id: "bad" })); });
});

void test("PWA accepts only a matching pong into bounded in-memory contact presence", () => {
  const store = createAppStore();
  const pingId = Buffer.alloc(16, 21).toString("base64url");
  store.getState().beginContactPresencePing("contact-1", pingId);
  const checking = store.getState().contactPresenceById["contact-1"];
  assert.equal(checking?.status, "checking");
  store.getState().acceptContactPresencePong("contact-1", Buffer.alloc(16, 22).toString("base64url"));
  assert.equal(store.getState().contactPresenceById["contact-1"]?.status, "checking");
  store.getState().acceptContactPresencePong("contact-1", pingId);
  const available = store.getState().contactPresenceById["contact-1"];
  if (available === undefined) {
    throw new Error("matching pong did not create contact presence");
  }
  assert.equal(available.status, "available");
  const renewalPingId = Buffer.alloc(16, 23).toString("base64url");
  store.getState().beginContactPresencePing("contact-1", renewalPingId);
  assert.equal(store.getState().contactPresenceById["contact-1"]?.status, "available");
  store.getState().expireContactPresencePing("contact-1", renewalPingId);
  assert.equal(store.getState().contactPresenceById["contact-1"]?.status, "available");
  store.getState().expireContactPresence("contact-1", available.updatedAt);
  assert.equal(store.getState().contactPresenceById["contact-1"]?.status, "unknown");
});

void test("PWA conversation ordering is chronological and stable across hydration and append", () => {
  const messages = [
    { messageId: "z", contactId: "contact-1", direction: "incoming" as const, body: "third", sentAt: 20, deliveryState: "received" as const },
    { messageId: "b", contactId: "contact-1", direction: "outgoing" as const, body: "second", sentAt: 10, deliveryState: "relayed" as const },
    { messageId: "a", contactId: "contact-1", direction: "incoming" as const, body: "first", sentAt: 10, deliveryState: "received" as const }
  ];

  assert.deepEqual(orderConversationMessages(messages).map((message) => message.messageId), ["a", "b", "z"]);
  assert.deepEqual(groupMessagesByContactId([...messages].reverse())["contact-1"]?.map((message) => message.messageId), ["a", "b", "z"]);

  const store = createAppStore();
  for (const message of messages) {
    store.getState().appendMessage(message);
  }
  assert.deepEqual(store.getState().messagesByContactId["contact-1"]?.map((message) => message.messageId), ["a", "b", "z"]);
});

void test("PWA bounds local message requests and promotes an accepted request into a reply-capable contact", () => {
  const store = createAppStore();
  const senderPeerId = Buffer.alloc(32, 11).toString("base64url");
  const senderHpkePublicKey = Buffer.alloc(32, 12).toString("base64url");
  store.getState().receiveMessageRequest({
    requestId: "request-1",
    senderPeerId,
    senderHpkePublicKey,
    senderDisplayName: "Alice",
    body: "hello",
    receivedAt: 1
  });
  const contactId = store.getState().acceptMessageRequest("request-1");

  assert.notEqual(contactId, null);
  assert.equal(store.getState().incomingMessageRequests.length, 0);
  assert.equal(store.getState().contacts.find((contact) => contact.contactId === contactId)?.hpkePublicKey, senderHpkePublicKey);
  assert.equal(store.getState().contacts.find((contact) => contact.contactId === contactId)?.displayName, "Alice");
  assert.equal(store.getState().messagesByContactId[contactId ?? ""]?.[0]?.body, "hello");
});

void test("PWA transport keeps relay forwarding distinct from unknown-sender presentation", async () => {
  const payload = await readFile(messagePayloadPath, "utf8");
  const incoming = await readFile(incomingMessagePath, "utf8");
  const transport = await readFile(useRelayTransportPath, "utf8");
  const requestsSlice = await readFile(messageRequestsSlicePath, "utf8");
  const requestsPage = await readFile(messageRequestsPagePath, "utf8");
  const app = await readFile(appPath, "utf8");

  assert.match(payload, /branch\.pwa\.message\/0\.draft/);
  assert.match(payload, /maxBetaPwaMessageBodyBytes = 3_000/);
  assert.match(incoming, /drop_unknown_legacy/);
  assert.match(transport, /clearDelivery\(event\.deliveryId\)/);
  assert.match(transport, /receiveMessageRequest/);
  assert.match(transport, /sendPresencePong/);
  assert.match(transport, /known_contact_presence_ping/);
  assert.match(transport, /acceptContactPresencePong/);
  assert.match(transport, /case "frame_sent"/);
  assert.match(transport, /outbound frame: \$\{event\.frameType\}/);
  assert.doesNotMatch(transport, /setMessageDeliveryState\(contactId, event\.deliveryId, "received"\)/);
  assert.match(requestsSlice, /maxIncomingMessageRequests = 50/);
  assert.match(requestsSlice, /acceptMessageRequest/);
  assert.match(requestsPage, /Accept/);
  assert.match(app, /MessageRequestsPage/);
});

void test("PWA contact presence is an in-memory encrypted ping-pong result, not a relay status or message", async () => {
  const component = await readFile(contactPresencePath, "utf8");
  const slice = await readFile(contactPresenceSlicePath, "utf8");
  const sealAndSend = await readFile(sealAndSendPath, "utf8");
  const chatListSidebar = await readFile(chatListSidebarPath, "utf8");

  assert.match(component, /sendPresencePing/);
  assert.match(component, /presenceRenewIntervalMs = 20_000/);
  assert.match(component, /presencePingTimeoutMs = 6_000/);
  assert.match(component, /expireContactPresencePing/);
  assert.match(component, /Contact online \(encrypted pong\)/);
  assert.match(component, /const status = presenceState\.status/);
  assert.doesNotMatch(component, /const status = canPing \? presenceState\.status : "unknown"/);
  assert.match(component, /Ping contact/);
  assert.match(slice, /maxContactPresenceEntries = 64/);
  assert.match(slice, /acceptContactPresencePong/);
  assert.match(slice, /expireContactPresencePing/);
  assert.doesNotMatch(slice, /storage|IndexedDB|saveStored|fetch\(|WebSocket/);
  assert.match(sealAndSend, /sendPresencePing/);
  assert.match(sealAndSend, /sendPresencePong/);
  assert.doesNotMatch(sealAndSend, /saveStored|appendMessage/);
  assert.match(chatListSidebar, /ContactOnlineBadge/);
  assert.match(chatListSidebar, /useContactPresence/);
  assert.match(chatListSidebar, /presence\.status !== "available"/);
  assert.doesNotMatch(chatListSidebar, /sendPresencePing/);
});

void test("PWA chat log follows the reader only when they are already at the latest message", async () => {
  const messageLog = await readFile(messageLogPath, "utf8");
  const formatTime = await readFile(formatTimePath, "utf8");

  assert.match(messageLog, /openedDifferentConversation/);
  assert.match(messageLog, /stickToBottom\.current/);
  assert.match(messageLog, /newest\?\.direction === "outgoing"/);
  assert.match(messageLog, /setShowLatest\(true\)/);
  assert.match(messageLog, /Jump to latest message/);
  assert.match(messageLog, /ChatDayDivider/);
  assert.match(messageLog, /formatDeliveryState/);
  assert.match(messageLog, /hour12: false/);
  assert.match(formatTime, /hour12: false/);
});

void test("PWA typing uses the shared signed control runtime and remains volatile", async () => {
  const typingControl = await readFile(typingControlPath, "utf8");
  const typingSlice = await readFile(contactTypingSlicePath, "utf8");
  const transport = await readFile(useRelayTransportPath, "utf8");
  const chatPage = await readFile(chatPagePath, "utf8");
  const presence = await readFile(contactPresencePath, "utf8");
  const chatListSidebar = await readFile(chatListSidebarPath, "utf8");
  const composer = await readFile(resolve(process.cwd(), "src/app/MessageComposer.tsx"), "utf8");

  assert.match(typingControl, /branch\.pwa\.typing\/0\.draft/);
  assert.match(typingControl, /createApplicationControlRegistry/);
  assert.match(typingControl, /processApplicationControl/);
  assert.match(typingControl, /applicationControlSigningBytes/);
  assert.match(typingControl, /typingControlTTLms = 6_000/);
  assert.match(typingControl, /typingRenewIntervalMs = 2_000/);
  assert.match(typingControl, /maxTypingRateEntries = 64/);
  assert.match(typingControl, /lastTypingSentAtByPeerId\.size >= maxTypingRateEntries/);
  assert.doesNotMatch(typingControl, /IndexedDB|saveStored|appendMessage/);
  assert.match(typingSlice, /maxTypingContacts = 64/);
  assert.doesNotMatch(typingSlice, /storage|IndexedDB|saveStored|fetch\(|WebSocket/);
  assert.match(transport, /receiveTypingControl/);
  assert.match(transport, /incoming envelope: received/);
  assert.match(transport, /incoming envelope: opened/);
  assert.match(transport, /incoming envelope: rejected/);
  assert.match(transport, /incoming envelope: message/);
  assert.match(transport, /typing control: \$\{typing\.outcome/);
  assert.match(transport, /clearAllContactTyping/);
  assert.match(transport, /state\.clearContactTyping\(disposition\.contactId\)/);
  assert.match(composer, /onTyping/);
  assert.match(chatPage, /typing control: outbound_sent/);
  assert.match(chatPage, /subtitle=\{isReachable \? <ContactPresence contact=\{contact\} \/> : "Demo contact"\}/);
  assert.doesNotMatch(chatPage, /\{isReachable && <ContactPresence/);
  assert.match(presence, /expiresAt !== null/);
  assert.match(presence, /<ContactTyping contactId=\{contact\.contactId\} variant="header" \/>/);
  assert.match(presence, /Contact online \(encrypted pong\)/);
  assert.match(chatListSidebar, /function ContactPreview/);
  assert.match(chatListSidebar, /<ContactTyping contactId=\{contactId\} variant="list" \/>/);
  assert.match(chatPage, /hasAttachedRelaySession\(\)/);
  assert.match(presence, /hasAttachedRelaySession\(\)/);
});

void test("PWA exposes the release beside Chats and during relay discovery", async () => {
  const sidebar = await readFile(chatListSidebarPath, "utf8");
  const discovery = await readFile(discoveryPagePath, "utf8");
  const styles = await readFile(resolve(process.cwd(), "public/pwa.css"), "utf8");

  assert.match(sidebar, /pwaReleaseVersion/);
  assert.match(sidebar, />v\{pwaReleaseVersion\}</);
  assert.match(discovery, /pwaReleaseVersion/);
  assert.match(discovery, /pwa-discovery-title-row/);
  assert.match(styles, /\.pwa-release-version/);
  assert.match(styles, /\.pwa-discovery-title-row/);
});

void test("PWA typing receiver accepts a signed control for its known contact", async () => {
  const [sender, recipient] = await Promise.all([
    SameRelayTransportClient.createIdentity(),
    SameRelayTransportClient.createIdentity()
  ]);
  const now = Date.now();
  const descriptor: ApplicationControlDescriptor<{ readonly active: true }> = {
    kind: typingControlKind,
    authentication: "ed25519",
    maximumTTLms: typingControlTTLms,
    projection: "ephemeral",
    allowedEffects: ["ephemeral_projection"],
    decodeBody: (body) => {
      if (body.byteLength !== 1 || body[0] !== 1) {
        throw new Error("invalid typing body");
      }
      return { active: true };
    },
    encodeBody: () => new Uint8Array([1]),
    reduce: ({ envelope }) => [{
      kind: "ephemeral_projection",
      projection: "typing",
      value: new Uint8Array([1]),
      expiresAt: envelope.expiresAt
    }]
  };
  const unsigned = prepareOutboundApplicationControl({
    kind: typingControlKind,
    controlId: Buffer.alloc(16, 71).toString("base64url"),
    issuedAt: now,
    expiresAt: now + typingControlTTLms,
    senderPeerId: sender.peerId,
    recipientPeerId: recipient.peerId,
    body: { active: true }
  }, descriptor, {
    now,
    localPeerId: sender.peerId,
    isKnownContact: () => true,
    isAllowed: () => true,
    consumeRateLimit: () => true,
    maxClockSkewMs: 1_000
  });
  const signature = new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    sender.privateKey,
    new Uint8Array(applicationControlSigningBytes(unsigned)).buffer
  ));
  const result = await receiveTypingControl({
    plaintext: typingControlPayloadPrefix + encodeBase64URL(encodeApplicationControl({ ...unsigned, signature })),
    localPeerId: recipient.peerId,
    senderPeerId: sender.peerId,
    knownContactId: "contact-alice"
  });

  assert.equal(result.outcome, "accepted");
  assert.equal(result.contactId, "contact-alice");
  assert.equal(result.expiresAt, unsigned.expiresAt);

  const recipientPayloadKeys = await createBetaPayloadKeyPair();
  const originRouteId = Buffer.alloc(16, 3).toString("base64url");
  const deliveryId = Buffer.alloc(16, 5).toString("base64url");
  const plaintext = typingControlPayloadPrefix + encodeBase64URL(encodeApplicationControl({ ...unsigned, signature }));
  const expectedCiphertextBytes = betaHpkeCiphertextBytesForPlaintext(plaintext);
  const sealedPayload = await sealBetaPayload({
    recipientPublicKey: recipientPayloadKeys.publicKey,
    plaintext,
    aad: makeBetaPayloadAAD({
      protocol: protocolID,
      profileMultihash: developmentProfileMultihash,
      originRouteId,
      senderPeerKey: sender.peerId,
      recipientPeerKey: recipient.peerId,
      deliveryId,
      pathEpoch: 0,
      streamId: 0,
      frameType: "ENVELOPE",
      ackRequested: true,
      hpkeCiphertextBytes: expectedCiphertextBytes
    }),
    expectedCiphertextBytes
  });
  assert.ok(sealedPayload.length > 1_024);
  assert.ok(sealedPayload.length <= maxDraftRelayCiphertextBytes);
  assert.equal(decodeDraftRelayAttachmentFrameText(JSON.stringify({
    type: "ENVELOPE",
    session_id: Buffer.alloc(32, 1).toString("base64url"),
    route_id: originRouteId,
    origin_route_id: originRouteId,
    path_epoch: 0,
    stream_id: 0,
    delivery_id: deliveryId,
    ciphertext: sealedPayload,
    ack_requested: true
  })).type, "ENVELOPE");
});

void test("incoming envelope opens only when the delivered origin route is bound into canonical HPKE AAD", async () => {
  const recipient = await createBetaPayloadKeyPair();
  const senderPeerId = Buffer.alloc(32, 7).toString("base64url");
  const recipientPeerId = Buffer.alloc(32, 9).toString("base64url");
  const originRouteId = Buffer.alloc(16, 3).toString("base64url");
  const deliveryId = Buffer.alloc(16, 5).toString("base64url");
  const plaintext = "canonical PWA envelope";
  const expectedCiphertextBytes = betaHpkeCiphertextBytesForPlaintext(plaintext);
  const aad = makeBetaPayloadAAD({
    protocol: protocolID,
    profileMultihash: developmentProfileMultihash,
    originRouteId,
    senderPeerKey: senderPeerId,
    recipientPeerKey: recipientPeerId,
    deliveryId,
    pathEpoch: 0,
    streamId: 0,
    frameType: "ENVELOPE",
    ackRequested: true,
    hpkeCiphertextBytes: expectedCiphertextBytes
  });
  const sealedPayload = await sealBetaPayload({
    recipientPublicKey: recipient.publicKey,
    plaintext,
    aad,
    expectedCiphertextBytes
  });

  const opened = await openIncomingEnvelope({
    senderPeerId,
    recipientPeerId,
    originRouteId,
    recipientHpkePrivateKey: recipient.privateKey,
    deliveryId,
    sealedPayload
  });
  assert.equal(opened, plaintext);
  await assert.rejects(openIncomingEnvelope({
    senderPeerId,
    recipientPeerId,
    originRouteId: Buffer.alloc(16, 4).toString("base64url"),
    recipientHpkePrivateKey: recipient.privateKey,
    deliveryId,
    sealedPayload
  }));
});

void test("real contacts carry peerId/hpkePublicKey and settings expose a JSON invite to add them", async () => {
  const settingsPage = await readFile(settingsPagePath, "utf8");
  const chatListSidebar = await readFile(chatListSidebarForContactPath, "utf8");

  assert.match(settingsPage, /JSON\.stringify\(\{/);
  assert.match(settingsPage, /peerId: identity\.identity\.peerId/);
  assert.match(settingsPage, /hpkePublicKey: identity\.identity\.hpkePublicKey/);
  assert.match(chatListSidebar, /upsertContact/);
  assert.match(chatListSidebar, /JSON\.parse\(value\)/);
});

void test("contact route lookup remains a published-announcement diagnostic", async () => {
  const contactRouteLookup = await readFile(contactRouteLookupPath, "utf8");

  assert.match(contactRouteLookup, /Check published route/);
  assert.match(contactRouteLookup, /No fresh public route announcement for this contact/);
  assert.match(contactRouteLookup, /lookupIdentityContactViaGitHub/);
});

void test("the real static build does not let esbuild's antd-reset companion clobber the hand-authored stylesheet", async () => {
  // Regression test: main.tsx's `import "antd/dist/reset.css"` makes esbuild
  // emit dist/pwa-app.css as a side effect of bundling pwa-app.js. That once
  // silently overwrote a hand-authored public/pwa-app.css with the same
  // name, breaking every custom style in production while typecheck/lint
  // stayed green. This runs the actual build and checks the real output.
  execFileSync("node", [buildScriptPath], { cwd: process.cwd(), stdio: "pipe" });
  const distPwaCss = await readFile(resolve(process.cwd(), "dist/pwa.css"), "utf8");
  const distPwaAppCss = await readFile(resolve(process.cwd(), "dist/pwa-app.css"), "utf8");

  assert.match(distPwaCss, /\.pwa-shell/);
  assert.match(distPwaCss, /--pwa-bg/);
  assert.doesNotMatch(distPwaAppCss, /\.pwa-shell/);
  assert.notEqual(distPwaAppCss, distPwaCss);
});

void test("contacts, messages, read state, and inbound requests persist through one shared IndexedDB database", async () => {
  const database = await readFile(databasePath, "utf8");
  const contactsStore = await readFile(contactsStorePath, "utf8");
  const messagesStore = await readFile(messagesStorePath, "utf8");
  const readStateStore = await readFile(readStateStorePath, "utf8");
  const messageRequestsStore = await readFile(resolve(process.cwd(), "src/storage/message-requests-store.ts"), "utf8");
  const bootstrap = await readFile(conversationsBootstrapPath, "utf8");
  const contactsSlice = await readFile(contactsSlicePath, "utf8");
  const conversationsSlice = await readFile(conversationsSlicePath, "utf8");
  const readStateSlice = await readFile(readStateSlicePath, "utf8");
  const hydrationSlice = await readFile(hydrationSlicePath, "utf8");
  const requireIdentity = await readFile(requireIdentityPath, "utf8");

  assert.match(database, /const DATABASE_VERSION = 3/);
  assert.match(database, /IDENTITY_STORE/);
  assert.match(database, /CONTACTS_STORE/);
  assert.match(database, /MESSAGES_STORE/);
  assert.match(database, /READ_STATE_STORE/);
  assert.match(database, /MESSAGE_REQUESTS_STORE/);
  assert.match(contactsStore, /openDatabase/);
  assert.match(messagesStore, /openDatabase/);
  assert.match(readStateStore, /openDatabase/);
  assert.match(messageRequestsStore, /openDatabase/);
  assert.match(bootstrap, /loadStoredContacts/);
  assert.match(bootstrap, /loadStoredMessages/);
  assert.match(bootstrap, /loadStoredReadState/);
  assert.match(bootstrap, /loadStoredMessageRequests/);
  assert.match(bootstrap, /setConversationsLoaded/);
  assert.match(contactsSlice, /saveStoredContact/);
  assert.match(contactsSlice, /deleteStoredContact/);
  assert.match(contactsSlice, /forgetContact/);
  assert.match(contactsSlice, /deleteStoredMessagesForContact/);
  assert.match(contactsSlice, /deleteStoredReadState/);
  assert.match(messagesStore, /index\("byContactId"\)\.openCursor\(IDBKeyRange\.only\(contactId\)\)/);
  assert.match(readStateStore, /deleteStoredReadState/);
  assert.match(conversationsSlice, /saveStoredMessage/);
  assert.match(readStateSlice, /saveStoredReadState/);
  assert.match(hydrationSlice, /conversationsLoaded: false/);
  assert.match(requireIdentity, /useConversationsLoaded/);
  assert.match(requireIdentity, /!conversationsLoaded/);
});

void test("removing a real contact is explicit and clears only local PWA state", async () => {
  const chatPage = await readFile(chatPagePath, "utf8");
  const contactsSlice = await readFile(contactsSlicePath, "utf8");

  assert.match(chatPage, /Popconfirm/);
  assert.match(chatPage, /DeleteOutlined/);
  assert.match(chatPage, /aria-label="Remove contact"/);
  assert.match(chatPage, /contacts\.forgetContact\(contact\.contactId\)/);
  assert.match(chatPage, /local chat history from this device/);
  assert.match(contactsSlice, /messagesByContactId/);
  assert.match(contactsSlice, /lastReadAtByContactId/);
  assert.doesNotMatch(contactsSlice, /WebSocket|fetch\(/);
});

void test("chat contacts stay purely user-managed — Echo is not a ContactSummary", async () => {
  const chatPage = await readFile(chatPagePath, "utf8");
  const useRelayTransport = await readFile(useRelayTransportPath, "utf8");

  assert.doesNotMatch(chatPage, /runEchoRoundTrip/);
  assert.match(useRelayTransport, /event\.senderPeerId/);
  assert.doesNotMatch(useRelayTransport, /boundPeerId|ECHO_CONTACT|runEchoRoundTrip/);
});

void test("Echo is pinned in the chat list (D-BRANCH-040 self-addressed loopback, not a fixed contact)", async () => {
  const echoChatPage = await readFile(echoChatPagePath, "utf8");
  const chatListSidebar = await readFile(chatListSidebarForContactPath, "utf8");
  const appPathsSource = await readFile(appPathsPath, "utf8");
  const app = await readFile(appPath, "utf8");
  const connectionSlice = await readFile(connectionSlicePath, "utf8");
  const findRelayRoute = await readFile(findRelayRoutePath, "utf8");
  const hooks = await readFile(hooksPath, "utf8");

  assert.match(appPathsSource, /ECHO_CONTACT_ID = "echo"/);
  assert.doesNotMatch(appPathsSource, /readonly peerId|readonly hpkePublicKey/);
  assert.match(chatListSidebar, /pwa-echo-pinned/);
  assert.match(chatListSidebar, /ECHO_PATH/);
  assert.match(app, /path="echo" element=\{<EchoChatPage/);
  assert.match(hooks, /export function useEchoPreview/);
  assert.match(echoChatPage, /from "@code4bones\/branch-core"/);
  assert.match(echoChatPage, /runEchoRoundTrip\(\{ routes: connection\.discoveredRoutes, body \}\)/);
  assert.doesNotMatch(echoChatPage, /contact:/);
  assert.match(echoChatPage, /report\.status === "ok"/);
  assert.match(echoChatPage, /Echo unavailable/);
  assert.doesNotMatch(echoChatPage, /cause instanceof Error|cause\.message/);
  // The failure path only ever surfaces a bounded route/attempt count, never
  // ciphertext, keys, or tokens.
  assert.doesNotMatch(echoChatPage, /report\.attempts\[[^\]]*\]\.reason|ciphertext|privateKey|hpkePrivateKey/);
  assert.match(connectionSlice, /discoveredRoutes: readonly RelayRouteMaterial\[\]/);
  assert.match(connectionSlice, /tries them locally in order until one accepts attachment/);
  assert.match(findRelayRoute, /routesFromBeaconObservations/);
  assert.doesNotMatch(findRelayRoute, /routes\[0\]/);
});

void test("BranchID lookup (T-BRANCH-107) reuses branch-core's identity-contact discovery, not a homegrown parser", async () => {
  const branchId = await readFile(branchIdPath, "utf8");
  const lookup = await readFile(lookupIdentityContactPath, "utf8");
  const contactRouteLookup = await readFile(contactRouteLookupPath, "utf8");
  const settingsPage = await readFile(settingsPagePath, "utf8");
  const chatPage = await readFile(chatPagePath, "utf8");

  assert.match(branchId, /from "@code4bones\/branch-core"/);
  assert.match(branchId, /branchIDFromPublicKey/);
  assert.match(lookup, /from "@code4bones\/branch-core"/);
  assert.match(lookup, /createGitHubIdentityContactSearchCarrier/);
  assert.match(lookup, /discoverClientIdentityContacts/);
  assert.match(lookup, /githubDiscoveryDefaultQuery/);
  // Exact-BranchID lookup only: no alias/prefix/wildcard search parameters.
  assert.doesNotMatch(lookup, /alias|prefix|wildcard/);
  assert.match(contactRouteLookup, /lookupIdentityContactViaGitHub/);
  assert.match(contactRouteLookup, /useBranchID/);
  assert.match(settingsPage, /useBranchID/);
  assert.match(chatPage, /ContactRouteLookup/);
});

void test("nginx serves /pwa/ from its own dist directory without touching other locations", async () => {
  const source = await readFile(nginxConfigPath, "utf8");

  assert.match(source, /location = \/pwa \{\n\s+return 301 \/pwa\/;/);
  assert.match(source, /location \/pwa\/ \{[\s\S]*alias \/home\/code4bones\/Devs\/coding\/BRANCH\/pwa\/dist\/;/);
  assert.match(source, /location \/pwa\/ \{[\s\S]*try_files \$uri \$uri\/ \/pwa\/index\.html;/);
  assert.match(source, /location = \/pwa\/sw\.js \{[\s\S]*Cache-Control "no-cache"/);
  assert.match(source, /location \/admin\/ \{/);
  assert.match(source, /location \/node-admin\//);
  assert.match(source, /location = \/relay\/v0 \{/);
});

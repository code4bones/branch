import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applicationCapabilitiesControlKind,
  applicationControlSigningBytes,
  applicationControlWireVersion,
  applicationPayloadVersion,
  betaHpkeCiphertextBytesForPlaintext,
  branchIDFromPublicKey,
  createBetaPayloadKeyPair,
  decodeBase64URL,
  decodeApplicationControl,
  decodeContactCard,
  decodeDraftRelayAttachmentFrameText,
  developmentProfileMultihash,
  encodeApplicationControl,
  encodeContactCard,
  encodeApplicationPayload,
  encodeBase64URL,
  makeBetaPayloadAAD,
  maxDraftRelayCiphertextBytes,
  prepareOutboundApplicationControl,
  protocolID,
  contactCardControlKind,
  sealBetaPayload,
  SameRelayTransportClient,
  type ApplicationControlDescriptor
} from "@code4bones/branch-core";

import { openIncomingEnvelope } from "../src/connectivity/open-envelope.js";
import { createDeliveryID } from "../src/connectivity/seal-and-send.js";
import { encodeChatTextApplicationPayload } from "../src/connectivity/application-payload.js";
import {
  applicationCapabilitiesControlDescriptor,
  applicationCapabilitiesControlTTLms,
  localApplicationCapabilities,
  peerSupportsChatText,
  receiveApplicationCapabilities
} from "../src/connectivity/application-capabilities-control.js";
import { classifyIncomingMessage } from "../src/connectivity/incoming-message.js";
import { receiveTypingControl, typingControlKind, typingControlPayloadPrefix, typingControlTTLms } from "../src/connectivity/typing-control.js";
import { receiveContactCard } from "../src/connectivity/contact-card-control.js";
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
import { autoPresentedIncomingMessage } from "../src/app/MessageLog.js";
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
const receiptPolicyStorePath = resolve(process.cwd(), "src/storage/receipt-policy-store.ts");
const receiptPolicySlicePath = resolve(process.cwd(), "src/state/slices/receipt-policy-slice.ts");
const conversationsBootstrapPath = resolve(process.cwd(), "src/storage/use-conversations-bootstrap.ts");
const contactsSlicePath = resolve(process.cwd(), "src/state/slices/contacts-slice.ts");
const conversationsSlicePath = resolve(process.cwd(), "src/state/slices/conversations-slice.ts");
const readStateSlicePath = resolve(process.cwd(), "src/state/slices/read-state-slice.ts");
const hydrationSlicePath = resolve(process.cwd(), "src/state/slices/hydration-slice.ts");
const legacyDemoCleanupPath = resolve(process.cwd(), "src/storage/legacy-demo-cleanup.ts");
const branchIdPath = resolve(process.cwd(), "src/identity/branch-id.ts");
const lookupIdentityContactPath = resolve(process.cwd(), "src/discovery/lookup-identity-contact.ts");
const contactRouteLookupPath = resolve(process.cwd(), "src/app/ContactRouteLookup.tsx");
const messagePayloadPath = resolve(process.cwd(), "src/connectivity/message-payload.ts");
const incomingMessagePath = resolve(process.cwd(), "src/connectivity/incoming-message.ts");
const messageRequestsSlicePath = resolve(process.cwd(), "src/state/slices/message-requests-slice.ts");
const messageRequestsPagePath = resolve(process.cwd(), "src/pages/MessageRequestsPage.tsx");
const contactPresencePath = resolve(process.cwd(), "src/app/ContactPresence.tsx");
const contactPresenceSlicePath = resolve(process.cwd(), "src/state/slices/contact-presence-slice.ts");
const contactPresenceRuntimePath = resolve(process.cwd(), "src/connectivity/contact-presence-runtime.ts");
const messageLogPath = resolve(process.cwd(), "src/app/MessageLog.tsx");
const messageComposerPath = resolve(process.cwd(), "src/app/MessageComposer.tsx");
const typingControlPath = resolve(process.cwd(), "src/connectivity/typing-control.ts");
const deliveryReceiptControlPath = resolve(process.cwd(), "src/connectivity/delivery-receipt-control.ts");
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
  assert.match(relaySession, /setLiveForwardedAckListener/);
  assert.match(relaySession, /notifyLiveForwardedAck/);
  assert.match(relaySession, /liveForwardedAckListener = null/);
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
  assert.match(sealAndSend, /const routeId = liveRouteID\(client, options\.recipientPeerId\)/);
  assert.match(sealAndSend, /client\.rendezvous\(options\.recipientPeerId, \{ routeId \}\)/);
  assert.match(sealAndSend, /const liveRouteIDs = new WeakMap/);
  assert.match(sealAndSend, /maxLiveRoutesPerAttachment = 64/);
  assert.match(sealAndSend, /live contact route limit reached/);
  assert.match(sealAndSend, /function liveRouteID/);
  assert.doesNotMatch(sealAndSend, /crypto\.randomUUID/);
  assert.match(sealAndSend, /sendSealedEnvelope\(sealed, \{ deliveryId: options\.deliveryId, routeId, originRouteId, ackRequested: fixedAckRequested \}\)/);
  assert.match(sealAndSend, /from "\.\/payload-aad-defaults\.js"/);
  assert.match(openEnvelope, /openBetaPayload/);
  assert.match(openEnvelope, /betaHpkeCiphertextBytesFromSealedPayload/);
  assert.match(openEnvelope, /originRouteId: options\.originRouteId/);
  assert.match(openEnvelope, /senderPeerKey: options\.senderPeerId/);
  assert.match(openEnvelope, /recipientPeerKey: options\.recipientPeerId/);
  assert.match(openEnvelope, /expectedCiphertextBytes/);
  assert.match(openEnvelope, /from "\.\/payload-aad-defaults\.js"/);
  assert.match(useRelayTransport, /case "relay_ack"/);
  assert.match(useRelayTransport, /event\.ackType === "relay\.forwarded"/);
  assert.match(useRelayTransport, /notifyLiveForwardedAck\(event\.deliveryId\)/);
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
  assert.notEqual(checking.lastProbeAt, null);
  store.getState().acceptContactPresencePong("contact-1", Buffer.alloc(16, 22).toString("base64url"));
  assert.equal(store.getState().contactPresenceById["contact-1"]?.status, "checking");
  store.getState().acceptContactPresencePong("contact-1", pingId);
  const available = store.getState().contactPresenceById["contact-1"];
  if (available === undefined) {
    throw new Error("matching pong did not create contact presence");
  }
  assert.equal(available.status, "available");
  assert.equal(available.evidence, "encrypted_pong");
  store.getState().confirmContactPresenceFromLiveTraffic("contact-1");
  assert.equal(store.getState().contactPresenceById["contact-1"]?.evidence, "encrypted_live_traffic");
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

void test("outgoing delivery state advances monotonically while a valid receipt may supersede local unavailability", () => {
  const store = createAppStore();
  const outgoing = {
    messageId: "outgoing-1",
    contactId: "contact-1",
    direction: "outgoing" as const,
    body: "hello",
    sentAt: 1,
    deliveryState: "pending" as const
  };
  const incoming = {
    messageId: "incoming-1",
    contactId: "contact-1",
    direction: "incoming" as const,
    body: "hello back",
    sentAt: 2,
    deliveryState: "received" as const
  };
  store.getState().appendMessage(outgoing);
  store.getState().appendMessage(incoming);

  store.getState().setMessageDeliveryState("contact-1", "outgoing-1", "read");
  assert.equal(store.getState().messagesByContactId["contact-1"]?.find((message) => message.messageId === "outgoing-1")?.deliveryState, "pending");
  store.getState().setMessageDeliveryState("contact-1", "outgoing-1", "relayed");
  store.getState().setMessageDeliveryState("contact-1", "outgoing-1", "delivered");
  store.getState().setMessageDeliveryState("contact-1", "outgoing-1", "read");
  store.getState().setMessageDeliveryState("contact-1", "outgoing-1", "relayed");
  assert.equal(store.getState().messagesByContactId["contact-1"]?.find((message) => message.messageId === "outgoing-1")?.deliveryState, "read");

  store.getState().setMessageDeliveryState("contact-1", "incoming-1", "delivered");
  assert.equal(store.getState().messagesByContactId["contact-1"]?.find((message) => message.messageId === "incoming-1")?.deliveryState, "received");

  const unavailable = { ...outgoing, messageId: "outgoing-2" };
  store.getState().appendMessage(unavailable);
  store.getState().setMessageDeliveryState("contact-1", "outgoing-2", "unavailable");
  store.getState().setMessageDeliveryState("contact-1", "outgoing-2", "delivered");
  assert.equal(store.getState().messagesByContactId["contact-1"]?.find((message) => message.messageId === "outgoing-2")?.deliveryState, "delivered");

  const retryable = { ...outgoing, messageId: "outgoing-3" };
  const replacement = { ...retryable, messageId: "outgoing-3-retry", deliveryState: "pending" as const };
  store.getState().appendMessage(retryable);
  store.getState().setMessageDeliveryState("contact-1", "outgoing-3", "unavailable");
  assert.equal(store.getState().retryUnavailableMessage("contact-1", "outgoing-3", replacement), true);
  assert.equal(store.getState().messagesByContactId["contact-1"]?.find((message) => message.messageId === "outgoing-3"), undefined);
  assert.deepEqual(store.getState().messagesByContactId["contact-1"]?.find((message) => message.messageId === "outgoing-3-retry"), replacement);
  assert.equal(store.getState().retryUnavailableMessage("contact-1", "outgoing-3", replacement), false);
});

void test("a completed file service bubble includes only local terminal metadata", async () => {
  const store = createAppStore();
  store.getState().appendMessage({
    messageId: "attachment-accepted",
    contactId: "contact-1",
    direction: "service",
    body: "File received: report.pdf (1.5 KiB)",
    sentAt: 1,
    deliveryState: "received"
  });
  const attachmentRuntime = await readFile(resolve(process.cwd(), "src/connectivity/attachment-runtime.ts"), "utf8");

  assert.equal(store.getState().messagesByContactId["contact-1"]?.[0]?.direction, "service");
  assert.match(attachmentRuntime, /direction: "service"/);
  assert.match(attachmentRuntime, /File sent/);
  assert.match(attachmentRuntime, /File received/);
  assert.match(attachmentRuntime, /formatAttachmentByteCount/);
});

void test("file picker retains its DOM input across asynchronous offer completion", async () => {
  const control = await readFile(resolve(process.cwd(), "src/app/AttachmentSendControl.tsx"), "utf8");
  assert.match(control, /const input = event\.currentTarget/);
  assert.match(control, /input\.value = ""/);
  assert.doesNotMatch(control, /finally\(\(\) => \{[\s\S]{0,260}event\.currentTarget/u);
});

void test("a successful relay attachment eagerly installs the volatile file bridge", async () => {
  const transport = await readFile(resolve(process.cwd(), "src/connectivity/use-relay-transport.ts"), "utf8");
  assert.match(transport, /startContactDiscoveryRuntime\(storeApi, attachedClient\);[\s\S]{0,320}attachmentTransferController\(storeApi\)/);
});

void test("only a new incoming message auto-presented at the bottom is reported to read-receipt UI", () => {
  const incoming = {
    messageId: "incoming-1",
    contactId: "contact-1",
    direction: "incoming" as const,
    body: "hello",
    sentAt: 1,
    deliveryState: "received" as const
  };
  assert.equal(autoPresentedIncomingMessage({
    newest: incoming,
    previousNewestId: null,
    openedDifferentConversation: false,
    wasAtBottom: true
  })?.messageId, incoming.messageId);
  assert.equal(autoPresentedIncomingMessage({
    newest: incoming,
    previousNewestId: incoming.messageId,
    openedDifferentConversation: false,
    wasAtBottom: true
  }), null);
  assert.equal(autoPresentedIncomingMessage({
    newest: incoming,
    previousNewestId: incoming.messageId,
    openedDifferentConversation: true,
    wasAtBottom: false
  })?.messageId, incoming.messageId);
  assert.equal(autoPresentedIncomingMessage({
    newest: incoming,
    previousNewestId: null,
    openedDifferentConversation: false,
    wasAtBottom: false
  }), null);
  assert.equal(autoPresentedIncomingMessage({
    newest: { ...incoming, direction: "outgoing" },
    previousNewestId: null,
    openedDifferentConversation: true,
    wasAtBottom: true
  }), null);
});

void test("read-receipt policy defaults off and has a dedicated user-owned persistence boundary", async () => {
  const store = createAppStore();
  assert.equal(store.getState().sendReadReceipts, false);
  store.getState().setSendReadReceipts(true);
  assert.equal(store.getState().sendReadReceipts, true);

  const database = await readFile(databasePath, "utf8");
  const policyStore = await readFile(receiptPolicyStorePath, "utf8");
  const policySlice = await readFile(receiptPolicySlicePath, "utf8");
  const settings = await readFile(settingsPagePath, "utf8");
  const hooks = await readFile(hooksPath, "utf8");

  assert.match(database, /const DATABASE_VERSION = 5/);
  assert.match(database, /RECEIPT_POLICY_STORE/);
  assert.match(policyStore, /loadStoredReadReceiptPolicy/);
  assert.match(policyStore, /saveStoredReadReceiptPolicy/);
  assert.match(policySlice, /sendReadReceipts: false/);
  assert.match(policySlice, /saveStoredReadReceiptPolicy/);
  assert.match(settings, /Send read receipts/);
  assert.match(settings, /best-effort encrypted Read receipt only after a message is shown/);
  assert.match(hooks, /export function useReceiptPolicy/);
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
  assert.match(transport, /confirmContactPresenceFromLiveTraffic\(knownContactId\)/);
  assert.match(transport, /case "frame_sent"/);
  assert.match(transport, /outbound frame: \$\{event\.frameType\}/);
  assert.doesNotMatch(transport, /setMessageDeliveryState\(contactId, event\.deliveryId, "received"\)/);
  assert.match(requestsSlice, /maxIncomingMessageRequests = 50/);
  assert.match(requestsSlice, /acceptMessageRequest/);
  assert.match(requestsPage, /Accept/);
  assert.match(app, /MessageRequestsPage/);
});

void test("PWA delivery receipts stay signed application controls and relay ACK remains only Relayed", async () => {
  const receiptControl = await readFile(deliveryReceiptControlPath, "utf8");
  const relayTransport = await readFile(useRelayTransportPath, "utf8");
  const conversations = await readFile(conversationsSlicePath, "utf8");

  assert.match(receiptControl, /deliveryReceiptControlKind = "branch\.pwa\.receipt\/0\.draft"/);
  assert.match(receiptControl, /maximumTTLms: deliveryReceiptControlTTLms/);
  assert.match(receiptControl, /authentication: "ed25519"/);
  assert.match(receiptControl, /rejectUnknownEntries\(map, \["receipt_kind", "target_delivery_id"\]\)/);
  assert.match(receiptControl, /envelope\.senderPeerId !== options\.senderPeerId/);
  assert.match(receiptControl, /sendApplicationControl/);
  assert.match(relayTransport, /receiveDeliveryReceipt/);
  assert.match(relayTransport, /sendDeliveryReceipt/);
  assert.match(relayTransport, /case "peer_receipt"[\s\S]{0,220}return;/);
  assert.match(conversations, /next === "delivered"/);
  assert.match(conversations, /next === "read"/);
});

void test("PWA contact presence is a bounded background encrypted ping-pong runtime, not a relay status or message", async () => {
  const component = await readFile(contactPresencePath, "utf8");
  const runtime = await readFile(contactPresenceRuntimePath, "utf8");
  const slice = await readFile(contactPresenceSlicePath, "utf8");
  const sealAndSend = await readFile(sealAndSendPath, "utf8");
  const transport = await readFile(useRelayTransportPath, "utf8");
  const chatListSidebar = await readFile(chatListSidebarPath, "utf8");

  assert.match(component, /probeContactPresence/);
  assert.doesNotMatch(component, /setInterval|setTimeout|sendPresencePing/);
  assert.match(runtime, /presenceRenewIntervalMs = 20_000/);
  assert.match(runtime, /presencePingTimeoutMs = 8_000/);
  assert.match(runtime, /presenceAvailableTtlMs = 60_000/);
  assert.match(runtime, /startContactPresenceRuntime/);
  assert.match(runtime, /stopContactPresenceRuntime/);
  assert.match(runtime, /setTimeout/);
  assert.doesNotMatch(runtime, /setInterval|IndexedDB|saveStored|fetch\(/);
  assert.match(runtime, /await probeContactPresence/);
  assert.match(runtime, /maxContactsExaminedPerCycle = 64/);
  assert.doesNotMatch(runtime, /Promise\.all\(contacts\.map|maxBackgroundProbesPerCycle/);
  assert.match(transport, /startContactPresenceRuntime\(storeApi, attachedClient\)/);
  assert.match(transport, /stopContactPresenceRuntime\(\)/);
  assert.match(component, /Contact online \(encrypted pong\)/);
  assert.match(component, /const status = presenceState\.status/);
  assert.doesNotMatch(component, /const status = canPing \? presenceState\.status : "unknown"/);
  assert.match(component, /Ping contact/);
  assert.match(slice, /maxContactPresenceEntries = 64/);
  assert.match(slice, /acceptContactPresencePong/);
  assert.match(slice, /confirmContactPresenceFromLiveTraffic/);
  assert.match(slice, /encrypted_live_traffic/);
  assert.match(slice, /expireContactPresencePing/);
  assert.match(slice, /lastProbeAt/);
  assert.doesNotMatch(slice, /storage|IndexedDB|saveStored|fetch\(|WebSocket/);
  assert.match(sealAndSend, /sendPresencePing/);
  assert.match(sealAndSend, /sendPresencePong/);
  assert.doesNotMatch(sealAndSend, /saveStored|appendMessage/);
  assert.match(transport, /unlike a relay ACK/);
  assert.match(chatListSidebar, /ContactOnlineBadge/);
  assert.match(chatListSidebar, /useContactPresence/);
  assert.match(chatListSidebar, /presence\.status !== "available"/);
  assert.doesNotMatch(chatListSidebar, /sendPresencePing/);
});

void test("PWA chat log follows the reader only when they are already at the latest message", async () => {
  const messageLog = await readFile(messageLogPath, "utf8");
  const messageComposer = await readFile(messageComposerPath, "utf8");
  const formatTime = await readFile(formatTimePath, "utf8");

  assert.match(messageLog, /openedDifferentConversation/);
  assert.match(messageLog, /stickToBottom\.current/);
  assert.match(messageLog, /newest\?\.direction === "outgoing"/);
  assert.match(messageLog, /setShowScrollToBottom\(!atBottom\)/);
  assert.match(messageLog, /Scroll to bottom/);
  assert.match(messageLog, /ChatDayDivider/);
  assert.match(messageLog, /DeliveryStateIcon/);
  assert.match(messageLog, /LoadingOutlined spin/);
  assert.match(messageLog, /CheckOutlined/);
  assert.match(messageLog, /DoubleCheckIcon/);
  assert.match(messageLog, /ExclamationCircleOutlined/);
  assert.match(messageLog, /RedoOutlined/);
  assert.match(messageLog, /Retry sending message/);
  assert.match(messageLog, /onRetryUnavailableMessage/);
  assert.match(messageLog, /aria-label=\{presentation\.label\}/);
  assert.match(messageLog, /hour12: false/);
  assert.match(formatTime, /hour12: false/);
  assert.match(messageComposer, /SendOutlined/);
  assert.match(messageComposer, /aria-label="Send message"/);
  assert.match(messageComposer, /Input\.TextArea/);
  assert.match(messageComposer, /maxRows: 5/);
  assert.match(messageComposer, /event\.shiftKey/);
  assert.match(messageComposer, /event\.preventDefault\(\)/);
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
  assert.match(chatPage, /subtitle=\{isReachable \? <ContactPresence contact=\{contact\} \/> : "Contact unavailable"\}/);
  assert.doesNotMatch(chatPage, /\{isReachable && <ContactPresence/);
  assert.match(presence, /expiresAt !== null/);
  assert.match(presence, /<ContactTyping contactId=\{contact\.contactId\} variant="header" \/>/);
  assert.match(presence, /Contact online \(encrypted pong\)/);
  assert.match(chatListSidebar, /function ContactPreview/);
  assert.match(chatListSidebar, /<ContactTyping contactId=\{contactId\} variant="list" \/>/);
  assert.match(chatPage, /hasAttachedRelaySession\(\)/);
  assert.match(presence, /hasAttachedRelaySession\(\)/);
});

void test("PWA exposes the local identity and release in the contact-list header", async () => {
  const sidebar = await readFile(chatListSidebarPath, "utf8");
  const discovery = await readFile(discoveryPagePath, "utf8");
  const styles = await readFile(resolve(process.cwd(), "public/pwa.css"), "utf8");

  assert.match(sidebar, /useIdentity/);
  assert.match(sidebar, /identity\.identity\?\.displayName \?\? "B\.R\.A\.N\.C\.H\."/);
  assert.match(sidebar, /className="pwa-local-identity-name" ellipsis>\{localDisplayName\}</);
  assert.match(sidebar, /useBranchID/);
  assert.match(sidebar, /aria-label="Copy BranchID"/);
  assert.match(sidebar, /navigator\.clipboard\.writeText\(branchID\)/);
  assert.match(sidebar, /pwaReleaseVersion/);
  assert.match(sidebar, /pwa-sidebar-release-version/);
  assert.match(sidebar, />v\{pwaReleaseVersion\}</);
  assert.match(discovery, /pwaReleaseVersion/);
  assert.match(discovery, /pwa-discovery-title-row/);
  assert.match(styles, /\.pwa-local-identity-name/);
  assert.match(styles, /\.pwa-copy-branch-id/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
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

void test("a contact card is accepted only when its signed relay sender binds its BranchID", async () => {
  const [senderPair, recipientPair] = await Promise.all([
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  ]);
  assert.ok("publicKey" in senderPair && "privateKey" in senderPair);
  assert.ok("publicKey" in recipientPair && "privateKey" in recipientPair);
  const senderPeerId = encodeBase64URL(new Uint8Array(await crypto.subtle.exportKey("raw", senderPair.publicKey)));
  const recipientPeerId = encodeBase64URL(new Uint8Array(await crypto.subtle.exportKey("raw", recipientPair.publicKey)));
  const now = Date.now();
  const body = encodeContactCard({
    requestId: Buffer.alloc(16, 80).toString("base64url"),
    branchId: await branchIDFromPublicKey(decodeBase64URL(senderPeerId)),
    peerId: senderPeerId,
    hpkePublicKey: Buffer.alloc(32, 81).toString("base64url"),
    displayName: "Alice"
  });
  assert.equal(decodeContactCard(body).displayName, "Alice");
  const unsigned = {
    version: applicationControlWireVersion,
    kind: contactCardControlKind,
    controlId: Buffer.alloc(16, 79).toString("base64url"),
    issuedAt: now,
    expiresAt: now + 60_000,
    senderPeerId,
    recipientPeerId,
    body
  };
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", senderPair.privateKey, new Uint8Array(applicationControlSigningBytes(unsigned)).buffer));
  const senderPublicKey = await crypto.subtle.importKey("raw", new Uint8Array(decodeBase64URL(senderPeerId)).buffer, "Ed25519", false, ["verify"]);
  assert.equal(await crypto.subtle.verify("Ed25519", senderPublicKey, new Uint8Array(signature).buffer, new Uint8Array(applicationControlSigningBytes(unsigned)).buffer), true);
  const wire = encodeApplicationControl({ ...unsigned, signature });
  const decoded = decodeApplicationControl(wire);
  assert.equal(decoded.kind, contactCardControlKind);
  assert.equal(await crypto.subtle.verify("Ed25519", senderPublicKey, new Uint8Array(decoded.signature).buffer, new Uint8Array(applicationControlSigningBytes(decoded)).buffer), true);
  const card = await receiveContactCard({
    plaintext: wire,
    localPeerId: recipientPeerId,
    senderPeerId
  });
  assert.equal(card?.displayName, "Alice");
  assert.equal(card.peerId, senderPeerId);

  const altered = await receiveContactCard({
    plaintext: encodeApplicationControl({ ...unsigned, senderPeerId: recipientPeerId, signature }),
    localPeerId: recipientPeerId,
    senderPeerId
  });
  assert.equal(altered, null);
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
  assert.equal(new TextDecoder().decode(opened), plaintext);
  await assert.rejects(openIncomingEnvelope({
    senderPeerId,
    recipientPeerId,
    originRouteId: Buffer.alloc(16, 4).toString("base64url"),
    recipientHpkePrivateKey: recipient.privateKey,
    deliveryId,
    sealedPayload
  }));
});

void test("PWA dispatches registered generic text bytes before explicit beta JSON compatibility", () => {
  const senderPeerId = Buffer.alloc(32, 7).toString("base64url");
  const generic = encodeChatTextApplicationPayload({
    messageId: Buffer.alloc(16, 2).toString("base64url"),
    body: "canonical generic text"
  });
  const genericResult = classifyIncomingMessage({ plaintext: generic, senderPeerId, knownContactId: "contact-alice" });
  assert.deepEqual(genericResult, { kind: "known_contact_message", contactId: "contact-alice", body: "canonical generic text" });

  const unknown = encodeApplicationPayload({
    version: applicationPayloadVersion,
    kind: "example.unknown/0.draft",
    messageId: Buffer.alloc(16, 3).toString("base64url"),
    body: new Uint8Array([1])
  });
  assert.deepEqual(classifyIncomingMessage({ plaintext: unknown, senderPeerId, knownContactId: "contact-alice" }), { kind: "drop_unknown_application" });
  assert.deepEqual(classifyIncomingMessage({ plaintext: new Uint8Array([0xa4]), senderPeerId, knownContactId: "contact-alice" }), { kind: "drop_unknown_legacy" });

  const legacy = encodeBetaPwaMessagePayload({
    body: "legacy text",
    replyHpkePublicKey: Buffer.alloc(32, 4).toString("base64url"),
    senderDisplayName: "Alice"
  });
  assert.equal(classifyIncomingMessage({ plaintext: legacy, senderPeerId, knownContactId: "contact-alice" }).kind, "known_contact_message");
});

void test("PWA advertises only its bounded receiver-accept relay attachment capability", () => {
  const capabilities = localApplicationCapabilities();
  assert.deepEqual(capabilities.kinds, [
    "branch.attachment.chunk/0.draft",
    "branch.attachment.decision/0.draft",
    "branch.attachment.manifest/0.draft",
    "branch.chat.text/0.draft"
  ]);
  assert.equal(capabilities.attachmentMode, "receiver-accept");
  assert.equal(capabilities.maxRelayAttachmentBytes, 4 * 1024 * 1024);
  assert.equal(capabilities.maxDirectAttachmentBytes, 0);
});

void test("opening a live known-contact chat refreshes volatile attachment capabilities", async () => {
  const chatPage = await readFile(chatPagePath, "utf8");
  const transport = await readFile(resolve(process.cwd(), "src/connectivity/use-relay-transport.ts"), "utf8");
  assert.match(chatPage, /Opening a\n\s+\/\/ live known-contact chat re-advertises/);
  assert.match(chatPage, /application capabilities: chat_\$\{result\}/);
  assert.match(transport, /application capabilities: reply_\$\{result\}/);
});

void test("PWA accepts a signed raw application-capabilities control only for a known contact", async () => {
  const [sender, recipient] = await Promise.all([
    SameRelayTransportClient.createIdentity(),
    SameRelayTransportClient.createIdentity()
  ]);
  const now = Date.now();
  const unsigned = prepareOutboundApplicationControl({
    kind: applicationCapabilitiesControlKind,
    controlId: Buffer.alloc(16, 8).toString("base64url"),
    issuedAt: now,
    expiresAt: now + applicationCapabilitiesControlTTLms,
    senderPeerId: sender.peerId,
    recipientPeerId: recipient.peerId,
    body: localApplicationCapabilities()
  }, applicationCapabilitiesControlDescriptor, {
    now,
    localPeerId: sender.peerId,
    isKnownContact: () => true,
    isAllowed: () => true,
    consumeRateLimit: () => true,
    maxClockSkewMs: 1_000
  });
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", sender.privateKey, new Uint8Array(applicationControlSigningBytes(unsigned)).buffer));
  const tamperedSignature = new Uint8Array(signature);
  tamperedSignature[0] = (tamperedSignature[0] ?? 0) ^ 1;
  const tampered = await receiveApplicationCapabilities({
    plaintext: encodeApplicationControl({ ...unsigned, signature: tamperedSignature }),
    localPeerId: recipient.peerId,
    senderPeerId: sender.peerId,
    knownContactId: "contact-alice"
  });
  assert.equal(tampered.outcome, "signature_invalid");
  const result = await receiveApplicationCapabilities({
    plaintext: encodeApplicationControl({ ...unsigned, signature }),
    localPeerId: recipient.peerId,
    senderPeerId: sender.peerId,
    knownContactId: "contact-alice"
  });
  assert.equal(result.outcome, "accepted");
  assert.equal(peerSupportsChatText(sender.peerId), true);

  const unknownContact = await receiveApplicationCapabilities({
    plaintext: encodeApplicationControl({ ...unsigned, signature }),
    localPeerId: recipient.peerId,
    senderPeerId: sender.peerId,
    knownContactId: null
  });
  assert.equal(unknownContact.outcome, "unknown_contact");
});

void test("real contacts carry peerId/hpkePublicKey and BranchID discovery replaces JSON invites", async () => {
  const settingsPage = await readFile(settingsPagePath, "utf8");
  const chatListSidebar = await readFile(chatListSidebarForContactPath, "utf8");

  assert.match(settingsPage, /BranchID/);
  assert.match(chatListSidebar, /upsertContact/);
  assert.match(chatListSidebar, /parseBranchID\(value\)/);
  assert.match(chatListSidebar, /Not found yet/);
  assert.match(chatListSidebar, /Retry/);
  assert.match(chatListSidebar, /Add/);
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
  const legacyDemoCleanup = await readFile(legacyDemoCleanupPath, "utf8");
  const readStateSlice = await readFile(readStateSlicePath, "utf8");
  const hydrationSlice = await readFile(hydrationSlicePath, "utf8");
  const requireIdentity = await readFile(requireIdentityPath, "utf8");

  assert.match(database, /const DATABASE_VERSION = 5/);
  assert.match(database, /IDENTITY_STORE/);
  assert.match(database, /CONTACTS_STORE/);
  assert.match(database, /MESSAGES_STORE/);
  assert.match(database, /READ_STATE_STORE/);
  assert.match(database, /MESSAGE_REQUESTS_STORE/);
  assert.match(database, /RECEIPT_POLICY_STORE/);
  assert.match(database, /CONTACT_DISCOVERY_STORE/);
  assert.match(contactsStore, /openDatabase/);
  assert.match(messagesStore, /openDatabase/);
  assert.match(readStateStore, /openDatabase/);
  assert.match(messageRequestsStore, /openDatabase/);
  assert.match(bootstrap, /loadStoredContacts/);
  assert.match(bootstrap, /loadStoredMessages/);
  assert.match(bootstrap, /loadStoredReadState/);
  assert.match(bootstrap, /await removeLegacyDemoState\(\)/);
  assert.match(bootstrap, /loadStoredMessageRequests/);
  assert.match(bootstrap, /setConversationsLoaded/);
  assert.match(contactsSlice, /saveStoredContact/);
  assert.match(contactsSlice, /deleteStoredContact/);
  assert.match(contactsSlice, /forgetContact/);
  assert.match(contactsSlice, /deleteStoredMessagesForContact/);
  assert.match(contactsSlice, /deleteStoredReadState/);
  assert.match(messagesStore, /index\("byContactId"\)\.openCursor\(IDBKeyRange\.only\(contactId\)\)/);
  assert.match(readStateStore, /deleteStoredReadState/);
  assert.match(await readFile(receiptPolicyStorePath, "utf8"), /openDatabase/);
  assert.match(conversationsSlice, /saveStoredMessage/);
  assert.match(readStateSlice, /saveStoredReadState/);
  assert.match(hydrationSlice, /conversationsLoaded: false/);
  assert.match(requireIdentity, /useConversationsLoaded/);
  assert.match(requireIdentity, /!conversationsLoaded/);
  assert.match(legacyDemoCleanup, /db\.transaction\(\[CONTACTS_STORE, MESSAGES_STORE, READ_STATE_STORE\], "readwrite"\)/);
  assert.match(legacyDemoCleanup, /"demo-ribbon-bearer"/);
  assert.match(legacyDemoCleanup, /"echo"/);
});

void test("removing a real contact is explicit and clears only local PWA state", async () => {
  const chatPage = await readFile(chatPagePath, "utf8");
  const contactsSlice = await readFile(contactsSlicePath, "utf8");

  assert.match(chatPage, /Dropdown/);
  assert.match(chatPage, /SettingOutlined/);
  assert.match(chatPage, /DeleteOutlined/);
  assert.match(chatPage, /key: "remove"/);
  assert.match(chatPage, /setRemoveOpen\(true\)/);
  assert.match(chatPage, /contacts\.forgetContact\(contact\.contactId\)/);
  assert.match(chatPage, /local chat history from this device/);
  assert.doesNotMatch(chatPage, /Popconfirm/);
  assert.match(contactsSlice, /messagesByContactId/);
  assert.match(contactsSlice, /lastReadAtByContactId/);
  assert.doesNotMatch(contactsSlice, /WebSocket|fetch\(/);
});

void test("PWA starts with user-managed contacts only and offers one add action when empty", async () => {
  const contactsSlice = await readFile(contactsSlicePath, "utf8");
  const conversationsSlice = await readFile(conversationsSlicePath, "utf8");
  const bootstrap = await readFile(conversationsBootstrapPath, "utf8");
  const chatListSidebar = await readFile(chatListSidebarForContactPath, "utf8");
  const app = await readFile(appPath, "utf8");
  const hooks = await readFile(hooksPath, "utf8");
  const styles = await readFile(resolve(process.cwd(), "public/pwa.css"), "utf8");

  assert.match(contactsSlice, /contacts: \[\]/);
  assert.match(conversationsSlice, /messagesByContactId: \{\}/);
  assert.doesNotMatch(contactsSlice, /demo-seed/);
  assert.doesNotMatch(conversationsSlice, /demo-seed/);
  assert.doesNotMatch(bootstrap, /saveStoredContact|saveStoredMessage|demoContacts|demoMessages/);
  assert.match(chatListSidebar, /chatList\.length === 0/);
  assert.match(chatListSidebar, /pwa-empty-contact-list/);
  assert.match(chatListSidebar, /setAddContactOpen\(true\)/);
  assert.match(chatListSidebar, /Add contact/);
  assert.match(styles, /\.pwa-empty-contact-list/);
  assert.doesNotMatch(chatListSidebar, /ECHO_|pwa-echo-pinned|Echo/);
  assert.doesNotMatch(hooks, /useEchoPreview|ECHO_CONTACT_ID/);
  assert.doesNotMatch(app, /EchoChatPage|path="echo"/);
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
  assert.doesNotMatch(chatPage, /ContactRouteLookup/);
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

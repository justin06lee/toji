// Per-container network policy, enforced in the main process.
//
// The renderer declares a container's egress by encoding it in the partition name
// (see apps/renderer/src/lib/containers.ts). This module is the other half of that
// contract: it reads the policy back out of the partition name and applies it to the
// Chromium session the instant Chromium creates it.
//
// Deriving policy from the name — rather than from a table the renderer pushes over
// IPC — removes the race where a session could exist, and issue requests, before its
// policy arrived. A renderer bug cannot put a Tor container on a direct connection,
// because there is no code path that resolves a `-tor` partition to anything else.

/**
 * Must stay in sync with `parsePartition` in apps/renderer/src/lib/containers.ts.
 * Both sides are covered by tests (containers.test.ts / policy.test.cjs).
 */
const PARTITION_RE = /^(?:persist:)?toji-c-(.+)-(direct|tor)(?:-[et]\d+)?$/;

function parsePartition(partition) {
  const match = PARTITION_RE.exec(String(partition || ''));
  return match ? { id: match[1], egress: match[2] } : null;
}

/** Schemes the kill switch refuses to let out while Tor is unavailable. */
const NETWORK_SCHEME_RE = /^(https?|wss?):/i;

/**
 * Apply a container's egress policy to its session.
 *
 * `tor` is the controller from tor.cjs: `{ isReady(), socksPortFor(containerId) }`.
 * Returns a short label describing what was applied (used in logs).
 */
function applySessionPolicy(sess, partition, tor) {
  const policy = parsePartition(partition);
  if (!policy) return null; // Not a Toji container (default session, devtools, …).

  if (policy.egress !== 'tor') {
    // Direct browsing: no proxy. WebRTC still may not volunteer local interface
    // addresses — that leaks your LAN IP to any page that opens a peer connection,
    // and no ordinary site needs it.
    sess.setProxy({ mode: 'direct' }).catch(() => {});
    return `direct:${policy.id}`;
  }

  const port = tor && tor.socksPortFor ? tor.socksPortFor(policy.id) : null;
  if (port) {
    sess.setProxy({
      proxyRules: `socks5://127.0.0.1:${port}`,
      // socks5:// in Chromium resolves DNS at the proxy, so hostnames (and .onion
      // addresses) never hit the system resolver.
      //
      // '<-loopback>' *removes* Chromium's implicit "never proxy localhost" rule, so a
      // page in a Tor container cannot reach services on this machine either.
      proxyBypassRules: '<-loopback>'
    }).catch(() => {});
  }

  installKillSwitch(sess, tor);
  return `tor:${policy.id}${port ? `@${port}` : ''}`;
}

/**
 * Fail closed. While Tor is not ready — still bootstrapping, stopped, crashed, or the
 * binary is missing — every network request from this session is cancelled rather than
 * being allowed to fall back to the direct connection. A privacy control that silently
 * degrades to "no privacy" is worse than one that visibly refuses.
 */
function installKillSwitch(sess, tor) {
  if (sess.__tojiKillSwitch) return; // onBeforeRequest holds a single listener per session
  sess.__tojiKillSwitch = true;
  sess.webRequest.onBeforeRequest((details, callback) => {
    const isNetwork = NETWORK_SCHEME_RE.test(details.url || '');
    if (!isNetwork) return callback({}); // about:, data:, devtools:, extensions
    callback({ cancel: !(tor && tor.isReady && tor.isReady()) });
  });
}

/**
 * WebRTC can reveal addresses the proxy never sees. Tor containers get UDP that isn't
 * proxied disabled outright; direct containers still hide host/LAN candidates.
 */
function applyWebRtcPolicy(contents, partition) {
  const policy = parsePartition(partition);
  if (!policy) return;
  try {
    contents.setWebRTCIPHandlingPolicy(policy.egress === 'tor' ? 'disable_non_proxied_udp' : 'default_public_interface_only');
  } catch {
    // Older/newer Electron may rename this; never let it block page load.
  }
}

module.exports = { PARTITION_RE, parsePartition, applySessionPolicy, applyWebRtcPolicy, installKillSwitch };

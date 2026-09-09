'use strict';

// Builds the ad-blocking engine off the main thread.
//
// Parsing the filter lists (EasyList, EasyPrivacy, uBlock Origin's lists, the annoyance
// lists: a few hundred thousand rules) takes a couple of seconds of solid CPU. Done in the
// main process that would freeze every window for the duration, on first launch and again
// at every refresh. So the lists are fetched and parsed here, in a worker thread, and the
// finished engine goes back serialized; deserializing it on the main side takes a moment.

const { parentPort, workerData } = require('node:worker_threads');
const { FiltersEngine, fetchLists, fetchResources, fullLists } = require('@ghostery/adblocker');

async function build() {
  const urls = Array.isArray(workerData && workerData.lists) && workerData.lists.length ? workerData.lists : fullLists;
  const [lists, resources] = await Promise.all([fetchLists(fetch, urls), fetchResources(fetch)]);
  const engine = FiltersEngine.parse(lists.join('\n'), { enableCompression: false });
  if (resources !== undefined) engine.updateResources(resources, `${resources.length}`);
  const serialized = engine.serialize();
  // Copy into a fresh buffer so the whole thing can be handed over rather than cloned.
  const bytes = new Uint8Array(serialized.byteLength);
  bytes.set(serialized);
  parentPort.postMessage({ ok: true, engine: bytes }, [bytes.buffer]);
}

build().catch((error) => {
  parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
});

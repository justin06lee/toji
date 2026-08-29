import type { EngineModel, Provider, ProviderCapabilities } from '@justin06lee/yagami';
import { yagamiClient } from './yagamiModel.js';

// The catalog of models Toji can actually run: every model reported by every
// coding-agent CLI on this machine, not just Claude's.
//
// Why this exists: yagami routes a BARE model id ("gpt-5.6-luna") to the default
// provider — which is Claude Code whenever it is installed. So a Codex/Gemini/ACP
// model name typed on its own silently went to Claude, which rejected it on every
// call ("There's an issue with the selected model"). Models are only routed
// correctly when qualified as "provider:model", so Toji resolves ids through this
// catalog and stores the qualified form.

/** One selectable model, always addressed by its qualified `provider:model` id. */
export interface CatalogModel {
  /** Qualified id, e.g. "codex:gpt-5.6-luna". This is what gets stored and sent. */
  id: string;
  /** Provider-native id, e.g. "gpt-5.6-luna". */
  model: string;
  provider: string;
  providerLabel: string;
  label: string;
  description?: string;
  /** Canonical wire id an alias maps to, e.g. "sonnet" → "claude-sonnet-5". */
  resolvedModel?: string;
}

/** A harness and what it can natively do; capabilities differ per provider. */
export interface CatalogProvider {
  id: string;
  label: string;
  /** The CLI is installed AND answered a model probe. */
  usable: boolean;
  /** Why the probe failed (not installed, not signed in, ACP handshake failed…). */
  error?: string;
  modelCount: number;
  capabilities: ProviderCapabilities;
}

export interface ModelCatalog {
  models: CatalogModel[];
  providers: CatalogProvider[];
  /** Provider whose models may also be addressed bare. */
  defaultProvider: string;
  at: string;
}

const EMPTY: ModelCatalog = { models: [], providers: [], defaultProvider: '', at: '' };

// Probing spawns a short-lived process per harness (~3s all told), so the result is
// cached. The UI can force a refresh, and settings changes never need one.
const TTL_MS = 5 * 60_000;
let cache: { at: number; catalog: ModelCatalog } | null = null;
let inFlight: Promise<ModelCatalog> | null = null;

function providerCapabilities(provider: Provider): ProviderCapabilities {
  return provider.capabilities;
}

/**
 * Ask every installed provider for its models. A provider that fails its probe is
 * reported with the reason rather than dropped, so the UI can say "Gemini CLI —
 * not signed in" instead of pretending it is ready.
 */
async function probe(): Promise<ModelCatalog> {
  const client = yagamiClient();
  const engine = client.engine;
  const defaultProvider = engine.defaultProvider.id;
  const models: CatalogModel[] = [];
  const providers: CatalogProvider[] = [];

  const entries = await Promise.all(
    engine.providerIds.map(async (id) => {
      const provider = engine.resolve(id).provider;
      try {
        return { id, provider, models: await provider.listModels(), error: undefined as string | undefined };
      } catch (error) {
        return { id, provider, models: [] as EngineModel[], error: error instanceof Error ? error.message : String(error) };
      }
    })
  );

  for (const entry of entries) {
    const label = entry.provider.label;
    // The engine lists the default provider's models bare AND qualified; Toji always
    // stores the qualified id, so a later change of default provider can't re-point a
    // saved selection at a different harness's model of the same name.
    const seen = new Set<string>();
    for (const model of entry.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push({
        id: `${entry.id}:${model.id}`,
        model: model.id,
        provider: entry.id,
        providerLabel: label,
        label: model.display_name || model.id,
        ...(model.description ? { description: model.description } : {}),
        ...(model.resolved_model ? { resolvedModel: model.resolved_model } : {})
      });
    }
    providers.push({
      id: entry.id,
      label,
      usable: !entry.error && entry.models.length > 0,
      ...(entry.error ? { error: entry.error } : {}),
      modelCount: seen.size,
      capabilities: providerCapabilities(entry.provider)
    });
  }

  return { models, providers, defaultProvider, at: new Date().toISOString() };
}

/** The catalog, cached. `force` re-probes every harness. */
export async function modelCatalog(force = false): Promise<ModelCatalog> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.catalog;
  if (!force && inFlight) return inFlight;
  const run = probe()
    .then((catalog) => {
      cache = { at: Date.now(), catalog };
      return catalog;
    })
    .catch(() => cache?.catalog ?? EMPTY)
    .finally(() => {
      inFlight = null;
    });
  inFlight = run;
  return run;
}

/** Last probed catalog without triggering one; empty until the first probe lands. */
export function cachedCatalog(): ModelCatalog {
  return cache?.catalog ?? EMPTY;
}

/** Populate the cache in the background (boot, settings save) so lookups are warm. */
export function warmCatalog(): void {
  void modelCatalog().catch(() => {});
}

/**
 * Resolve a stored model id to the form yagami routes correctly.
 *
 * A qualified id passes through. A bare id is matched against the catalog and
 * qualified with its owning provider — this is what stops "gpt-5.6-luna" (a Codex
 * model) from being handed to Claude Code. An id nothing claims is returned as-is,
 * so an unprobed-but-valid model still reaches the engine.
 */
export function qualifyModel(raw: string, catalog: ModelCatalog = cachedCatalog()): string {
  const model = raw.trim();
  if (!model) return '';
  const providerIds = new Set(catalog.providers.map((p) => p.id));
  const colon = model.indexOf(':');
  if (colon > 0 && providerIds.has(model.slice(0, colon))) return model;
  if (providerIds.has(model)) return model; // a bare provider id = that provider's default
  const exact = catalog.models.find((m) => m.model === model);
  if (exact) return exact.id;
  // Tolerate a qualified id being stored without its provider having been probed yet.
  const qualified = catalog.models.find((m) => m.id === model);
  return qualified ? qualified.id : model;
}

/** Catalog entry for a stored/qualified model id, if the catalog knows it. */
export function findModel(raw: string, catalog: ModelCatalog = cachedCatalog()): CatalogModel | undefined {
  const id = qualifyModel(raw, catalog);
  return catalog.models.find((m) => m.id === id);
}

/**
 * What the provider behind this model can natively do. Undefined when the catalog
 * has not been probed yet or the id belongs to no known provider — callers then
 * fall back to asking the engine directly.
 */
export function capabilitiesFor(raw: string, catalog: ModelCatalog = cachedCatalog()): ProviderCapabilities | undefined {
  const model = qualifyModel(raw, catalog);
  const providerId = model.includes(':') ? model.slice(0, model.indexOf(':')) : catalog.defaultProvider;
  return catalog.providers.find((p) => p.id === providerId)?.capabilities;
}

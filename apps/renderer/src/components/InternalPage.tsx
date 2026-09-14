import { ArrowRight, BookMarked, Boxes, Brain, Bug, Check, Compass, Copy, Cpu, Download, EyeOff, FileText, Globe, KeyRound, Loader2, Palette, Paperclip, Plus, Puzzle, RefreshCw, Route, Search, Star, Trash2, TrendingUp, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addBookmarks,
  addMemory,
  addReference,
  deleteBookmark,
  deleteMemoryFact,
  deleteReference,
  getAgentModels,
  getAgents,
  getBilling,
  getBookmarks,
  getCerebrasModels,
  getMemoryFacts,
  getPinnedMemory,
  getReferences,
  getSettings,
  saveSettings,
  savePinnedMemory,
  type Bookmark,
  type MemoryFact,
  type PinnedMemory,
  type ReferenceDoc
} from '../lib/api';
import type { AgentChoice, AgentsStatus, Billing, CerebrasModels, InternalPage as InternalPageKind, ModelCatalog, Plan, ThinkingLevel, UserSettings } from '../types';
import { bridge, isElectron, type AdblockStatus, type BrowserSettings, type BugReportAccount, type ImportBrowser, type TorStatus, type VaultEntry, type VaultStatus } from '../lib/bridge';
import { hasBrowserSettings, setBrowserSetting, useBrowserSettings } from '../lib/browserSettings';
import { publicAsset } from '../lib/publicAsset';
import { BOOKMARKS_BAR_EVENT, bookmarksBarPinned, setBookmarksBarPinned } from './BookmarksBar';
import { PROFILE_AVATARS, newContainer, type Container, type Egress } from '../lib/containers';
import { addBookmarkCount, describeBookmarksFile, describeBrowser, describeImport, describePasswordsFile, planProfiles, plural, type ImportMessage, type ImportTotals } from '../lib/browserImport';
import { VaultUnavailable } from './VaultBar';
import { ProfileAvatar } from './ProfileAvatar';
import { SEARCH_ENGINES, type SearchEngineId } from '../lib/nav';
import { FIELD, FIELD_BUTTON, FIELD_BUTTON_QUIET, FIELD_MONO, FIELD_TEXTAREA } from '../lib/fieldStyles';
import { Dropdown, type DropdownOption } from './Dropdown';
import { ColorPicker } from './ColorPicker';
import { Switch } from './Switch';
import { autosaveEnabled, setAutosaveEnabled } from '../lib/vaultAutosave';
import { providerNote } from '../lib/providerState';
import { REPLAY_EVENT, REPLAY_SECONDS, replayEnabled, setReplayEnabled } from '../lib/bugReport';


interface InternalPageProps {
  page: InternalPageKind;
  onOpenUrl: (url: string) => void;
  onGetStarted: () => void;
  containers: Container[];
  /** The container this tab lives in — where imported passwords go. */
  containerId: string;
  onContainersChange: (containers: Container[]) => void;
  onClearContainer: (containerId: string) => void;
  /** The question that sent the user to the plans page, so it survives the detour. */
  pendingQuery?: string;
  /** Run that question now, on whatever backend is configured by the time they leave. */
  onContinue?: () => void;
  /** Open the plans page (from Settings, where there is no room for it inline). */
  onShowPlans?: () => void;
  /** Open the bug report sheet (the Help menu does the same). */
  onReportBug?: () => void;
}

export function InternalPage({ page, onOpenUrl, onGetStarted, containers, containerId, onContainersChange, onClearContainer, pendingQuery, onContinue, onShowPlans, onReportBug }: InternalPageProps) {
  return (
    <PageFrame wide={page === 'plans'}>
      {page === 'welcome' ? (
        <WelcomeView onOpenUrl={onOpenUrl} onGetStarted={onGetStarted} containers={containers} onContainersChange={onContainersChange} containerId={containerId} />
      ) : page === 'plans' ? (
        <PlansView onOpenUrl={onOpenUrl} pendingQuery={pendingQuery} onContinue={onContinue} />
      ) : (
        <SettingsView containers={containers} onContainersChange={onContainersChange} onClearContainer={onClearContainer} onShowPlans={onShowPlans} onReportBug={onReportBug} />
      )}
    </PageFrame>
  );
}

/**
 * The scrolling sheet every internal page sits on — a tab in the Electron app, a whole
 * document in the Gecko browser. The plans page is wider than the others: three tiers
 * side by side don't fit 760px.
 */
export function PageFrame({ wide = false, children }: { wide?: boolean; children: React.ReactNode }) {
  const width = wide ? 'w-[min(1000px,94vw)]' : 'w-[min(760px,92vw)]';
  return (
    <div className="h-full w-full overflow-y-auto bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className={`mx-auto ${width} px-6 py-12`}>{children}</div>
    </div>
  );
}

const ICON = publicAsset('toji-round.png');

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-neutral-500">{icon}</span>
        <h2 className="text-[15px] font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

/**
 * The calm stand-in for something the browser this page runs in cannot do yet (the
 * Gecko browser grows its half of the bridge a piece at a time). Every section checks
 * for the bridge calls it needs rather than assuming them.
 */
function NotAvailable({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-black/10 p-4 text-center text-[13px] text-neutral-400 dark:border-white/12">{children}</p>;
}

/** What a switch says when its bridge call is missing: outside Toji, or in a build that lacks it. */
const notHere = () => (isElectron() ? 'Not available in this version yet.' : 'Needs the Toji desktop app.');

const ADDONS_SITE = 'https://addons.mozilla.org/firefox/';

// ---------------------------------------------------------------------------
// Welcome / onboarding
// ---------------------------------------------------------------------------
export function WelcomeView({
  onOpenUrl,
  onGetStarted,
  containers,
  onContainersChange,
  containerId
}: {
  onOpenUrl: (url: string) => void;
  onGetStarted: () => void;
  containers: Container[];
  onContainersChange: (containers: Container[]) => void;
  containerId: string;
}) {
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  const [settingDefault, setSettingDefault] = useState(false);
  const [browsers, setBrowsers] = useState<ImportBrowser[] | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<ImportMessage | null>(null);
  const [imports, setImports] = useState(0); // bumps after each import, so the bookmark list below refreshes
  const [extensions, setExtensions] = useState<{ id: string; name: string }[]>([]);
  const [webStoreOk, setWebStoreOk] = useState(false);
  // An import adds containers as it goes (each browser profile becomes one), so it reads
  // the latest list rather than the one from the render that started it.
  const containersRef = useRef(containers);
  containersRef.current = containers;

  const checkDefault = useCallback(() => {
    void Promise.resolve(bridge().isDefaultBrowser?.()).then((v) => setIsDefault(Boolean(v)));
  }, []);

  useEffect(() => {
    checkDefault();
    void Promise.resolve(bridge().importBrowsers?.())
      .then((found) => setBrowsers(found ?? []))
      .catch(() => setBrowsers([]));
    void bridge().listExtensions?.().then((e) => setExtensions(e ?? [])).catch(() => {});
    void bridge().webStoreAvailable?.().then((v) => setWebStoreOk(Boolean(v))).catch(() => {});
    // macOS asks "make Toji the default?" in a dialog of its own. Whatever was answered is
    // known by the time focus returns, so read it then rather than wait for another click.
    window.addEventListener('focus', checkDefault);
    return () => window.removeEventListener('focus', checkDefault);
  }, [checkDefault]);

  const makeDefault = async () => {
    setSettingDefault(true);
    try {
      const ok = (await bridge().setDefaultBrowser?.()) ?? false;
      setIsDefault(ok || (await bridge().isDefaultBrowser?.()) || false);
    } finally {
      setSettingDefault(false);
    }
  };

  // The Gecko browser files imported bookmarks into Firefox's own bookmarks and answers
  // with a count; the Electron app hands them back to be kept by the agent server.
  const nativeBookmarks = hasBrowserSettings();

  /**
   * Everything a browser has: bookmarks into the store (or, under Gecko, the browser's
   * bookmarks), passwords into the vault (in the browser — they never come through here),
   * and with several profiles, a Toji profile for each.
   */
  const doImport = async (browser: ImportBrowser) => {
    setImporting(browser.id);
    setImportMsg(null);
    try {
      const plan = planProfiles(browser.profiles, containersRef.current, containerId);
      if (plan.created > 0) onContainersChange(plan.containers);
      const totals: ImportTotals = { bookmarks: 0, passwords: 0, profiles: plan.created, ...(nativeBookmarks ? { nativeBookmarks: true } : {}) };
      for (const target of plan.targets) {
        const result = await bridge().importBrowser?.({ browser: browser.id, profile: target.profile.dir, containerId: target.containerId });
        if (!result) throw new Error('import is only available in the Toji app');
        if (nativeBookmarks) {
          totals.bookmarks = addBookmarkCount(totals.bookmarks, result.bookmarks);
        } else {
          const items = target.prefixFolders
            ? result.bookmarks.items.map((b) => ({ ...b, folder: b.folder ? `${target.profile.name} / ${b.folder}` : target.profile.name }))
            : result.bookmarks.items;
          if (items.length) {
            totals.bookmarks = (totals.bookmarks ?? 0) + (await addBookmarks(items)).added;
            setImports((n) => n + 1);
          }
        }
        totals.passwords += result.passwords.added;
        totals.bookmarkError ??= result.bookmarks.error;
        if (result.passwords.error && result.passwords.error !== 'unsupported') totals.passwordError ??= result.passwords.error;
      }
      setImportMsg(describeImport(browser.name, totals));
    } catch {
      setImportMsg({ text: `Import from ${browser.name} failed.`, tone: 'warn' });
    } finally {
      setImporting(null);
    }
  };

  const importBookmarksFile = async () => {
    setImporting('bookmarks-file');
    setImportMsg(null);
    try {
      const picked = await bridge().importBookmarksFile?.();
      if (!picked || picked.canceled) return;
      if (nativeBookmarks) {
        setImportMsg(describeBookmarksFile(picked.count ?? null));
        return;
      }
      const added = picked.bookmarks.length ? (await addBookmarks(picked.bookmarks)).added : 0;
      if (added) setImports((n) => n + 1);
      setImportMsg(picked.bookmarks.length ? { text: `Imported ${plural(added, 'bookmark')} from the file.`, tone: 'ok' } : { text: 'No bookmarks found in that file.', tone: 'warn' });
    } catch {
      setImportMsg({ text: 'Import failed.', tone: 'warn' });
    } finally {
      setImporting(null);
    }
  };

  const importPasswordsFile = async () => {
    setImporting('passwords-file');
    setImportMsg(null);
    try {
      const result = await bridge().importPasswordsFile?.(containerId);
      if (!result || result.canceled) return;
      setImportMsg(describePasswordsFile(result));
    } catch {
      setImportMsg({ text: 'Import failed.', tone: 'warn' });
    } finally {
      setImporting(null);
    }
  };

  // Browsers that are here get a row; Safari always does, since every Mac has it and its
  // route is the exported file. The rest are named once, so it is clear they would work.
  const shown = (browsers ?? []).filter((b) => b.available || b.id === 'safari');
  const missing = (browsers ?? []).filter((b) => !b.available && b.id !== 'safari');

  const addExt = async () => {
    const res = await bridge().addExtension?.();
    if (res && 'name' in res) setExtensions((e) => [...e, res]);
    else void bridge().listExtensions?.().then((e) => setExtensions(e ?? []));
  };

  // Each part of this page shows only if the browser it runs in can do it. The Gecko
  // browser installs Firefox add-ons rather than Chrome extensions, and may not offer
  // importing or the default-browser switch yet.
  const toji = bridge();
  const addons = Boolean(toji.openAddons);
  const canListExtensions = Boolean(toji.listExtensions);
  const canLoadUnpacked = Boolean(toji.addExtension);
  const canSetDefault = Boolean(toji.setDefaultBrowser);
  const canImportBrowsers = Boolean(toji.importBrowsers);
  const canImportBookmarksFile = Boolean(toji.importBookmarksFile);
  const canImportPasswordsFile = Boolean(toji.importPasswordsFile);
  const canImportFiles = canImportBookmarksFile || canImportPasswordsFile;

  return (
    <div>
      <div className="mb-10 flex flex-col items-center text-center">
        <img src={ICON} alt="Toji" className="mb-4 h-16 w-16 rounded-[18px] shadow-sm" />
        <h1 className="text-3xl font-semibold tracking-tight">Welcome to Toji</h1>
        <p className="mt-2 max-w-md text-[14px] text-neutral-500">An agent-first browser. Bring your own local coding agent, ask it to do things on any page, and keep your research inside familiar browser tabs.</p>
      </div>

      {/* Extensions area lives at the top, mirroring a browser toolbar. */}
      <Section icon={<Puzzle size={16} />} title="Extensions">
        <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <div className="flex min-h-9 flex-wrap items-center gap-2">
            {canListExtensions && extensions.length === 0 && <span className="text-[12.5px] text-neutral-400">No extensions yet.</span>}
            {extensions.map((e) => (
              <span key={e.id} className="inline-flex items-center gap-1.5 rounded-lg bg-black/[0.05] px-2 py-1 text-[12px] dark:bg-white/10">
                <Puzzle size={12} /> {e.name}
              </span>
            ))}
            {addons ? (
              <button type="button" onClick={() => toji.openAddons?.()} className={FIELD_BUTTON}>
                <Puzzle size={13} /> Browse add-ons
              </button>
            ) : (
              <>
                {webStoreOk && (
                  <button type="button" onClick={() => onOpenUrl('https://chromewebstore.google.com/')} className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-2.5 py-1 text-[12px] font-medium text-white transition hover:opacity-85 dark:bg-white dark:text-neutral-900">
                    <Puzzle size={13} /> Chrome Web Store
                  </button>
                )}
                {canLoadUnpacked && (
                  <button type="button" onClick={() => void addExt()} className={`${FIELD_BUTTON_QUIET} border-dashed border-black/15 text-neutral-600 dark:text-neutral-300`}>
                    <Plus size={13} /> Load unpacked…
                  </button>
                )}
              </>
            )}
            {!addons && !webStoreOk && !canLoadUnpacked && !canListExtensions && <span className="text-[12.5px] text-neutral-400">Extensions aren&rsquo;t available here yet.</span>}
          </div>
          {(addons || webStoreOk || canLoadUnpacked) && (
            <p className="mt-2 text-[11.5px] text-neutral-400">
              {addons ? (
                <>
                  Toji runs Firefox add-ons. Find more on{' '}
                  <button type="button" onClick={() => onOpenUrl(ADDONS_SITE)} className="underline underline-offset-2 transition hover:text-neutral-600 dark:hover:text-neutral-200">
                    addons.mozilla.org
                  </button>
                  , and manage the ones you have under Browse add-ons.
                </>
              ) : webStoreOk ? (
                'Open the Chrome Web Store and click “Add to Chrome” to install — or load an unpacked folder. Extensions apply across all tabs. Support is experimental.'
              ) : (
                'Load an unpacked Chrome extension folder. (Web Store integration unavailable in this build.)'
              )}
            </p>
          )}
        </div>
      </Section>

      {canSetDefault && (
        <Section icon={<Star size={16} />} title="Make Toji your default browser">
          <div className="flex items-center justify-between rounded-xl border border-black/10 p-3 dark:border-white/10">
            <span className="text-[13px] text-neutral-500">{isDefault ? 'Toji is your default browser.' : 'Open links from other apps in Toji.'}</span>
            <button
              type="button"
              onClick={() => void makeDefault()}
              disabled={settingDefault || isDefault === true}
              className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-1.5 text-[12.5px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              {settingDefault && <Loader2 size={12} className="animate-spin" />}
              {isDefault ? <><Check size={13} /> Default</> : 'Set as default'}
            </button>
          </div>
        </Section>
      )}

      <Section icon={<Download size={16} />} title="Import from another browser">
        {!canImportBrowsers && !canImportFiles ? (
          <NotAvailable>Importing from other browsers isn&rsquo;t available in this version yet.</NotAvailable>
        ) : (
        <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          {canImportBrowsers && (
          <>
          <div className="space-y-2">
            {browsers === null && <span className="text-[12.5px] text-neutral-400">Looking for other browsers…</span>}
            {browsers?.length === 0 && <span className="text-[12.5px] text-neutral-400">No other browsers found.</span>}
            {shown.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0 truncate">
                  <span className={`text-[13px] ${b.available ? '' : 'text-neutral-400'}`}>{b.name}</span>
                  {b.available && <span className="ml-2 text-[11.5px] text-neutral-400">{describeBrowser(b)}</span>}
                </div>
                {b.available ? (
                  <button type="button" disabled={importing !== null} onClick={() => void doImport(b)} className={FIELD_BUTTON_QUIET}>
                    {importing === b.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Import
                  </button>
                ) : (
                  <span className="text-[11.5px] text-neutral-400">Export from Safari, then import the files below</span>
                )}
              </div>
            ))}
          </div>
          {missing.length > 0 && <p className="mt-2 text-[11.5px] text-neutral-400">Not on this Mac: {missing.map((b) => b.name).join(', ')}.</p>}
          </>
          )}
          {canImportFiles && (
          <>
          <div className={`flex flex-wrap items-center gap-2 ${canImportBrowsers ? 'mt-3 border-t border-black/[0.06] pt-3 dark:border-white/10' : ''}`}>
            <span className="text-[12px] text-neutral-500">From an exported file</span>
            {canImportBookmarksFile && (
              <button type="button" disabled={importing !== null} onClick={() => void importBookmarksFile()} className={FIELD_BUTTON_QUIET}>
                {importing === 'bookmarks-file' ? <Loader2 size={12} className="animate-spin" /> : <BookMarked size={12} />} Bookmarks (HTML)…
              </button>
            )}
            {canImportPasswordsFile && (
              <button type="button" disabled={importing !== null} onClick={() => void importPasswordsFile()} className={FIELD_BUTTON_QUIET}>
                {importing === 'passwords-file' ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />} Passwords (CSV)…
              </button>
            )}
          </div>
          <p className="mt-2 text-[11.5px] text-neutral-400">
            Every browser can export both. Safari: File → Export → Bookmarks. Passwords: in the Passwords app, File → Export All Passwords.
          </p>
          </>
          )}
          {importMsg && (
            <p className={`mt-2 text-[12px] ${importMsg.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
              {importMsg.text}
              {importMsg.settings && (
                <button type="button" onClick={() => void bridge().openFullDiskAccess?.()} className="ml-1.5 underline underline-offset-2">
                  Open System Settings
                </button>
              )}
            </p>
          )}
        </div>
        )}
        {/* Under Gecko imported bookmarks live in the browser's own bookmarks, not this list. */}
        {!nativeBookmarks && <BookmarksList onOpenUrl={onOpenUrl} refreshKey={imports} />}
      </Section>

      <div className="mt-10 flex justify-center">
        <button type="button" onClick={onGetStarted} className="inline-flex items-center gap-2 rounded-xl bg-neutral-900 px-5 py-2.5 text-[14px] font-medium text-white transition hover:opacity-85 dark:bg-white dark:text-neutral-900">
          <Compass size={16} /> Start browsing
        </button>
      </div>
    </div>
  );
}

/**
 * The subscription page. It opens when someone on the Toji plan asks for something the
 * plan would answer — so it is the first thing a new user sees, and it has to do two
 * jobs at once: sell the plan, and make sure a person who does not want to pay is not
 * stuck. Hence BringYourOwn directly below the tiers: it explains what yagami is,
 * switches the backend in place, and hands the original question back.
 */
export function PlansView({ onOpenUrl, pendingQuery, onContinue }: { onOpenUrl: (url: string) => void; pendingQuery?: string; onContinue?: () => void }) {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void getBilling()
      .then(setBilling)
      .catch(() => setFailed(true));
  }, []);

  const byoRef = useRef<HTMLDivElement>(null);
  const scrollToByo = () => byoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const all = billing?.plans ?? [];
  const tiers = all.filter((p) => !p.wide);
  const wide = all.filter((p) => p.wide);
  const isCurrent = (plan: Plan) => Boolean(billing && billing.subscription.plan === plan.id && billing.subscription.active);

  return (
    <div>
      <div className="mb-9 flex flex-col items-center text-center">
        <img src={ICON} alt="Toji" className="mb-4 h-14 w-14 rounded-[16px] shadow-sm" />
        <h1 className="text-3xl font-semibold tracking-tight">Toji</h1>
        <p className="mt-2 max-w-lg text-[14px] text-neutral-500">
          Toji does not ship a model of its own. Pick who runs one for you — us, or a coding agent you already pay for.
        </p>
      </div>

      {failed && <p className="mb-6 rounded-xl border border-black/10 p-3 text-[13px] text-neutral-500 dark:border-white/10">Couldn&apos;t reach the local Toji server, so plans are unavailable. Everything below still works.</p>}

      {/* Every column card spans the same five rows of this grid — name, price, tagline,
          features, button — so a one-line tagline on one card cannot pull its feature
          list up out of line with its neighbours'. */}
      <div className="grid gap-4 md:grid-cols-3 md:grid-rows-[auto_auto_auto_1fr_auto]">
        {tiers.map((plan) => (
          <PlanCard key={plan.id} plan={plan} current={isCurrent(plan)} onOpenUrl={onOpenUrl} onPickFree={scrollToByo} />
        ))}
      </div>
      {wide.map((plan) => (
        <WidePlanCard key={plan.id} plan={plan} current={isCurrent(plan)} onOpenUrl={onOpenUrl} />
      ))}

      {billing && !billing.subscription.active && billing.plans.some((p) => p.pricing !== 'free' && !p.checkoutUrl) && (
        <p className="mt-3 text-center text-[12px] text-neutral-400">Paid plans aren&apos;t open for sign-up yet. Toji is free and fully usable in the meantime.</p>
      )}

      <div ref={byoRef} data-testid="plans-byo" className="mt-12">
        <BringYourOwn pendingQuery={pendingQuery} onContinue={onContinue} />
      </div>
    </div>
  );
}

function PlanCard({ plan, current, onOpenUrl, onPickFree }: { plan: Plan; current: boolean; onOpenUrl: (url: string) => void; onPickFree: () => void }) {
  return (
    <div
      className={`flex flex-col rounded-2xl border p-5 md:row-span-5 md:grid md:grid-rows-subgrid md:gap-y-0 ${
        plan.highlight ? 'border-black/25 dark:border-white/30' : 'border-black/10 dark:border-white/10'
      }`}
    >
      <PlanName plan={plan} current={current} />
      <PlanPrice plan={plan} />
      <p className="mb-4 text-[13px] leading-relaxed text-neutral-500">{plan.tagline}</p>
      <FeatureList features={plan.features} className="mb-5" />
      {plan.pricing === 'free' ? (
        <button type="button" onClick={onPickFree} className={`${FIELD_BUTTON_QUIET} w-full`}>
          Use your own agent
        </button>
      ) : (
        <SubscribeButton plan={plan} onOpenUrl={onOpenUrl} className="w-full" />
      )}
    </div>
  );
}

/**
 * The tier that is an add-on to the grid rather than a column in it: one wide card
 * underneath, laid out as name and price, then what it includes, then the button.
 */
function WidePlanCard({ plan, current, onOpenUrl }: { plan: Plan; current: boolean; onOpenUrl: (url: string) => void }) {
  return (
    <div className="mt-4 grid gap-5 rounded-2xl border border-black/10 p-5 dark:border-white/10 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)_auto] md:items-center md:gap-8">
      <div>
        <PlanName plan={plan} current={current} />
        <PlanPrice plan={plan} />
        <p className="text-[13px] leading-relaxed text-neutral-500">{plan.tagline}</p>
      </div>
      <FeatureList features={plan.features} />
      <SubscribeButton plan={plan} onOpenUrl={onOpenUrl} className="w-full md:w-auto md:min-w-[150px]" />
    </div>
  );
}

function PlanName({ plan, current }: { plan: Plan; current: boolean }) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <h2 className="text-[15px] font-semibold">{plan.name}</h2>
      {plan.highlight && (
        <span className="inline-flex items-center gap-1 rounded-full bg-black/[0.06] px-2 py-0.5 text-[10.5px] uppercase tracking-wide text-neutral-500 dark:bg-white/10">
          <TrendingUp size={10} /> Popular
        </span>
      )}
      {current && <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[10.5px] uppercase tracking-wide text-neutral-500 dark:bg-white/10">Current</span>}
    </div>
  );
}

function PlanPrice({ plan }: { plan: Plan }) {
  return (
    <p className="mb-4 flex items-baseline gap-1">
      <span className="text-[30px] font-semibold tracking-tight">{plan.pricing === 'usage' ? 'Pay as you go' : plan.pricing === 'monthly' ? `$${plan.priceUsd}` : 'Free'}</span>
      {plan.pricing === 'monthly' && <span className="text-[13px] text-neutral-400">/month</span>}
    </p>
  );
}

function FeatureList({ features, className = '' }: { features: string[]; className?: string }) {
  return (
    <ul className={`space-y-2 ${className}`}>
      {features.map((feature) => (
        <li key={feature} className="flex gap-2 text-[13px] leading-relaxed">
          <Check size={14} className="mt-[3px] shrink-0 text-neutral-400" />
          <span>{feature}</span>
        </li>
      ))}
    </ul>
  );
}

function SubscribeButton({ plan, onOpenUrl, className = '' }: { plan: Plan; onOpenUrl: (url: string) => void; className?: string }) {
  const purchasable = Boolean(plan.checkoutUrl);
  return (
    <button
      type="button"
      disabled={!purchasable}
      title={purchasable ? undefined : 'Sign-up opens once Toji billing is live'}
      onClick={() => onOpenUrl(plan.checkoutUrl)}
      className={`${purchasable ? FIELD_BUTTON : FIELD_BUTTON_QUIET} ${className}`}
    >
      {purchasable ? (
        <>
          Subscribe <ArrowRight size={14} />
        </>
      ) : (
        'Not open yet'
      )}
    </button>
  );
}

/**
 * The escape hatch, and the explanation that has to come with it: someone who lands
 * here mid-question needs to know what "yagami" even means before being asked to pick
 * one. Switching backend happens here rather than in Settings so the question they
 * asked is still on screen when they continue.
 */
function BringYourOwn({ pendingQuery, onContinue }: { pendingQuery?: string; onContinue?: () => void }) {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const [settings, agents] = await Promise.all([getSettings(), getAgents()]);
    setModel(settings.agentModel ?? '');
    setStatus(agents);
    setCatalog(await getAgentModels().catch(() => null));
  }, []);
  useEffect(() => {
    // The server may be unreachable (or, in the Gecko browser, still starting): the
    // section then just shows nothing found, as it does before the answer arrives.
    void load().catch(() => {});
  }, [load]);

  const use = async (nextModel: string) => {
    setSaving(true);
    try {
      await saveSettings({ agent: 'yagami', agentModel: nextModel });
      setModel(nextModel);
      setStatus(await getAgents());
      setSaved(true);
    } catch {
      // Not saved: the button stays "Use this", so it can be tried again.
    } finally {
      setSaving(false);
    }
  };

  const installed = (status?.yagami.providers ?? []).filter((p) => p.installed);
  const usable = installed.filter((p) => p.usable);
  const onYagami = status?.choice === 'yagami';

  return (
    <div className="rounded-2xl border border-black/10 p-6 dark:border-white/10">
      <h2 className="text-[15px] font-semibold">Already pay for a coding agent? Use that instead.</h2>
      <p className="mt-2 text-[13.5px] leading-relaxed text-neutral-500">
        Toji drives the coding-agent CLIs already installed on this machine through <strong className="font-medium text-neutral-700 dark:text-neutral-300">yagami</strong> — an
        engine that speaks Claude Code, Codex, opencode, Gemini CLI and any ACP agent. It signs in as you already are, so there is no API key to paste and no extra bill: your
        Claude or ChatGPT subscription answers Toji&apos;s calls. This is the Free plan, and it is the whole browser, not a trial.
      </p>

      <div className="mt-5">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-neutral-400">Found on this machine</p>
        {installed.length === 0 ? (
          <p className="text-[13px] text-neutral-500">
            No coding CLIs found. Install one (Claude Code, Codex, opencode…) and it appears here, or point Toji at Cerebras or your own endpoint in Settings.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {installed.map((provider) => (
              <ProviderChip key={provider.id} provider={provider} />
            ))}
          </div>
        )}
      </div>

      {usable.length > 0 && (
        <div className="mt-5 flex flex-wrap items-end gap-2">
          <ModelPicker value={model} catalog={catalog} loading={!catalog} onChange={(v) => void use(v)} />
          <button type="button" disabled={saving || (onYagami && saved)} onClick={() => void use(model)} className={FIELD_BUTTON}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : onYagami && saved ? <Check size={14} /> : null}
            {onYagami && saved ? 'Using this' : 'Use this'}
          </button>
        </div>
      )}

      {status && (
        <p className="mt-4 text-[12.5px] text-neutral-500">
          Right now Toji runs <strong className="font-medium text-neutral-700 dark:text-neutral-300">{status.model}</strong>.
        </p>
      )}

      {pendingQuery && onContinue && (
        <div className="mt-6 border-t border-black/[0.07] pt-5 dark:border-white/10">
          <p className="mb-2 text-[11px] uppercase tracking-wide text-neutral-400">Your question is still here</p>
          <p className="mb-3 text-[14px]">“{pendingQuery}”</p>
          <button type="button" onClick={onContinue} className={FIELD_BUTTON}>
            Continue <ArrowRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** `refreshKey` changes whenever an import lands, so the list picks it up at once. */
function BookmarksList({ onOpenUrl, refreshKey = 0 }: { onOpenUrl: (url: string) => void; refreshKey?: number }) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const refresh = useCallback(() => void getBookmarks().then((r) => setBookmarks(r.bookmarks)).catch(() => {}), []);
  useEffect(() => refresh(), [refresh, refreshKey]);
  if (bookmarks.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-neutral-400">
        <BookMarked size={13} /> {bookmarks.length} imported
      </div>
      <div className="flex flex-wrap gap-1.5">
        {bookmarks.slice(0, 60).map((b) => (
          <span key={b.id} className="group inline-flex max-w-[240px] items-center gap-1.5 rounded-lg bg-black/[0.04] px-2 py-1 text-[12px] dark:bg-white/[0.06]">
            <button type="button" onClick={() => onOpenUrl(b.url)} className="truncate hover:underline" title={b.url}>
              {b.title || b.url}
            </button>
            <button type="button" aria-label="Remove" onClick={() => void deleteBookmark(b.id).then(refresh)} className="shrink-0 text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:text-red-500">
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const THINKING: DropdownOption<ThinkingLevel>[] = [
  { value: 'default', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
];

/**
 * The one status mark used across settings: a small neutral dot. Filled = active,
 * hollow = inactive, pulsing hollow = in progress. No traffic-light colors.
 */
/**
 * One installed coding CLI and whether it can serve a model right now. The same chip
 * on the welcome page and in Settings, with the same word for the same state: a CLI
 * the welcome page calls "signed out" must not become "unavailable" in Settings.
 * Installed but unusable reads as hollow, not on — it can't actually serve a model.
 */
function ProviderChip({ provider }: { provider: AgentsStatus['yagami']['providers'][number] }) {
  const note = providerNote(provider);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-black/[0.05] px-2.5 py-1 text-[12.5px] text-neutral-900 dark:bg-white/10 dark:text-neutral-100" title={provider.error ?? undefined}>
      <StatusDot state={note ? 'off' : 'on'} />
      {provider.label}
      {note && <span className="text-neutral-400">{note}</span>}
    </span>
  );
}

function StatusDot({ state }: { state: 'on' | 'busy' | 'off' }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
        state === 'on'
          ? 'bg-neutral-900 dark:bg-white'
          : state === 'busy'
            ? 'animate-pulse border border-neutral-400 dark:border-neutral-500'
            : 'border border-neutral-300 dark:border-neutral-600'
      }`}
    />
  );
}

export function SettingsView({
  containers,
  onContainersChange,
  onClearContainer,
  onShowPlans,
  onReportBug
}: {
  containers: Container[];
  onContainersChange: (containers: Container[]) => void;
  onClearContainer: (containerId: string) => void;
  onShowPlans?: () => void;
  onReportBug?: () => void;
}) {
  return (
    <div>
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Settings</h1>
      <ContainersSettings containers={containers} onChange={onContainersChange} onClear={onClearContainer} />
      <TorSettings />
      <VaultSettings containers={containers} />
      <AgentSettings onShowPlans={onShowPlans} />
      <SearchSettings />
      {hasBrowserSettings() && <AppearanceSettings />}
      <BrowsingSettings />
      <MemorySettings />
      <BugReportSettings onReportBug={onReportBug} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------
const EGRESS_OPTIONS: DropdownOption<Egress>[] = [
  { value: 'direct', label: 'Direct', hint: 'normal connection' },
  { value: 'tor', label: 'Tor', hint: 'onion-routed' }
];

function ContainersSettings({ containers, onChange, onClear }: { containers: Container[]; onChange: (c: Container[]) => void; onClear: (id: string) => void }) {
  const [newName, setNewName] = useState('');

  const patch = (id: string, next: Partial<Container>) => onChange(containers.map((c) => (c.id === id ? { ...c, ...next } : c)));

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    onChange([...containers, newContainer(name, containers)]);
    setNewName('');
  };

  return (
    <Section icon={<Boxes size={15} />} title="Containers">
      <p className="mb-4 text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Each container is a separate identity with its own cookies, storage and cache. A site you sign into in one container
        is signed out in every other, and a tracker embedded in both sees two unrelated browsers. Changing a container&rsquo;s
        connection moves it to a fresh session, so nothing carries across.
      </p>

      <div className="divide-y divide-black/[0.07] rounded-xl border border-black/10 dark:divide-white/10 dark:border-white/12">
        {containers.length === 0 && <p className="p-3 text-[13px] text-neutral-400">Loading containers…</p>}
        {containers.map((container) => (
          <div key={container.id} className="flex flex-wrap items-center gap-3 p-3">
            <button
              type="button"
              onClick={() => {
                const current = PROFILE_AVATARS.indexOf(container.avatar as (typeof PROFILE_AVATARS)[number]);
                patch(container.id, { avatar: PROFILE_AVATARS[(current + 1) % PROFILE_AVATARS.length] });
              }}
              aria-label={`${container.name} profile picture`}
              title="Change profile picture"
              className="shrink-0 rounded-full outline-none transition hover:scale-105 focus-visible:ring-2 focus-visible:ring-neutral-400"
            >
              <ProfileAvatar container={container} />
            </button>
            <ColorPicker value={container.color} onChange={(color) => patch(container.id, { color })} label={`${container.name} color`} />
            <input
              value={container.name}
              onChange={(e) => patch(container.id, { name: e.target.value })}
              aria-label="Container name"
              /* Reads as plain text until hovered/focused, but keeps the shared field
                 height so it lines up with the egress dropdown beside it. */
              className={`${FIELD} min-w-0 flex-1 border-transparent hover:border-black/10 dark:hover:border-white/12`}
            />
            <Dropdown
              value={container.egress}
              options={EGRESS_OPTIONS}
              onChange={(egress) => patch(container.id, { egress })}
              className="w-[150px] shrink-0"
            />
            <button
              type="button"
              onClick={() => patch(container.id, { ephemeral: !container.ephemeral })}
              title={container.ephemeral ? 'Ephemeral: discarded when the last tab closes' : 'Persistent: stays signed in across restarts'}
              className={`${FIELD_BUTTON_QUIET} ${
                container.ephemeral
                  ? 'border-black/20 bg-black/[0.05] dark:border-white/25 dark:bg-white/10'
                  : 'text-neutral-500 dark:text-neutral-400'
              }`}
            >
              <EyeOff size={12} />
              Ephemeral
            </button>
            <button
              type="button"
              onClick={() => onClear(container.id)}
              title={`Erase everything stored in ${container.name}`}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/[0.06] hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              disabled={container.builtin}
              onClick={() => onChange(containers.filter((c) => c.id !== container.id))}
              title={container.builtin ? 'Built-in containers can be renamed but not removed' : `Delete ${container.name}`}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/[0.06] hover:text-neutral-900 disabled:pointer-events-none disabled:opacity-25 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="New container name"
          className={`${FIELD} min-w-0 flex-1`}
        />
        <button
          type="button"
          onClick={add}
          disabled={!newName.trim()}
          className={FIELD_BUTTON}
        >
          <Plus size={13} />
          Add
        </button>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-neutral-400">
        Containers set to Tor stay offline until Tor connects &mdash; they will not fall back to a direct connection.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Tor
// ---------------------------------------------------------------------------
const OFFLINE_STATUS: TorStatus = { ready: false, state: 'off', progress: 0, detail: 'Tor is not running' };

function TorSettings() {
  const [status, setStatus] = useState<TorStatus>(OFFLINE_STATUS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void bridge().torStatus?.().then((s) => s && setStatus(s));
    return bridge().onTorStatus?.(setStatus);
  }, []);

  // Called on the bridge object, not handed around loose: the Gecko bridge's methods may need it.
  const available = Boolean(bridge().torStatus);
  const run = (fn: () => Promise<unknown> | undefined) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const running = status.state !== 'off' && status.state !== 'error';

  return (
    <Section icon={<Route size={15} />} title="Tor">
      <p className="mb-4 text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Toji drives the real Tor client rather than implementing onion routing itself. Containers set to Tor send every
        request through it &mdash; and while Tor is unavailable their traffic is cancelled outright, never quietly sent over
        the direct connection.
      </p>

      {!available ? (
        <NotAvailable>Tor controls aren&rsquo;t available in this version yet.</NotAvailable>
      ) : (
      <div className="rounded-xl border border-black/10 p-3 dark:border-white/12">
        <div className="flex flex-wrap items-center gap-3">
          <StatusDot state={status.ready ? 'on' : running ? 'busy' : 'off'} />
          <span className="min-w-0 flex-1 text-[13px]">
            {status.detail}
            {status.source === 'external' && <span className="ml-1.5 text-[11px] text-neutral-400">(external)</span>}
          </span>
          {running && !status.ready && <span className="shrink-0 text-[12px] tabular-nums text-neutral-400">{status.progress}%</span>}

          {status.ready && (
            <button type="button" onClick={run(() => bridge().torNewCircuit?.())} disabled={busy} className={FIELD_BUTTON_QUIET}>
              <RefreshCw size={12} className={busy ? 'animate-spin' : undefined} />
              New circuit
            </button>
          )}
          <button
            type="button"
            onClick={run(() => (running ? bridge().torStop?.() : bridge().torStart?.()))}
            disabled={busy}
            className={FIELD_BUTTON}
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {running ? 'Stop Tor' : 'Start Tor'}
          </button>
        </div>

        {status.ready && !status.isolated && (
          <p className="mt-3 border-t border-black/[0.07] pt-3 text-[12px] leading-relaxed text-neutral-500 dark:border-white/10 dark:text-neutral-400">
            Using a Tor instance that was already running. It offers a single SOCKS port, and Chromium cannot send SOCKS
            credentials, so every Tor container shares its circuits &mdash; they can be linked by their common exit. For
            per-container circuits, quit the other Tor and let Toji manage its own.
          </p>
        )}

        {status.state === 'error' && (
          <p className="mt-3 border-t border-black/[0.07] pt-3 text-[12px] leading-relaxed text-neutral-500 dark:border-white/10 dark:text-neutral-400">
            Toji looks for a <code className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[11px] dark:bg-white/10">tor</code> binary in the app bundle and the usual
            install locations, then for a Tor already listening on 9050 or 9150. On macOS,{' '}
            <code className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[11px] dark:bg-white/10">brew install tor</code> is enough; starting Tor Browser also works.
          </p>
        )}
      </div>
      )}

      <p className="mt-3 text-[12px] leading-relaxed text-neutral-400">
        Tor protects what the network can see about you. It does not make this browser indistinguishable from other
        browsers &mdash; for a threat model where that matters, use the Tor Browser.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
function VaultSettings({ containers }: { containers: Container[] }) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [generated, setGenerated] = useState('');
  const [copied, setCopied] = useState(false);
  // With the Gecko bridge, autosave is a browser setting; in the Electron app it is a
  // localStorage key (never touched under the bridge: a system-principal page has none).
  const settings = useBrowserSettings();
  const viaBrowser = hasBrowserSettings();
  const [localAutosave, setLocalAutosave] = useState(() => (viaBrowser ? true : autosaveEnabled()));
  const autosave = viaBrowser ? (settings?.vaultAutosave ?? true) : localAutosave;
  const changeAutosave = (next: boolean) => {
    if (viaBrowser) {
      void setBrowserSetting('vaultAutosave', next);
      return;
    }
    setAutosaveEnabled(next);
    setLocalAutosave(next);
  };
  const toji = bridge();
  const vault = Boolean(toji.vaultStatus || toji.vaultList);
  const canGenerate = Boolean(toji.vaultGenerate);

  const refresh = useCallback(async () => {
    const s = await bridge().vaultStatus?.();
    if (s) setStatus(s);
    const listed = await bridge().vaultList?.();
    if (listed?.ok) setEntries(listed.value);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (id: string) => {
    await bridge().vaultDelete?.(id);
    void refresh();
  };

  const generate = async () => {
    const password = await bridge().vaultGenerate?.(20);
    if (password) {
      setGenerated(password);
      setCopied(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(generated);
    setCopied(true);
  };

  const nameOf = (containerId: string | null) => containers.find((c) => c.id === containerId) ?? null;

  return (
    <Section icon={<KeyRound size={15} />} title="Passwords">
      <p className="mb-4 text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Saved logins are encrypted with your operating system&rsquo;s keychain and are scoped to the container they were saved
        in &mdash; a credential saved in Work is never offered in Personal. Passwords are held in Toji&rsquo;s main process and
        are filled straight into the page: the browser UI (and the AI agent driving it) can see which accounts exist, but
        never the passwords themselves.
      </p>

      {status && !status.available ? (
        <VaultUnavailable message={status.error ?? 'The vault is unavailable on this system.'} />
      ) : !vault && !viaBrowser ? (
        <NotAvailable>Saved passwords aren&rsquo;t available here yet.</NotAvailable>
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-black/10 p-3 dark:border-white/12">
            <span className="min-w-0">
              <span className="block text-[13px]">Save passwords automatically</span>
              <span className="mt-0.5 block text-[12px] leading-relaxed text-neutral-400">
                A login you submit goes into the vault once the sign-in goes through. Turn this off and Toji asks first, every time.
              </span>
            </span>
            <Switch
              checked={autosave}
              label="Save passwords automatically"
              disabled={viaBrowser && !settings}
              onChange={changeAutosave}
            />
          </div>
          {canGenerate && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <button type="button" onClick={generate} className={FIELD_BUTTON_QUIET}>
                <RefreshCw size={12} />
                Generate a password
              </button>
              {generated && (
                <button type="button" onClick={copy} title="Copy to clipboard" className={`${FIELD_BUTTON_QUIET} min-w-0 font-mono`}>
                  <span className="truncate">{generated}</span>
                  {copied ? <Check size={12} className="shrink-0 text-neutral-500" /> : <Copy size={12} className="shrink-0 text-neutral-400" />}
                </button>
              )}
            </div>
          )}

          {!vault ? (
            <NotAvailable>Saved logins aren&rsquo;t available in this version yet.</NotAvailable>
          ) : entries.length === 0 ? (
            <p className="rounded-xl border border-dashed border-black/10 p-4 text-center text-[13px] text-neutral-400 dark:border-white/12">
              {autosave ? 'No saved logins yet. Sign in to a site and Toji keeps the login for you.' : 'No saved logins yet. Sign in to a site and Toji will offer to save it.'}
            </p>
          ) : (
            <div className="divide-y divide-black/[0.07] rounded-xl border border-black/10 dark:divide-white/10 dark:border-white/12">
              {entries.map((entry) => {
                const container = nameOf(entry.containerId);
                return (
                  <div key={entry.id} className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px]">{entry.origin.replace(/^https?:\/\//, '')}</p>
                      <p className="truncate text-[12px] text-neutral-400">{entry.username || '(no username)'}</p>
                    </div>
                    {container && (
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-black/10 px-2 py-0.5 text-[11px] text-neutral-500 dark:border-white/12 dark:text-neutral-400">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: container.color }} />
                        {container.name}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(entry.id)}
                      aria-label={`Delete the login for ${entry.origin}`}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/[0.06] hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// A single provider field: label + input; password-style for keys (the server returns
// keys MASKED — sending the mask back leaves the stored key untouched).
function ProviderField({ label, value, onChange, placeholder, secret }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; secret?: boolean }) {
  return (
    <label className="block flex-1">
      <span className="mb-1 block text-[11px] text-neutral-400">{label}</span>
      <input
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={FIELD_MONO}
      />
    </label>
  );
}

type AgentPick = AgentChoice | 'alpaca';

const AGENT_OPTIONS: DropdownOption<AgentPick>[] = [
  { value: 'toji', label: 'Toji', hint: 'subscription' },
  { value: 'yagami', label: 'Yagami', hint: 'your signed-in CLIs' },
  { value: 'alpaca', label: 'Alpaca', hint: 'under construction', disabled: true },
  { value: 'cerebras', label: 'Cerebras', hint: 'your own key' },
  { value: 'local', label: 'Custom endpoint', hint: 'URL + key' },
  { value: 'off', label: 'Off' }
];

/**
 * The model picker: every model every installed coding CLI reports, grouped by
 * harness. Options carry the QUALIFIED `provider:model` id — a bare model name is
 * routed to the default provider (Claude Code), so picking a Codex or Gemini model
 * by its plain name used to fail on every call.
 */
function ModelPicker({ value, catalog, loading, onChange }: { value: string; catalog: ModelCatalog | null; loading: boolean; onChange: (id: string) => void }) {
  const options: DropdownOption<string>[] = [{ value: '', label: 'Auto', hint: 'the default harness', group: 'Automatic' }];
  for (const model of catalog?.models ?? []) {
    options.push({
      value: model.id,
      label: model.label,
      ...(model.resolvedModel && model.resolvedModel !== model.model ? { hint: model.resolvedModel } : { hint: model.model }),
      group: model.providerLabel
    });
  }
  // A saved model whose harness is gone (or is still being probed) stays selectable,
  // so opening settings never silently rewrites the user's choice.
  if (value && !options.some((o) => o.value === value)) {
    options.push({ value, label: value, hint: loading ? 'checking…' : 'not available', group: 'Saved' });
  }
  return (
    <label className="block min-w-0 flex-1">
      <span className="mb-1 block text-[11px] text-neutral-400">Model</span>
      <Dropdown<string> value={value} options={options} onChange={onChange} placeholder={loading ? 'Loading models…' : 'Auto'} />
    </label>
  );
}

function AgentSettings({ onShowPlans }: { onShowPlans?: () => void }) {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [agent, setAgent] = useState<AgentChoice>('yagami');
  const [agentModel, setAgentModel] = useState('');
  const [agentThinking, setAgentThinking] = useState<ThinkingLevel>('default');
  // Cerebras — the model list comes from the account behind the key; the key itself is
  // held server-side (usually from CEREBRAS_API_KEY) and only ever arrives masked.
  const [cerebras, setCerebras] = useState<CerebrasModels | null>(null);
  const [cerebrasLoading, setCerebrasLoading] = useState(false);
  const [cerebrasModel, setCerebrasModel] = useState('');
  const [cerebrasKey, setCerebrasKey] = useState('');
  // Custom endpoint — the key arrives masked; typing a new value replaces it on save.
  const [localUrl, setLocalUrl] = useState('');
  const [localModel, setLocalModel] = useState('');
  const [localKey, setLocalKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [applyErr, setApplyErr] = useState('');

  const refresh = useCallback(async () => {
    const [settings, agents] = await Promise.all([getSettings(), getAgents()]);
    setAgent(settings.agent);
    setAgentModel(settings.agentModel ?? '');
    setAgentThinking(settings.agentThinking ?? 'default');
    setCerebrasModel(settings.cerebrasModel ?? '');
    setCerebrasKey(settings.cerebrasApiKey ?? '');
    setLocalUrl(settings.localUrl ?? '');
    setLocalModel(settings.localModel ?? '');
    setLocalKey(settings.localApiKey ?? '');
    setStatus(agents);
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  // Probing the harnesses spawns a process each, so it runs once on open (the server
  // caches the result) and again only when the user asks for a rescan.
  const loadModels = useCallback(async (rescan = false) => {
    setModelsLoading(true);
    try {
      setCatalog(await getAgentModels(rescan));
    } catch {
      setCatalog(null);
    } finally {
      setModelsLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const loadCerebras = useCallback(async (refresh = false) => {
    setCerebrasLoading(true);
    try {
      setCerebras(await getCerebrasModels(refresh));
    } catch {
      setCerebras(null);
    } finally {
      setCerebrasLoading(false);
    }
  }, []);
  // Only fetched once Cerebras is the selected backend — no reaching out to a hosted
  // API just because the settings page was opened.
  useEffect(() => {
    if (agent === 'cerebras') void loadCerebras();
  }, [agent, loadCerebras]);

  const apply = async (patch: Partial<UserSettings>) => {
    const next: Partial<UserSettings> = {
      agent,
      agentModel: agentModel.trim(),
      agentThinking,
      cerebrasModel: cerebrasModel.trim(),
      cerebrasApiKey: cerebrasKey,
      localUrl: localUrl.trim(),
      localModel: localModel.trim(),
      localApiKey: localKey,
      ...patch
    };
    if (next.agent !== undefined) setAgent(next.agent);
    if (next.agentModel !== undefined) setAgentModel(next.agentModel);
    if (next.agentThinking !== undefined) setAgentThinking(next.agentThinking);
    if (next.cerebrasModel !== undefined) setCerebrasModel(next.cerebrasModel);
    setSaving(true);
    setSaved(false);
    setApplyErr('');
    try {
      const settings = await saveSettings(next);
      // Reflect the server's masked keys so we never hold a plaintext key in state longer than needed.
      setLocalKey(settings.localApiKey ?? '');
      setCerebrasKey(settings.cerebrasApiKey ?? '');
      setStatus(await getAgents());
      // A new key means a different account, so its model list must be re-fetched.
      if (next.cerebrasApiKey !== undefined && next.agent === 'cerebras') await loadCerebras(true);
      setSaved(true);
    } catch (e) {
      setApplyErr(e instanceof Error ? e.message : 'Could not save agent settings.');
    } finally {
      setSaving(false);
    }
  };

  const saveButton = (
    <button type="button" onClick={() => void apply({})} disabled={saving} className={`${FIELD_BUTTON} self-end`}>
      Save
    </button>
  );

  const installed = status?.yagami.providers.filter((p) => p.installed) ?? [];

  return (
    <Section icon={<Cpu size={16} />} title="AI model">
      <p className="mb-3 text-[12.5px] text-neutral-500">
        Inference runs through yagami: the coding-agent CLIs you are already signed into on this machine, with nothing to
        configure and no API keys. Or point Toji at your own OpenAI-compatible endpoint.
      </p>
      <div className="space-y-2.5 rounded-xl border border-black/10 p-3 dark:border-white/10">
        <Dropdown<AgentPick>
          value={agent}
          options={AGENT_OPTIONS}
          onChange={(v) => {
            // 'alpaca' is a placeholder with no backend behind it; every real choice applies.
            if (v === 'alpaca') return;
            void apply({ agent: v });
            // Picking the subscription is the moment to show what it costs and what it
            // includes, rather than leaving a chosen plan that quietly does nothing.
            if (v === 'toji') onShowPlans?.();
          }}
        />
        {agent === 'toji' && status && (
          <div className="space-y-2 rounded-lg border border-black/10 p-3 text-[12.5px] dark:border-white/12">
            <p className="flex items-center gap-2 text-neutral-500">
              <StatusDot state={status.toji.active ? 'on' : 'off'} />
              {status.toji.active ? `Subscribed — ${status.toji.plan}` : (status.toji.reason ?? 'No subscription')}
            </p>
            <p className="text-neutral-500">
              {status.toji.fallback
                ? `Until then Toji runs ${status.toji.fallback}, so nothing stops working.`
                : 'No signed-in coding CLI to fall back on — pick another backend below, or install one.'}
            </p>
            <button type="button" onClick={() => onShowPlans?.()} className={FIELD_BUTTON_QUIET}>
              See plans
            </button>
          </div>
        )}
        {agent === 'yagami' && (
          <div className="space-y-2.5">
            {status && (
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-neutral-500">
                {installed.map((p) => (
                  <ProviderChip key={p.id} provider={p} />
                ))}
                {installed.length === 0 && <span className="inline-flex items-center gap-1.5 px-0.5"><StatusDot state="off" /> No coding CLIs detected</span>}
                <button
                  type="button"
                  onClick={() => void loadModels(true)}
                  disabled={modelsLoading}
                  className="inline-flex items-center gap-1 text-[11.5px] text-neutral-400 transition hover:text-neutral-600 disabled:opacity-50 dark:hover:text-neutral-200"
                >
                  <RefreshCw size={11} className={modelsLoading ? 'animate-spin' : ''} /> Rescan
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <ModelPicker value={agentModel} catalog={catalog} loading={modelsLoading} onChange={(v) => void apply({ agentModel: v })} />
              <label className="w-[140px] shrink-0">
                <span className="mb-1 block text-[11px] text-neutral-400">Thinking</span>
                <Dropdown<ThinkingLevel>
                  value={agentThinking}
                  options={THINKING}
                  disabled={status ? !status.yagami.supportsEffort : false}
                  onChange={(v) => void apply({ agentThinking: v })}
                />
              </label>
            </div>
            {status && !status.yagami.supportsEffort && (
              <p className="px-0.5 text-[11.5px] text-neutral-400">
                {status.yagami.modelProvider ?? 'This harness'} has no reasoning-effort control, so Thinking does not apply to this model.
              </p>
            )}
          </div>
        )}
        {agent === 'cerebras' && (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-0.5 text-[12px] text-neutral-500">
              <span className="inline-flex items-center gap-1.5">
                <StatusDot state={cerebras?.keySource === 'none' ? 'off' : 'on'} />
                {cerebras?.keySource === 'env' ? 'API key from .env.local' : cerebras?.keySource === 'settings' ? 'API key saved in settings' : 'No API key'}
              </span>
              <button
                type="button"
                onClick={() => void loadCerebras(true)}
                disabled={cerebrasLoading}
                className="inline-flex items-center gap-1 text-[11.5px] text-neutral-400 transition hover:text-neutral-600 disabled:opacity-50 dark:hover:text-neutral-200"
              >
                <RefreshCw size={11} className={cerebrasLoading ? 'animate-spin' : ''} /> Refresh models
              </button>
            </div>
            <div className="flex gap-2">
              <label className="block min-w-0 flex-1">
                <span className="mb-1 block text-[11px] text-neutral-400">Model</span>
                <Dropdown<string>
                  value={cerebrasModel}
                  options={
                    cerebras?.models.length
                      ? cerebras.models.map((m) => ({ value: m.id, label: m.label }))
                      : cerebrasModel
                        ? [{ value: cerebrasModel, label: cerebrasModel, hint: 'saved' }]
                        : []
                  }
                  placeholder={cerebrasLoading ? 'Loading models…' : cerebras?.error ? 'Unavailable' : 'Select a model'}
                  onChange={(v) => void apply({ cerebrasModel: v })}
                />
              </label>
              <ProviderField
                label={cerebras?.keySource === 'env' ? 'API key (overrides .env.local)' : 'API key'}
                value={cerebrasKey}
                onChange={setCerebrasKey}
                placeholder={cerebras?.keySource === 'env' ? 'using CEREBRAS_API_KEY' : 'csk-…'}
                secret
              />
              {saveButton}
            </div>
            {cerebras?.error && <p className="text-[11.5px] text-amber-600 dark:text-amber-400">{cerebras.error}</p>}
            <p className="text-[11.5px] text-neutral-400">
              Cerebras runs open models on their own inference hardware. Toji reads the key from CEREBRAS_API_KEY in your
              .env.local; a key entered here overrides it and is stored in Toji&rsquo;s local settings instead.
            </p>
          </div>
        )}
        {agent === 'local' && (
          <div className="space-y-2">
            <ProviderField label="Endpoint URL (OpenAI-compatible)" value={localUrl} onChange={setLocalUrl} placeholder="http://127.0.0.1:11434/v1" />
            <div className="flex gap-2">
              <ProviderField label="Model" value={localModel} onChange={setLocalModel} placeholder="llama3.2" />
              <ProviderField label="API key (optional)" value={localKey} onChange={setLocalKey} placeholder="none" secret />
              {saveButton}
            </div>
            <p className="text-[11.5px] text-neutral-400">
              Works with Ollama (`http://127.0.0.1:11434/v1`), LM Studio, vLLM, or anything OpenAI-compatible on your home server.
            </p>
          </div>
        )}
        <div className="flex items-center gap-2 text-[12px] text-neutral-500">
          {saving ? (
            <span className="inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Saving…</span>
          ) : agent === 'off' ? (
            <span className="inline-flex items-center gap-1.5"><StatusDot state="off" /> Demo mode — no model</span>
          ) : agent === 'yagami' && status?.yagami.unknownModel ? (
            // The saved model belongs to no installed harness — every call would fail,
            // so this must not read as "Ready".
            <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
              <StatusDot state="off" /> “{status.yagami.model}” is not offered by any installed CLI — pick another model
            </span>
          ) : status?.available ? (
            <span className="inline-flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
              <StatusDot state="on" />
              {saved && <Check size={12} />} Ready — {status.model}
            </span>
          ) : agent === 'local' ? (
            <span className="inline-flex items-center gap-1.5"><StatusDot state="off" /> Enter your endpoint URL and model, then Save</span>
          ) : agent === 'cerebras' ? (
            <span className="inline-flex items-center gap-1.5">
              <StatusDot state="off" />
              {status?.cerebras.keySource === 'none' ? 'Add a Cerebras API key to continue' : 'Pick a Cerebras model to continue'}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5"><StatusDot state="off" /> No coding CLI found — install and sign into one (e.g. Claude Code)</span>
          )}
        </div>
        {applyErr && <p className="text-[12px] text-red-500">{applyErr}</p>}
      </div>
    </Section>
  );
}


/** The default engine: Firefox's search service under the Gecko bridge, else Toji's own five. */
function SearchSettings() {
  return hasBrowserSettings() ? <BrowserSearchEngine /> : <LocalSearchEngine />;
}

function SearchSection({ note, children }: { note: string; children: React.ReactNode }) {
  return (
    <Section icon={<Search size={16} />} title="Search">
      <p className="mb-3 text-[12.5px] text-neutral-500">{note}</p>
      <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
        <label className="block">
          <span className="mb-1 block text-[11px] text-neutral-400">Default search engine</span>
          {children}
        </label>
      </div>
    </Section>
  );
}

function LocalSearchEngine() {
  const [engine, setEngine] = useState<SearchEngineId>(() => (localStorage.getItem('toji-search-engine') as SearchEngineId | null) ?? 'duckduckgo');
  const options: DropdownOption<SearchEngineId>[] = SEARCH_ENGINES.map((e) => ({ value: e.id, label: e.name }));
  return (
    <SearchSection note="The engine used when you search the web (the globe button or Shift+Enter).">
      <Dropdown<SearchEngineId>
        value={engine}
        options={options}
        onChange={(v) => {
          setEngine(v);
          localStorage.setItem('toji-search-engine', v);
        }}
      />
    </SearchSection>
  );
}

function BrowserSearchEngine() {
  const settings = useBrowserSettings();
  const options: DropdownOption<string>[] = (settings?.searchEngines ?? []).map((e) => ({ value: e.name, label: e.name }));
  // The current default stays selectable even if the browser left it out of the list.
  if (settings?.searchEngine && !options.some((o) => o.value === settings.searchEngine)) {
    options.unshift({ value: settings.searchEngine, label: settings.searchEngine });
  }
  return (
    <SearchSection note="The engine used when what you type is not an address, in the address bar and on the new tab page.">
      <Dropdown<string>
        value={settings?.searchEngine ?? ''}
        options={options}
        disabled={!settings}
        placeholder={settings ? 'Choose an engine' : 'Loading…'}
        onChange={(v) => void setBrowserSetting('searchEngine', v)}
      />
    </SearchSection>
  );
}

const THEME_OPTIONS: DropdownOption<BrowserSettings['theme']>[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
];

const LAYOUT_OPTIONS: DropdownOption<BrowserSettings['layout']>[] = [
  { value: 'top', label: 'Along the top' },
  { value: 'side', label: 'Down the side' }
];

/**
 * Theme and tab layout. The Electron app keeps these as toolbar buttons; in the Gecko
 * browser they are browser settings, so they live here.
 */
function AppearanceSettings() {
  const settings = useBrowserSettings();
  const row = 'flex items-center justify-between gap-4 py-2.5';
  return (
    <Section icon={<Palette size={16} />} title="Appearance">
      <div className="divide-y divide-black/[0.06] rounded-xl border border-black/10 px-3 dark:divide-white/[0.08] dark:border-white/10">
        <div className={row}>
          <div className="min-w-0">
            <div className="text-[13px]">Theme</div>
            <p className="text-[12px] text-neutral-500">Toji&rsquo;s pages and the browser around them.</p>
          </div>
          <Dropdown<BrowserSettings['theme']>
            value={settings?.theme ?? 'light'}
            options={THEME_OPTIONS}
            disabled={!settings}
            onChange={(v) => void setBrowserSetting('theme', v)}
            className="w-[170px] shrink-0"
          />
        </div>
        <div className={row}>
          <div className="min-w-0">
            <div className="text-[13px]">Tabs</div>
            <p className="text-[12px] text-neutral-500">{settings?.layout === 'side' ? 'Tabs run down the side of the window.' : 'Tabs sit in a strip above the page.'}</p>
          </div>
          <Dropdown<BrowserSettings['layout']>
            value={settings?.layout ?? 'top'}
            options={LAYOUT_OPTIONS}
            disabled={!settings}
            onChange={(v) => void setBrowserSetting('layout', v)}
            className="w-[170px] shrink-0"
          />
        </div>
      </div>
    </Section>
  );
}

/** What every page gets: ad blocking, and where the bookmarks bar sits. */
function BrowsingSettings() {
  // Ad blocking: the Electron app reports detailed status (adblockStatus); the Gecko
  // browser runs uBlock Origin and exposes only the on/off setting. The bookmarks bar is a
  // localStorage key in the Electron app and a browser setting under the bridge.
  const settings = useBrowserSettings();
  const viaBrowser = hasBrowserSettings();
  const detailed = Boolean(bridge().adblockStatus);
  const [adblock, setAdblock] = useState<AdblockStatus | null>(null);
  const [localPinned, setLocalPinned] = useState(() => (viaBrowser ? true : bookmarksBarPinned()));
  useEffect(() => {
    void bridge().adblockStatus?.().then(setAdblock).catch(() => {});
    if (viaBrowser) return;
    const sync = () => setLocalPinned(bookmarksBarPinned());
    window.addEventListener(BOOKMARKS_BAR_EVENT, sync);
    return () => window.removeEventListener(BOOKMARKS_BAR_EVENT, sync);
  }, [viaBrowser]);
  const setBlocking = async (enabled: boolean) => {
    if (!detailed) {
      await setBrowserSetting('adblock', enabled);
      return;
    }
    setAdblock((s) => (s ? { ...s, enabled } : s));
    const next = await bridge().setAdblock?.(enabled);
    if (next) setAdblock(next);
  };
  const blocking = detailed ? Boolean(adblock?.enabled) : Boolean(settings?.adblock);
  const canBlock = detailed ? Boolean(adblock) : viaBrowser && Boolean(settings);
  const blockingNote = detailed
    ? !adblock
      ? 'Checking…'
      : !adblock.enabled
        ? 'Off. Pages load exactly as the site sends them.'
        : adblock.ready
          ? `On, with the same lists uBlock Origin uses — on every site, video players included.${adblock.blocked > 0 ? ` ${adblock.blocked.toLocaleString()} blocked since launch.` : ''}`
          : 'On. Fetching the filter lists — blocking starts the moment they arrive.'
    : viaBrowser
      ? !settings
        ? 'Checking…'
        : settings.adblock
          ? 'On, with uBlock Origin — on every site, video players included.'
          : 'Off. Pages load exactly as the site sends them.'
      : notHere();
  const pinned = viaBrowser ? (settings?.bookmarksBar ?? 'pinned') === 'pinned' : localPinned;
  const setPinned = (next: boolean) => {
    if (viaBrowser) void setBrowserSetting('bookmarksBar', next ? 'pinned' : 'hover');
    else setBookmarksBarPinned(next);
  };
  const row = 'flex items-center justify-between gap-4 py-2.5';
  return (
    <Section icon={<Globe size={16} />} title="Browsing">
      <div className="divide-y divide-black/[0.06] rounded-xl border border-black/10 px-3 dark:divide-white/[0.08] dark:border-white/10">
        <div className={row}>
          <div className="min-w-0">
            <div className="text-[13px]">Block ads and trackers</div>
            <p className="text-[12px] text-neutral-500">{blockingNote}</p>
          </div>
          <Switch checked={blocking} disabled={!canBlock} onChange={(v) => void setBlocking(v)} label="Block ads and trackers" />
        </div>
        <div className={row}>
          <div className="min-w-0">
            <div className="text-[13px]">Always show the bookmarks bar</div>
            <p className="text-[12px] text-neutral-500">{pinned ? 'The bar sits under the address bar on every page.' : 'The bar slides in when the pointer rests under the address bar.'}</p>
          </div>
          <Switch checked={pinned} disabled={viaBrowser && !settings} onChange={setPinned} label="Always show the bookmarks bar" />
        </div>
      </div>
    </Section>
  );
}

/** The rolling recording, and where a report goes. */
function BugReportSettings({ onReportBug }: { onReportBug?: () => void }) {
  // The rolling recording is a browser setting under the Gecko bridge and a localStorage
  // key in the Electron app. Filing a report opens the Electron app's report sheet
  // (onReportBug), or under Gecko the browser's about:report page (openReport); where
  // neither is there the row says so instead of offering a dead button.
  const settings = useBrowserSettings();
  const viaBrowser = hasBrowserSettings();
  const toji = bridge();
  const geckoReport = viaBrowser && Boolean(toji.submitBugReport);
  // Under Gecko the switch only means something when the browser keeps a recording to
  // hand to the report page (replayClip); the Electron app records in this renderer.
  const showReplay = !viaBrowser || Boolean(toji.replayClip);
  const [localOn, setLocalOn] = useState(() => (viaBrowser ? false : replayEnabled()));
  const [account, setAccount] = useState<BugReportAccount | null>(null);
  const hasAccount = Boolean(bridge().bugReportAccount);
  useEffect(() => {
    void bridge()
      .bugReportAccount?.()
      .then(setAccount)
      .catch(() => {});
    if (viaBrowser) return;
    const sync = () => setLocalOn(replayEnabled());
    window.addEventListener(REPLAY_EVENT, sync);
    return () => window.removeEventListener(REPLAY_EVENT, sync);
  }, [viaBrowser]);
  const on = viaBrowser ? (settings?.replay ?? false) : localOn;
  const canRecord = viaBrowser ? Boolean(settings) : isElectron();
  const setOn = (next: boolean) => {
    if (viaBrowser) void setBrowserSetting('replay', next);
    else setReplayEnabled(next);
  };
  const canReport = geckoReport ? Boolean(toji.openReport) : isElectron() && Boolean(onReportBug);
  const report = geckoReport ? () => toji.openReport?.() : onReportBug;
  const shortcut = bridge().platform === 'darwin' ? '⌥⇧I' : 'Alt+Shift+I';
  const route = !hasAccount
    ? ''
    : !account
      ? 'Checking your GitHub login…'
      : account.mode === 'direct'
        ? `Filed straight to ${account.repo} as @${account.login}${account.source === 'gh' ? ', with the GitHub CLI’s login' : ''}.`
        : 'Finished on GitHub’s own issue form, in a new tab, with the files attached for you.';
  const row = 'flex items-center justify-between gap-4 py-2.5';
  return (
    <Section icon={<Bug size={16} />} title="Bug reports">
      <div className="divide-y divide-black/[0.06] rounded-xl border border-black/10 px-3 dark:divide-white/[0.08] dark:border-white/10">
        {showReplay && (
        <div className={row}>
          <div className="min-w-0">
            <div className="text-[13px]">Keep the last {REPLAY_SECONDS} seconds</div>
            <p className="text-[12px] text-neutral-500">
              {!canRecord
                ? viaBrowser
                  ? 'Checking…'
                  : notHere()
                : on
                  ? `Each window keeps a rolling ${REPLAY_SECONDS}-second recording of itself in memory, so a report can show what just happened. It is never saved, and only sent in a report you send. Private and Tor windows are not recorded.`
                  : 'Off, so the window costs nothing while you read. Reports can still be written, with screenshots; switch this on to attach a clip of what just happened.'}
            </p>
          </div>
          <Switch checked={on && canRecord} disabled={!canRecord} onChange={setOn} label={`Keep the last ${REPLAY_SECONDS} seconds`} />
        </div>
        )}
        <div className={row}>
          <div className="min-w-0">
            <div className="text-[13px]">Report a bug</div>
            <p className="text-[12px] text-neutral-500">
              {!canReport
                ? isElectron()
                  ? 'Reporting a bug from this page isn’t available in this version yet.'
                  : notHere()
                : geckoReport
                  ? route || 'Opens a page to write the report, with images of what you saw.'
                  : `${route ? `${route} ` : ''}Also in the Help menu, or ${shortcut}.`}
            </p>
          </div>
          {canReport && (
            <button type="button" className={FIELD_BUTTON_QUIET} onClick={report}>
              Report a bug…
            </button>
          )}
        </div>
      </div>
    </Section>
  );
}

function ReferenceDocs() {
  const [docs, setDocs] = useState<ReferenceDoc[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => void getReferences().then((r) => setDocs(r.references)).catch(() => {}), []);
  useEffect(() => refresh(), [refresh]);

  const upload = useCallback(
    async (fileList: FileList | File[]) => {
      setBusy(true);
      try {
        for (const file of Array.from(fileList)) {
          const dataBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
            reader.onerror = () => reject(new Error('read failed'));
            reader.readAsDataURL(file);
          });
          await addReference(file.name, file.type, dataBase64).catch(() => {});
        }
        refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-neutral-600 dark:text-neutral-300">
        <FileText size={14} /> Reference documents
      </div>
      <p className="mb-2 text-[12px] text-neutral-500">Drop files the agent should be able to pull up anytime — a resume, a cover letter, an ID — to read or upload into forms.</p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
        }}
        className={`rounded-xl border border-dashed p-3 transition ${dragOver ? 'border-neutral-900/40 bg-black/[0.02] dark:border-white/40 dark:bg-white/[0.03]' : 'border-black/15 dark:border-white/15'}`}
      >
        {docs.length === 0 ? (
          <p className="text-center text-[12px] text-neutral-400">{busy ? 'Uploading…' : 'Drop files here, or'} <label className="cursor-pointer underline"><input type="file" multiple className="hidden" onChange={(e) => e.target.files && void upload(e.target.files)} />browse</label></p>
        ) : (
          <div className="space-y-1.5">
            {docs.map((d) => (
              <div key={d.id} className="group flex items-center gap-2 rounded-lg bg-black/[0.03] px-2.5 py-1.5 dark:bg-white/[0.04]">
                <Paperclip size={13} className="shrink-0 text-neutral-400" />
                <span className="flex-1 truncate text-[12.5px]">{d.name}</span>
                <span className="shrink-0 text-[11px] text-neutral-400">{Math.max(1, Math.round(d.size / 1024))} KB</span>
                <button type="button" aria-label="Remove" onClick={() => void deleteReference(d.id).then(refresh)} className="shrink-0 text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:text-red-500">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <label className="inline-flex cursor-pointer items-center gap-1 text-[11.5px] text-neutral-500 hover:text-neutral-800 dark:hover:text-white">
              <input type="file" multiple className="hidden" onChange={(e) => e.target.files && void upload(e.target.files)} />
              <Plus size={12} /> Add more
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

function MemorySettings() {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [pinned, setPinned] = useState<PinnedMemory | null>(null);
  const [memDraft, setMemDraft] = useState('');
  const [userDraft, setUserDraft] = useState('');
  const [newFact, setNewFact] = useState('');
  const [pinErr, setPinErr] = useState('');
  const [savingPin, setSavingPin] = useState(false);

  const refresh = useCallback(async () => {
    const [f, p] = await Promise.all([getMemoryFacts(), getPinnedMemory()]);
    setFacts(f.facts);
    setPinned(p);
    setMemDraft(p.memory);
    setUserDraft(p.user);
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  const savePinned = async () => {
    setSavingPin(true);
    setPinErr('');
    try {
      const p = await savePinnedMemory({ memory: memDraft, user: userDraft });
      setPinned(p);
    } catch (e) {
      setPinErr(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSavingPin(false);
    }
  };

  const pinnedDirty = pinned ? memDraft !== pinned.memory || userDraft !== pinned.user : false;

  return (
    <Section icon={<Brain size={16} />} title="Memory">
      <p className="mb-3 text-[12.5px] text-neutral-500">What Toji remembers across sessions. A librarian surfaces only what's relevant to each task, so the agent stays focused.</p>

      <ReferenceDocs />

      <div className="space-y-3 rounded-xl border border-black/10 p-3 dark:border-white/10">
        <PinnedField label="Agent notes (MEMORY)" value={memDraft} cap={pinned?.caps.memory ?? 2200} onChange={setMemDraft} />
        <PinnedField label="About you (USER)" value={userDraft} cap={pinned?.caps.user ?? 1400} onChange={setUserDraft} />
        {pinErr && <p className="text-[12px] text-red-500">{pinErr}</p>}
        {pinnedDirty && (
          <button type="button" onClick={() => void savePinned()} disabled={savingPin} className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-1.5 text-[12.5px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900">
            {savingPin && <Loader2 size={12} className="animate-spin" />} Save
          </button>
        )}
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center gap-2">
          <input
            value={newFact}
            onChange={(e) => setNewFact(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newFact.trim()) {
                void addMemory(newFact.trim()).then(() => {
                  setNewFact('');
                  void refresh();
                });
              }
            }}
            placeholder="Add a memory the agent should keep…"
            className={`${FIELD} min-w-0 flex-1`}
          />
          <button type="button" disabled={!newFact.trim()} onClick={() => void addMemory(newFact.trim()).then(() => { setNewFact(''); void refresh(); })} className={FIELD_BUTTON_QUIET}>
            Add
          </button>
        </div>
        <div className="space-y-1.5">
          {facts.length === 0 && <p className="text-[12.5px] text-neutral-400">No memories yet. The agent adds these as it learns, or add your own above.</p>}
          {facts.map((f) => (
            <div key={f.id} className="group flex items-start gap-2 rounded-lg bg-black/[0.03] px-2.5 py-1.5 dark:bg-white/[0.04]">
              <span className="flex-1 text-[12.5px]">{f.text}</span>
              <button type="button" aria-label="Delete memory" onClick={() => void deleteMemoryFact(f.id).then(refresh)} className="shrink-0 text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:text-red-500">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function PinnedField({ label, value, cap, onChange }: { label: string; value: string; cap: number; onChange: (v: string) => void }) {
  const over = value.length > cap;
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[11.5px] text-neutral-400">
        <span>{label}</span>
        <span className={over ? 'text-red-500' : ''}>{value.length}/{cap}</span>
      </span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} className={`${FIELD_TEXTAREA} ${over ? 'border-red-400' : ''}`} />
    </label>
  );
}

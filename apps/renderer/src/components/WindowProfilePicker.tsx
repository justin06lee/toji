import { ArrowLeft, EyeOff, Plus, Route, Settings2, X } from 'lucide-react';
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CONTAINER_COLORS, PROFILE_AVATARS, containerId, type Container } from '../lib/containers';

interface WindowProfilePickerProps {
  containers: Container[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onContainersChange: (containers: Container[]) => void;
  onManage: () => void;
  onClose?: () => void;
}

export function ProfileAvatar({ container, size = 'md' }: { container: Container; size?: 'sm' | 'md' | 'lg' }) {
  const classes = size === 'sm' ? 'h-6 w-6 text-[13px]' : size === 'lg' ? 'h-[72px] w-[72px] text-2xl' : 'h-9 w-9 text-lg';
  const avatar = container.avatar ?? '';
  const isArtwork = avatar.includes('/');
  return (
    <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800 ${classes}`}>
      {isArtwork ? <img src={`${import.meta.env.BASE_URL}${avatar}`} alt="" className="h-full w-full object-cover" /> : avatar || container.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function WindowProfilePicker({ containers, currentId, onSelect, onContainersChange, onManage, onClose }: WindowProfilePickerProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string>(PROFILE_AVATARS[containers.length % PROFILE_AVATARS.length]);

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next: Container = {
      id: containerId(trimmed, containers),
      name: trimmed,
      avatar,
      color: CONTAINER_COLORS[containers.length % CONTAINER_COLORS.length],
      egress: 'direct',
      ephemeral: false
    };
    onContainersChange([...containers, next]);
    onSelect(next.id);
  };

  return (
    <main className="h-full w-full overflow-y-auto bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100" aria-labelledby="profile-picker-title">
      <div className="mx-auto flex min-h-full w-full max-w-[900px] flex-col justify-center px-8 py-16 sm:px-12">
        <div className="relative mb-8 text-center">
          {onClose && (
            <button type="button" onClick={onClose} className="absolute left-0 top-0 inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[12px] text-neutral-500 transition hover:bg-black/[0.04] hover:text-neutral-900 dark:hover:bg-white/[0.07] dark:hover:text-white">
              <ArrowLeft size={14} /> Back
            </button>
          )}
          <h1 id="profile-picker-title" className="text-[28px] font-semibold tracking-[-0.035em]">Who’s browsing?</h1>
          <p className="mt-2 text-[13px] text-neutral-500">Every tab in this window stays inside the profile you choose.</p>
        </div>

        {/* Cards are told apart by background alone — no outlines, no shadows. */}
        <div className="mx-auto grid w-full max-w-[640px] grid-cols-2 justify-items-center gap-3 sm:grid-cols-3">
          {containers.map((container) => (
            <button
              key={container.id}
              type="button"
              onClick={() => onSelect(container.id)}
              className={`group flex h-[150px] w-full max-w-[200px] flex-col items-center justify-center rounded-[22px] text-center transition ${
                currentId === container.id
                  ? 'bg-black/[0.06] dark:bg-white/[0.09]'
                  : 'bg-black/[0.025] hover:bg-black/[0.05] dark:bg-white/[0.035] dark:hover:bg-white/[0.07]'
              }`}
            >
              <ProfileAvatar container={container} size="lg" />
              <span className="mt-2.5 max-w-[130px] truncate text-[13px] font-medium">{container.name}</span>
              <span className="mt-0.5 inline-flex min-h-4 items-center gap-1 text-[10.5px] text-neutral-400">
                {container.ephemeral && <><EyeOff size={10} /> Private</>}
                {container.egress === 'tor' && <><Route size={10} /> Tor</>}
                {!container.ephemeral && container.egress === 'direct' && 'Standard'}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="group flex h-[150px] w-full max-w-[200px] flex-col items-center justify-center rounded-[22px] bg-black/[0.015] text-neutral-500 transition hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.05]"
          >
            <span className="inline-flex h-[72px] w-[72px] items-center justify-center rounded-full bg-black/[0.045] transition group-hover:bg-black/[0.07] dark:bg-white/[0.06] dark:group-hover:bg-white/[0.1]"><Plus size={22} /></span>
            <span className="mt-2.5 text-[13px] font-medium">Add profile</span>
            <span className="mt-0.5 text-[10.5px] text-neutral-400">New identity</span>
          </button>
        </div>

        {/* Expands in place; the vertically-centered grid glides upward as this grows. */}
        <AnimatePresence initial={false}>
          {creating && (
            <motion.div
              key="create"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto w-full max-w-[640px] overflow-hidden"
            >
              <section className="relative mt-6 rounded-[22px] bg-black/[0.025] p-5 dark:bg-white/[0.035]" aria-label="Create profile">
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setCreating(false)}
                  className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-full text-neutral-400 transition hover:bg-black/[0.06] hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
                >
                  <X size={14} />
                </button>
                <p className="mb-3 text-[12px] font-medium">Choose a picture</p>
                <div className="mb-5 flex flex-wrap gap-2.5">
                  {PROFILE_AVATARS.map((option) => (
                    <button key={option} type="button" onClick={() => setAvatar(option)} aria-label="Choose profile picture" className={`h-12 w-12 overflow-hidden rounded-full transition ${avatar === option ? 'ring-2 ring-neutral-900 ring-offset-2 ring-offset-white dark:ring-white dark:ring-offset-neutral-950' : 'opacity-60 hover:opacity-100'}`}>
                      <img src={`${import.meta.env.BASE_URL}${option}`} alt="" className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && create()} placeholder="Profile name" className="min-w-0 flex-1 rounded-xl bg-white px-3 py-2.5 text-[13px] outline-none transition dark:bg-neutral-900" />
                  <button type="button" onClick={create} disabled={!name.trim()} className="rounded-xl bg-neutral-900 px-5 text-[13px] font-medium text-white transition disabled:opacity-35 dark:bg-white dark:text-neutral-900">Create</button>
                </div>
              </section>
            </motion.div>
          )}
        </AnimatePresence>

        <button type="button" onClick={onManage} className="mx-auto mt-8 inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[12px] text-neutral-500 transition hover:bg-black/[0.04] hover:text-neutral-900 dark:hover:bg-white/[0.07] dark:hover:text-white">
        <Settings2 size={13} /> Manage profiles
        </button>
      </div>
    </main>
  );
}

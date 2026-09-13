import type { Container } from '../lib/containers';
import { publicAsset } from '../lib/publicAsset';

/** A container's picture: its artwork, a legacy emoji, or else its initial. */
export function ProfileAvatar({ container, size = 'md' }: { container: Pick<Container, 'avatar' | 'name'>; size?: 'sm' | 'md' | 'lg' }) {
  const classes = size === 'sm' ? 'h-6 w-6 text-[13px]' : size === 'lg' ? 'h-[72px] w-[72px] text-2xl' : 'h-9 w-9 text-lg';
  const avatar = container.avatar ?? '';
  const isArtwork = avatar.includes('/');
  return (
    <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800 ${classes}`}>
      {isArtwork ? <img src={publicAsset(avatar)} alt="" className="h-full w-full object-cover" /> : avatar || container.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

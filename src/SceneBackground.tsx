import { useEffect, useState } from 'react';
import type { StageLocation } from '../shared/stage';
import { SCENE_ARTWORK } from './scene-artwork';

export function SceneBackground({
  location,
  preloadLodge,
  onReadyChange,
  onStatusChange,
  attempt,
}: {
  location: StageLocation;
  preloadLodge: boolean;
  onReadyChange: (ready: boolean) => void;
  onStatusChange: (status: 'ready' | 'loading' | 'failed') => void;
  attempt: number;
}) {
  const [loaded, setLoaded] = useState({ cafe: false, lodge: false });
  const [failedAttempt, setFailedAttempt] = useState<number | null>(null);
  const showLodge = location === 'lodge' && loaded.lodge;
  const ready = showLodge || loaded.cafe;
  const status =
    location !== 'lodge' || loaded.lodge
      ? 'ready'
      : failedAttempt === attempt ? 'failed' : 'loading';
  useEffect(() => onReadyChange(ready), [ready, onReadyChange]);
  useEffect(() => onStatusChange(status), [status, onStatusChange]);
  return (
    <div className="scene-backdrop" data-location={showLodge ? 'lodge' : 'cafe'}>
        <img
          className="scene-illustration scene-illustration-cafe"
          src={SCENE_ARTWORK.cafe.src}
          alt={showLodge ? '' : SCENE_ARTWORK.cafe.description}
          aria-hidden={showLodge}
          width={SCENE_ARTWORK.cafe.width}
          height={SCENE_ARTWORK.cafe.height}
          onLoad={() => setLoaded((old) => ({ ...old, cafe: true }))}
          onError={() => setLoaded((old) => ({ ...old, cafe: false }))}
          fetchPriority="high"
        />
        {(preloadLodge || location === 'lodge') && (
          <img
            key={attempt}
            className={'scene-illustration scene-illustration-lodge' + (showLodge ? ' visible' : '')}
            src={SCENE_ARTWORK.lodge.src + (attempt ? '?retry=' + attempt : '')}
            alt={showLodge ? SCENE_ARTWORK.lodge.description : ''}
            aria-hidden={!showLodge}
            width={SCENE_ARTWORK.lodge.width}
            height={SCENE_ARTWORK.lodge.height}
            onLoad={() => {
              setFailedAttempt(null);
              setLoaded((old) => ({ ...old, lodge: true }));
            }}
            onError={() => {
              setFailedAttempt(attempt);
              setLoaded((old) => ({ ...old, lodge: false }));
            }}
            fetchPriority={location === 'lodge' ? 'high' : 'low'}
          />
        )}
        {loaded.cafe && (
          <div className={'illustration-rain' + (showLodge ? ' hidden' : '')} aria-hidden="true">
            <div className="rain" />
          </div>
        )}
    </div>
  );
}

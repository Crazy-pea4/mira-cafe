import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from './core/engine';
import { MIRA_ASSETS, MOODS } from './character-assets';
import { characterPose, POSE_LABELS } from './core/character-pose';
import { FacialAnimation, type FaceFrame } from './core/facial-animation';
export function Character({ state }: { state: Snapshot }) {
  const [failed, setFailed] = useState(false),
    [frames, setFrames] = useState<FaceFrame>({ blink: false, mouth: false });
  const [missing, setMissing] = useState<string[]>([]),
    [loaded, setLoaded] = useState<string[]>([]);
  const animation = useRef<FacialAnimation | null>(null);
  const requested = characterPose(state);
  const pose =
    requested !== 'idle' &&
    (!loaded.includes(MIRA_ASSETS.poses[requested]) ||
      missing.includes(MIRA_ASSETS.poses[requested]))
      ? 'idle'
      : requested;
  const faceEnabled = pose === 'idle';
  useEffect(() => {
    animation.current = new FacialAnimation(
      setFrames,
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    return () => {
      animation.current?.dispose();
      animation.current = null;
    };
  }, []);
  useEffect(() => {
    animation.current?.speaking(faceEnabled && state.status === 'speaking');
  }, [state.status, state.turnId, faceEnabled]);
  const expression = MIRA_ASSETS.emotions[state.emotion];
  const talking = faceEnabled && state.status === 'speaking' && frames.mouth;
  const layer = (src: string, className: string, visible = true) =>
    !missing.includes(src) && (
      <img
        key={src + className}
        className={`portrait-patch ${className} ${visible ? 'visible' : ''}`}
        src={src}
        width={1024}
        height={1536}
        alt=""
        draggable={false}
        onError={() => setMissing((old) => [...old, src])}
      />
    );
  return (
    <div
      className={`character character-portrait action-${state.action} status-${state.status}`}
      role="img"
      aria-label={`Mira，身穿琥珀色雨衣、戴银色星星发夹，${pose === 'idle' ? MOODS[state.emotion] : POSE_LABELS[pose]}`}
      data-emotion={state.emotion}
      data-pose={pose}
      data-blink={faceEnabled && frames.blink}
      data-mouth={talking}
      data-drive={state.presentation}
    >
      {failed ? (
        <div className="portrait-fallback">
          画面暂时没加载出来
          <br />
          <small>你仍可以和 Mira 聊天</small>
        </div>
      ) : (
        <div className="portrait-canvas">
          <div className={`portrait-base ${faceEnabled ? 'visible' : ''}`}>
            <img
              className="portrait-image"
              src={MIRA_ASSETS.neutral}
              width={1024}
              height={1536}
              alt=""
              draggable={false}
              fetchPriority="high"
              onError={() => setFailed(true)}
            />
            {faceEnabled &&
              expression &&
              layer(expression, `expression-patch expression-${state.emotion}`)}
            {faceEnabled && layer(MIRA_ASSETS.blink, 'blink-patch', frames.blink)}
            {faceEnabled && layer(MIRA_ASSETS.talk, 'mouth-patch', talking)}
          </div>
          {Object.entries(MIRA_ASSETS.poses).map(([name, src]) => (
            <img
              key={src}
              className={`portrait-pose ${pose === name ? 'visible' : ''}`}
              src={src}
              width={1024}
              height={1536}
              alt=""
              draggable={false}
              onLoad={() => setLoaded((old) => (old.includes(src) ? old : [...old, src]))}
              onError={() => setMissing((old) => (old.includes(src) ? old : [...old, src]))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

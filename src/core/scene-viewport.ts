// Keep controls inside the visual viewport when a mobile keyboard reduces it.
// This only measures layout; it never focuses inputs or starts media.
type ViewportSource = Pick<
  VisualViewport,
  'height' | 'offsetTop' | 'addEventListener' | 'removeEventListener'
>;
type SceneWindow = Pick<Window, 'innerHeight' | 'addEventListener' | 'removeEventListener'> & {
  visualViewport: ViewportSource | null;
};
export function bindSceneViewport(
  target: SceneWindow,
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>,
) {
  const viewport = target.visualViewport;
  const update = () => {
    const height = viewport?.height ?? target.innerHeight;
    style.setProperty('--scene-height', `${Math.max(1, height)}px`);
    style.setProperty('--scene-top', `${Math.max(0, viewport?.offsetTop ?? 0)}px`);
  };
  target.addEventListener('resize', update);
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  update();
  return () => {
    target.removeEventListener('resize', update);
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    for (const name of ['--scene-height', '--scene-top']) style.removeProperty(name);
  };
}

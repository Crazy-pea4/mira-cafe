export function ModeBadge({ provider }: { provider: string | null }) {
  return provider === 'mock' ? (
    <span className="mode-chip">
      <i />
      演示模式
    </span>
  ) : null;
}

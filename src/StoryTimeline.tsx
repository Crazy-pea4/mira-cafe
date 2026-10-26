import type { StoryView } from '../shared/story';

export function StoryTimeline({ story }: { story?: StoryView }) {
  const facts = new Set(story?.facts ?? []);
  const current =
    story?.ending || facts.has('draft')
      ? 3
      : facts.has('commission')
        ? 2
        : facts.has('photo-drift')
          ? 1
          : 0;
  const titles = [
    '雨夜相遇',
    facts.has('phone-message') ? '旅馆来信' : '一张照片',
    '她的心事',
    story?.ending ? 'Mira 的决定' : '未发的回信',
  ];
  const details = [
    '从一杯咖啡开始',
    facts.has('phone-message') ? '她还没有回复' : '风吹来了一个话题',
    facts.has('fear') ? '听她说出顾虑' : '慢慢了解她的故事',
    story?.ending ? '雨好像小了' : '决定留给她自己',
  ];
  return (
    <aside className="story-timeline" aria-label="故事进度">
      <div className="timeline-heading">
        <span>这一夜</span>
        <span>
          {String(current + 1).padStart(2, '0')} <i>/ 04</i>
        </span>
      </div>
      <ol>
        {titles.map((title, index) => (
          <li
            key={index}
            className={index < current ? 'past' : index === current ? 'current' : 'upcoming'}
            aria-current={index === current ? 'step' : undefined}
          >
            <span className="timeline-dot" aria-hidden="true">
              {index < current ? '✓' : ''}
            </span>
            <div>
              <span className="timeline-title">{index <= current ? title : '尚未展开'}</span>
              {index === current && <p>{details[current]}</p>}
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}

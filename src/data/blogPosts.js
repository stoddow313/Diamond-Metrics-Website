export const blogPosts = [
  {
    slug: 'baseball-metrics-ages-13-18',
    category: 'Player Development',
    title: 'What Baseball Metrics Matter Most for Players Ages 13–18?',
    excerpt:
      'A development-first guide to the baseball metrics that help players ages 13–18 build a stronger record of progress.',
    readTime: '8 min read',
    publishedAt: '2026-08-26',
    seoTitle: 'Baseball Metrics for Players Ages 13–18 | Diamond Metrics',
    seoDescription:
      'Learn which baseball metrics matter most for players ages 13–18, from game context and repeatable skills to verified velocity and recruiting-ready records.',
  },
  {
    slug: 'how-to-record-baseball-game-video-analysis',
    category: 'Film Better',
    title: 'How to Record a Baseball Game for Video Analysis',
    excerpt:
      'A parent-friendly guide to camera position, phone settings, frame rate, and the footage that helps turn a game recording into useful player insight.',
    readTime: '7 min read',
    publishedAt: '2026-08-05',
    seoTitle: 'How to Record a Baseball Game for Analysis | Diamond Metrics',
    seoDescription:
      'Learn the best camera angle, phone settings, frame rate, and filming tips to capture baseball game video that can support meaningful player analysis.',
  },
  {
    slug: 'why-youth-baseball-video-analysis-matters',
    category: 'Player Development',
    title: 'Why Youth Baseball Video Analysis Matters',
    excerpt:
      'How stable game footage gives players, parents, and coaches a clearer view of development, without pretending a phone camera is professional tracking.',
    readTime: '7 min read',
    publishedAt: '2026-08-13',
    seoTitle: 'Why Youth Baseball Video Analysis Matters | Diamond Metrics',
    seoDescription:
      'Learn how youth baseball video analysis turns game footage into practical development insights for players, parents, coaches, and programs.',
  },
];

export function getBlogPost(slug) {
  return blogPosts.find((post) => post.slug === slug);
}

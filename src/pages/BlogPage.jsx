import { ArrowRight, BarChart3, Camera, Clock3, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import MarketingLayout from '../components/MarketingLayout';
import { blogPosts } from '../data/blogPosts';

export default function BlogPage() {
  const posts = [...blogPosts].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  return (
    <MarketingLayout>
      <section className="playbook-hero">
        <div className="playbook-hero-copy">
          <p className="eyebrow">Diamond Metrics Playbook</p>
          <h1>Better information for the moments that matter.</h1>
          <p>Practical guides for players, parents, and coaches who want to get more from baseball video and player development data.</p>
        </div>
        <div className="playbook-visual" aria-hidden="true">
          <div className="playbook-visual-grid" />
          <div className="playbook-center"><span>DM</span><strong>PLAYBOOK</strong></div>
          <div className="playbook-node playbook-node-video"><Camera size={21} /><span>Capture</span></div>
          <div className="playbook-node playbook-node-data"><BarChart3 size={21} /><span>Understand</span></div>
          <div className="playbook-node playbook-node-growth"><TrendingUp size={21} /><span>Develop</span></div>
        </div>
      </section>

      <section className="blog-index" aria-label="Diamond Metrics articles">
        <div className="blog-index-heading">
          <div><p className="eyebrow">Latest Articles</p><h2>Guides for better development.</h2></div>
          <Camera size={28} aria-hidden="true" />
        </div>
        <div className="blog-card-grid">
          {posts.map((post) => (
            <article className="blog-card" key={post.slug}>
              <span>{post.category}</span>
              <h3>{post.title}</h3>
              <p>{post.excerpt}</p>
              <div className="blog-card-footer">
                <small><Clock3 size={15} aria-hidden="true" /> {post.readTime}</small>
                <Link to={`/blog/${post.slug}`}>Read the article <ArrowRight size={16} aria-hidden="true" /></Link>
              </div>
            </article>
          ))}
        </div>
      </section>
    </MarketingLayout>
  );
}

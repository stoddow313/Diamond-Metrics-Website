import { ArrowRight, Camera, Clock3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import MarketingLayout from '../components/MarketingLayout';
import { blogPosts } from '../data/blogPosts';

export default function BlogPage() {
  return <MarketingLayout><section className="blog-hero"><p className="eyebrow">Diamond Metrics Playbook</p><h1>Better information for the moments that matter.</h1><p>Practical guides for players, parents, and coaches who want to get more from baseball video and player development data.</p></section><section className="blog-index" aria-label="Diamond Metrics articles"><div className="blog-index-heading"><div><p className="eyebrow">Latest Guide</p><h2>Start with better footage.</h2></div><Camera size={28} aria-hidden="true" /></div><div className="blog-card-grid">{blogPosts.map((post) => <article className="blog-card" key={post.slug}><span>{post.category}</span><h3>{post.title}</h3><p>{post.excerpt}</p><div className="blog-card-footer"><small><Clock3 size={15} aria-hidden="true" /> {post.readTime}</small><Link to={`/blog/${post.slug}`}>Read the guide <ArrowRight size={16} aria-hidden="true" /></Link></div></article>)}</div></section></MarketingLayout>;
}

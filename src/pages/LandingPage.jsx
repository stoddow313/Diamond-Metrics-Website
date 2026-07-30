import MarketingLayout from "../components/MarketingLayout";
import Hero from "../components/Hero";
import ProductPreview from "../components/ProductPreview";
import ProcessRail from "../components/ProcessRail";
import MarketingCta from "../components/MarketingCta";
import { Link } from "react-router-dom";

export default function LandingPage() {
  return (
    <MarketingLayout>
      <Hero />
      <ProductPreview />
      <ProcessRail />
      <section className="split-feature">
        <div>
          <p className="eyebrow">See What Your Footage Becomes</p>
          <h2>A clear record of performance and progress.</h2>
          <p className="section-text">Explore a sample player profile featuring performance metrics, key plays, development trends, and a clear record of progress.</p>
          <p className="feature-proof">Advanced player insight—without specialized equipment or an elite-program budget.</p>
          <Link className="primary-button" to="/sample-profile">Explore the Sample Profile</Link>
        </div>
        <img src="/images/marketing/joe-larsen-preview.webp" alt="Joe Larsen sample Diamond Metrics player" loading="lazy" />
      </section>
      <MarketingCta />
    </MarketingLayout>
  );
}

import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import Navbar from "../components/Navbar";
import Hero from "../components/Hero";
import UseCases from "../components/UseCases";
import AccessibleCapture from "../components/AccessibleCapture";
import ProDay from "../components/ProDay";
import ProgramOptions from "../components/ProgramOptions";
import MetricsPreview from "../components/MetricsPreview";
import DashboardPreview from "../components/DashboardPreview";
import VisualInsights from "../components/VisualInsights";
import Services from "../components/Services";
import Metrics from "../components/Metrics";
import Process from "../components/Process";
import WhoWeServe from "../components/WhoWeServe";
import Benefits from "../components/Benefits";
import Credibility from "../components/Credibility";
import Contact from "../components/Contact";
import Footer from "../components/Footer";

export default function LandingPage() {
  const { hash } = useLocation();

  // React Router doesn't scroll to #anchors on client-side navigation
  // (e.g. the signup page's "Contact us" → /#contact), so do it ourselves.
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash]);

  return (
    <div className="container">
      <Navbar />
      <main>
        <Hero />
        <UseCases />
        <AccessibleCapture />
        <ProDay />
        <ProgramOptions />
        <MetricsPreview />
        <DashboardPreview />
        <VisualInsights />
        <Services />
        <Metrics />
        <Process />
        <WhoWeServe />
        <Benefits />
        <Credibility />
        <Contact />
      </main>
      <Footer />
    </div>
  );
}

import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import UseCases from "./components/UseCases";
import AccessibleCapture from "./components/AccessibleCapture";
import ProDay from "./components/ProDay";
import ProgramOptions from "./components/ProgramOptions";
import MetricsPreview from "./components/MetricsPreview";
import DashboardPreview from "./components/DashboardPreview";
import VisualInsights from "./components/VisualInsights";
import Services from "./components/Services";
import Metrics from "./components/Metrics";
import Process from "./components/Process";
import WhoWeServe from "./components/WhoWeServe";
import Benefits from "./components/Benefits";
import Credibility from "./components/Credibility";
import Contact from "./components/Contact";
import Footer from "./components/Footer";

function App() {
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

export default App;


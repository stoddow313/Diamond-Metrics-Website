import Navbar from './components/Navbar'
import Hero from './components/Hero'
import Services from './components/Services'
import Metrics from './components/Metrics'
import Process from './components/Process'
import Credibility from './components/Credibility'
import Contact from './components/Contact'
import Footer from './components/Footer'

function App() {
  return (
    <div className="container">
      <Navbar />
      <main>
        <Hero />
        <Services />
        <Metrics />
        <Process />
        <Credibility />
        <Contact />
      </main>
      <Footer />
    </div>
  )
}

export default App

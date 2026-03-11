import { useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import './App.css'

import Navbar from './components/Navbar'
import Hero from './components/Hero'
import Services from './components/Services'
import Metrics from './components/Metrics'
import Process from './components/Process'
import Contact from './components/Contact'

function App() {
  return (
    <div className="container">
      <Navbar />
      <main>
        <Hero />
        <Services />
        <Metrics />
        <Process />
        <Contact />
      </main>
    </div>
  )
}

export default App


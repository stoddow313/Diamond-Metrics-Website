import { Camera, Check, Upload, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createElement, useEffect, useRef, useState } from 'react';

const steps = [
  { number: '01', title: 'Record.', icon: Camera, text: 'Capture your player during a game using a phone or available camera. No specialized equipment. No complicated setup.' },
  { number: '02', title: 'Submit.', icon: Upload, text: 'Upload your footage and identify the player you want analyzed. We organize the relevant plays and performance data.' },
  { number: '03', title: 'Track.', icon: TrendingUp, text: 'Receive video-backed analytics that help you follow progress, recognize patterns, and understand what to work on next.' },
];

function ProcessVisual({ active }) {
  const step = steps[active];
  const Icon = step.icon;

  return (
    <div className={`process-visual process-visual--${active + 1}`} aria-live="polite">
      <div className="process-visual-top">
        <span>Step {step.number}</span>
        <div className="process-progress" aria-hidden="true">
          {steps.map((item, index) => <i className={index <= active ? 'active' : ''} key={item.number} />)}
        </div>
      </div>
      <div className="process-visual-scene" aria-hidden="true">
        {active === 0 && (
          <div className="capture-scene">
            <div className="capture-frame"><span /><span /><span /><span /></div>
            <div className="record-light" />
          </div>
        )}
        {active === 1 && (
          <div className="upload-scene">
            <Upload size={56} />
            <div className="upload-bar"><span /></div>
            <div className="upload-file"><Check size={16} /> Game footage ready</div>
          </div>
        )}
        {active === 2 && (
          <div className="track-scene">
            <div><strong>92.4</strong><span>Exit Velo</span></div>
            <div><strong>6.89</strong><span>60-Yard</span></div>
            <div><strong>84</strong><span>Overall</span></div>
            <TrendingUp size={48} />
          </div>
        )}
      </div>
      <div className="process-visual-caption">
        <Icon size={24} aria-hidden="true" />
        <div><strong>{step.title}</strong><span>{step.text}</span></div>
      </div>
    </div>
  );
}

export default function ProcessRail({ compact = false }) {
  const [active, setActive] = useState(0);
  const stepRefs = useRef([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(Number(visible.target.dataset.step));
      },
      { rootMargin: '-28% 0px -38% 0px', threshold: [0.15, 0.35, 0.6] },
    );
    stepRefs.current.forEach(node => node && observer.observe(node));
    return () => observer.disconnect();
  }, []);

  return (
    <section className="process-rail-section" aria-labelledby="process-rail-title">
      <p className="eyebrow">How It Works</p>
      <h2 id="process-rail-title">Record. Submit. Track.</h2>
      <div className="scroll-process">
        <div className="process-sticky"><ProcessVisual active={active} /></div>
        <div className="process-scroll-steps">
          {steps.map(({ number, title, icon: Icon, text }, index) => (
            <article
              className={`process-scroll-step${active === index ? ' active' : ''}`}
              data-step={index}
              key={number}
              ref={node => { stepRefs.current[index] = node; }}
            >
              <div><span>{number}</span>{createElement(Icon, { size: 24, 'aria-hidden': true })}</div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </div>
      <div className="kinetic-rail process-mobile-rail" tabIndex="0" aria-label="Diamond Metrics analysis steps">
        {steps.map(({ number, title, icon: Icon, text }) => (
          <article className="kinetic-card" key={number}>
            <div className="kinetic-card-top">
              <span>{number}</span>{createElement(Icon, { size: 26, 'aria-hidden': true })}
            </div>
            <h3>{title}</h3>
            <p>{text}</p>
          </article>
        ))}
      </div>
      {!compact && <Link className="secondary-button rail-cta" to="/how-it-works">See How It Works</Link>}
    </section>
  );
}

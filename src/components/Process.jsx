function Process() {
  return (
    <section id="process">
      <p className="eyebrow">How It Works</p>
      <h2>A simple workflow for coaches and programs.</h2>
      <p className="section-text">
        Diamond Metrics is designed to fit real evaluation and development workflows,
        from capture to reporting.
      </p>

      <div className="process-flow">
        <div className="process-step">
          <div className="process-number">1</div>
          <h3>Capture</h3>
          <p>Record tryouts, evaluations, or performance sessions.</p>
        </div>

        <div className="process-arrow">→</div>

        <div className="process-step">
          <div className="process-number">2</div>
          <h3>Tag</h3>
          <p>Organize key events and measurable outputs into a structured workflow.</p>
        </div>

        <div className="process-arrow">→</div>

        <div className="process-step">
          <div className="process-number">3</div>
          <h3>Analyze</h3>
          <p>Turn raw data into reports, rankings, and evaluation insights.</p>
        </div>

        <div className="process-arrow">→</div>

        <div className="process-step">
          <div className="process-number">4</div>
          <h3>Report</h3>
          <p>Deliver coach-friendly summaries for decisions and development.</p>
        </div>
      </div>
    </section>
  );
}

export default Process;

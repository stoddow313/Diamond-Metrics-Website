import { useEffect } from 'react';
import { Check, ChevronRight, Video } from 'lucide-react';
import { Link } from 'react-router-dom';
import MarketingLayout from '../components/MarketingLayout';
import { getBlogPost } from '../data/blogPosts';
import gameActionHero from '../assets/blog/baseball-metrics-game-action.png';
import metricFramework from '../assets/blog/baseball-metrics-framework.svg';
import scoutContext from '../assets/blog/baseball-metrics-scout-context.png';

const firstMetrics = [
  'Game context and repeatable tendencies',
  'Timing and movement patterns',
  'Verified performance measurements when the capture supports them',
];

const faqs = [
  [
    'Do 13-year-olds need advanced baseball metrics?',
    'Not necessarily. At this stage, a reliable record of game context, repeatable skills, and progress is usually more useful than chasing a single advanced number.',
  ],
  [
    'Are velocity and exit velocity the most important metrics?',
    'They can be useful when they are measured well, but they are only part of the player record. Game performance, decision-making, consistency, and development over time matter too.',
  ],
  [
    'What baseball metrics can game video capture?',
    'Stable game video can support at-bats, pitch results, contact direction, count context, selected timing observations, defensive opportunities, and baserunning context. Precise velocity, spin, and ball-flight measurements need radar, calibrated tracking, or a stronger capture setup.',
  ],
  [
    'Can baseball metrics and video help with college recruiting?',
    'An organized record of verified metrics and game video can help communicate a player\'s development. It does not replace game performance, academics, outreach, program fit, or the recruiting process itself.',
  ],
];

export default function BaseballMetricsAges1318Page() {
  const post = getBlogPost('baseball-metrics-ages-13-18');

  useEffect(() => {
    document.title = post.seoTitle;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'description';
      document.head.appendChild(meta);
    }
    meta.content = post.seoDescription;
  }, [post]);

  return (
    <MarketingLayout>
      <article className="article-shell">
        <header className="article-hero">
          <Link className="article-back" to="/blog">
            <ChevronRight size={15} aria-hidden="true" /> Diamond Metrics Playbook
          </Link>
          <p className="eyebrow">Player Development</p>
          <h1>What Baseball Metrics Matter Most for Players Ages 13–18?</h1>
          <p className="article-dek">
            A development-first guide to choosing useful baseball metrics—and putting them in the right context.
          </p>
        </header>

        <div className="article-content">
          <p className="article-lead">
            At 13, a player is still building a foundation. At 18, that player may be preparing to show college coaches how they have developed over time. The right baseball metrics can support both stages—but only when they are part of a fuller player record, not a verdict on an athlete.
          </p>

          <figure className="article-visual">
            <img
              src={gameActionHero}
              alt="Teen baseball player making contact during a game"
            />
            <figcaption>
              A full-game view helps place every number in its proper context: the player, the play, and the situation.
            </figcaption>
          </figure>

          <p>
            For parents, players, and coaches, the question is not simply “What number should we chase?” It is “What information will help this player make a better next decision?”
          </p>

          <section>
            <h2>Start with a player record, not a highlight number</h2>
            <p>
              A radar reading, hard-hit ball, or home-to-first time can be useful. None tells the whole story on its own. A strong player record combines game context, repeatable skills, and performance measurements captured with the right setup.
            </p>
            <p>
              Begin with the basic game record: plate appearances, pitch outcomes, defensive opportunities, and the count, runners, and situations surrounding each play. Over time, that record can reveal tendencies a highlight clip cannot.
            </p>
            <p>
              As capture quality improves, the record can add radar-verified pitch and exit velocity, launch-angle measurements from calibrated tracking or high-quality video, and selected timing measurements. Those tools add context; they do not replace the game record.
            </p>
          </section>

          <section>
            <h2>Why ages 13–18 deserve a different approach</h2>
            <p>
              Development, role, competition, and goals can change quickly in these years. A 13U or 14U player is often building movement patterns, confidence, and game awareness. A high school player may be working toward a more complete record for coaches, programs, or recruiting conversations.
            </p>
            <p>
              The purpose of baseball metrics is not to create recruiting pressure or chase one showcase number. It is to make improvement easier to see, discuss, and act on.
            </p>
          </section>

          <section>
            <h2>Which baseball metrics should players ages 13–18 measure first?</h2>

            <h3>1. Game context and repeatable tendencies</h3>
            <p>
              Start with the information that helps a player understand what is happening in real competition.
            </p>
            <ul className="article-settings">
              <li><strong>Hitters.</strong> At-bats, contact results, swing-and-miss tendencies, batted-ball direction, and the count in which those results occurred.</li>
              <li><strong>Pitchers.</strong> Pitch results, strike percentage, first-pitch strikes, called strikes, whiffs, and pitch sequence.</li>
              <li><strong>Fielders and runners.</strong> Opportunities, decisions, routes, advancement, and throwing outcomes.</li>
            </ul>
            <p>
              These are not “small” metrics. They help turn video into a player-development conversation instead of a replay of the final score.
            </p>

            <h3>2. Timing and movement patterns</h3>
            <p>
              Home-to-first time, steal time, time-to-home, and release-to-catch can be useful when they are defined consistently. A clear start and finish, a full action in frame, and the same method from one session to the next matter more than treating a single attempt as a verdict.
            </p>
            <p>
              A series of comparable observations is usually more useful than one isolated time.
            </p>

            <h3>3. Verified performance measurements</h3>
            <p>
              Pitch velocity and exit velocity are best captured with radar or a calibrated tracking setup. Launch angle and video-based estimates are more sensitive to camera position, image quality, and frame rate. A high-frame-rate side view can support a stronger estimate; ordinary 30 fps footage should not be presented as a precision measurement.
            </p>
            <p>
              Lower-frame-rate game video is still valuable for game analysis. The key is to label the confidence of a measurement honestly and use the right tool for the question.
            </p>
          </section>

          <figure className="article-visual">
            <img
              src={metricFramework}
              alt="Diagram showing game context and repeatable skills leading to verified measurements"
            />
            <figcaption>
              A useful player record builds from game context and repeatable skills, then adds stronger verified measurements when the setup supports them.
            </figcaption>
          </figure>

          <section>
            <h2>Baseball metrics for ages 13–15: build a reliable baseline</h2>
            <p>
              For younger teenagers, the best record is usually simple and repeatable. Focus on full-game footage, plate appearances, pitch results, defensive opportunities, and a consistent way to review what happened.
            </p>
            <p>
              This gives players and families a baseline for improvement without pretending that one tournament, one radar reading, or one video clip defines the athlete.
            </p>
          </section>

          <section>
            <h2>High school baseball metrics for ages 16–18: deepen the record</h2>
            <p>
              As players move into high school, their record can become more organized and more specific. Compare similar game situations, use radar for velocity when it matters, and keep game video available alongside the numbers.
            </p>
            <p>
              That combination can support more informed conversations with coaches and programs. It is not a recruiting guarantee; it is a clearer record of the work a player has done and the progress they can show.
            </p>
          </section>

          <figure className="article-visual">
            <img
              src={scoutContext}
              alt="Baseball coach reviewing a player's game video and metrics"
            />
            <figcaption>
              An organized record can support more informed conversations about development and fit. It does not guarantee recruiting outcomes.
            </figcaption>
          </figure>

          <section className="article-limits">
            <h2>What not to chase</h2>
            <p>
              Avoid treating a single number as a player identity. A velocity reading without context, an exit velocity from an unclear setup, or a short highlight clip without the surrounding game can create more noise than insight.
            </p>
            <ul>
              <li>Do not compare players across different capture methods as if the numbers are automatically equivalent.</li>
              <li>Do not use one game to make a broad conclusion about a player.</li>
              <li>Do not present video estimates as radar-verified results.</li>
              <li>Do not let recruiting pressure replace player development.</li>
            </ul>
          </section>

          <section>
            <h2>Diamond Metrics helps make development visible</h2>
            <p>
              Professional and college baseball have made video and performance information a regular part of review and development. Youth and high school players do not need professional tracking systems to benefit from the same basic habit: record the game, organize what happened, and use the patterns to guide the next step.
            </p>
            <p>
              Diamond Metrics turns game footage into organized, video-backed analytics for players, families, coaches, and programs. The goal is a clearer development record—useful on the field now and easier to explain as a player grows.
            </p>
          </section>

          <section className="article-quick-answer">
            <p className="eyebrow">A practical next step</p>
            <h2>Build the record one game at a time.</h2>
            <p>
              Start with stable, complete game video. Keep the original files, capture the context around each play, and add stronger measurement tools when the question calls for them.
            </p>
            <div className="article-actions">
              <Link className="button button-primary" to="/signup">
                Analyze Your Player <ChevronRight size={17} aria-hidden="true" />
              </Link>
              <Link className="button button-secondary" to="/programs">
                <Video size={17} aria-hidden="true" /> Explore Team Analysis
              </Link>
            </div>
          </section>

          <section className="article-faq">
            <p className="eyebrow">FAQ</p>
            <h2>Baseball metrics for teenage players: common questions</h2>
            {faqs.map(([question, answer]) => (
              <div key={question} className="article-faq-item">
                <h3>{question}</h3>
                <p>{answer}</p>
              </div>
            ))}
          </section>

          <section>
            <h2>What comes next</h2>
            <p>
              This is the broad view. Future Playbook guides will go deeper into what matters most for players ages 13–15 and ages 16–18, including how to build a useful player record without losing sight of the game itself.
            </p>
          </section>
        </div>
      </article>
    </MarketingLayout>
  );
}

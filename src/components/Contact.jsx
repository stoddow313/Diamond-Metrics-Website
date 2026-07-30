import { useForm, ValidationError } from "@formspree/react";
import { useSearchParams } from "react-router-dom";

function Contact() {
  const [state, handleSubmit] = useForm("xgonkqrq");
  const [searchParams] = useSearchParams();
  const inquiry = searchParams.get("inquiry") || "";

  if (state.succeeded) {
    return (
      <section id="contact" className="contact-section" aria-labelledby="contact-success-title">
        <p className="eyebrow">Message Sent</p>
        <h2 id="contact-success-title">Thanks for reaching out.</h2>
        <p className="section-text">
          We received your message and will follow up shortly.
        </p>
      </section>
    );
  }

  return (
    <section id="contact" className="contact-section" aria-labelledby="contact-title">
      <p className="eyebrow">Let’s Get Started</p>
      <h2 id="contact-title">Ready to see what your performance can say?</h2>
      <p className="section-text">
        Tell us whether you’re a player, parent, coach, or program, and we’ll
        help identify the right next step.
      </p>

      <div className="contact-layout">
        <div className="contact-card">
          <h3>Start the Conversation</h3>
          <p>
            Reach out about player profiles, Pro Days, tryout evaluations,
            season-long packages, or other analytics support.
          </p>

          <div className="contact-details">
            <p>
              <strong>General inquiries:</strong>{" "}
              <a href="mailto:info@diamondmetrics.ai">
                info@diamondmetrics.ai
              </a>
            </p>
            <p>
              <strong>Player and account support:</strong>{" "}
              <a href="mailto:support@diamondmetrics.ai">
                support@diamondmetrics.ai
              </a>
            </p>
            <p>
              <strong>Location:</strong> Utah, United States
            </p>
            <p>
              <strong>Focus:</strong> High school baseball analytics
            </p>
          </div>
        </div>

        <form className="contact-form" onSubmit={handleSubmit}>
          <input
            type="hidden"
            name="_subject"
            value="New Diamond Metrics Inquiry"
          />
          <input type="text" name="_gotcha" style={{ display: "none" }} />

          <div className="form-row">
            <label htmlFor="inquiry">What can we help with?</label>
            <select key={inquiry} id="inquiry" name="inquiry" defaultValue={inquiry}>
              <option value="">General question</option>
              <option value="player-analysis">Analyze my player</option>
              <option value="pro-day">Schedule a Pro Day</option>
              <option value="program">Program analytics</option>
            </select>
          </div>

          <div className="form-row">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              name="name"
              type="text"
              placeholder="Your name"
              required
            />
          </div>

          <div className="form-row">
            <label htmlFor="organization">School / Team</label>
            <input
              id="organization"
              name="organization"
              type="text"
              placeholder="School or team name"
            />
          </div>

          <div className="form-row">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              placeholder="you@example.com"
              required
            />
            <ValidationError
              prefix="Email"
              field="email"
              errors={state.errors}
            />
          </div>

          <div className="form-row">
            <label htmlFor="role">Role</label>
            <select id="role" name="role" defaultValue="">
              <option value="" disabled>
                Select your role
              </option>
              <option>Parent</option>
              <option>Player</option>
              <option>Coach</option>
              <option>Athletic Director</option>
              <option>Other</option>
            </select>
          </div>

          <div className="form-row">
            <label htmlFor="message">Message</label>
            <textarea
              id="message"
              name="message"
              rows="5"
              placeholder="Tell us what type of evaluation, event, player profile, or season support you're interested in."
              required
            ></textarea>
            <ValidationError
              prefix="Message"
              field="message"
              errors={state.errors}
            />
          </div>

          {state.errors && state.errors.length > 0 && (
            <p className="form-note">
              Something went wrong. Please try again or email
              {" "}
              <a href="mailto:info@diamondmetrics.ai">
                info@diamondmetrics.ai
              </a>.
            </p>
          )}

          <button
            type="submit"
            className="primary-button form-button"
            disabled={state.submitting}
          >
            {state.submitting ? "Sending..." : "Contact Us"}
          </button>
        </form>
      </div>
    </section>
  );
}

export default Contact;

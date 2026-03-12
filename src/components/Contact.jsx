import { useForm, ValidationError } from "@formspree/react";

function Contact() {
  const [state, handleSubmit] = useForm("YOUR_FORM_ID");

  if (state.succeeded) {
    return (
      <section id="contact">
        <p className="eyebrow">Message Sent</p>
        <h2>Thanks for reaching out.</h2>
        <p className="section-text">
          We received your message and will follow up shortly.
        </p>
      </section>
    );
  }

  return (
    <section id="contact">
      <p className="eyebrow">Get In Touch</p>
      <h2>Let’s talk about your program.</h2>
      <p className="section-text">
        Interested in bringing baseball analytics to your school or team? Send
        us a message and we’ll follow up with more information.
      </p>

      <div className="contact-layout">
        <div className="contact-card">
          <h3>Contact Information</h3>
          <p>
            Reach out directly if you would like to discuss tryouts, player
            development, in-season reporting, or broader analytics support.
          </p>

          <div className="contact-details">
            <p>
              <strong>Email:</strong>{" "}
              <a href="mailto:contact@diamondmetrics.ai">
                contact@diamondmetrics.ai
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

          <input
            type="text"
            name="_gotcha"
            style={{ display: "none" }}
          />

          <div className="form-row">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              name="name"
              type="text"
              placeholder="Your name"
            />
          </div>

          <div className="form-row">
            <label htmlFor="organization">School / Organization</label>
            <input
              id="organization"
              name="organization"
              type="text"
              placeholder="School or organization name"
            />
          </div>

          <div className="form-row">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="_replyto"
              type="email"
              placeholder="you@example.com"
            />
            <ValidationError
              prefix="Email"
              field="_replyto"
              errors={state.errors}
            />
          </div>

          <div className="form-row">
            <label htmlFor="role">Role</label>
            <select id="role" name="role" defaultValue="">
              <option value="" disabled>
                Select your role
              </option>
              <option>Coach</option>
              <option>Athletic Director</option>
              <option>Parent</option>
              <option>Player</option>
              <option>Other</option>
            </select>
          </div>

          <div className="form-row">
            <label htmlFor="message">Message</label>
            <textarea
              id="message"
              name="message"
              rows="5"
              placeholder="Tell us a little about your program and what you're looking for."
            ></textarea>
            <ValidationError
              prefix="Message"
              field="message"
              errors={state.errors}
            />
          </div>

          <button
            type="submit"
            className="primary-button form-button"
            disabled={state.submitting}
          >
            {state.submitting ? "Sending..." : "Send Inquiry"}
          </button>
        </form>
      </div>
    </section>
  );
}

export default Contact;

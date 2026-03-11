function Contact() {
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
            <p><strong>Email:</strong> contact@diamondmetrics.ai</p>
            <p><strong>Location:</strong> Utah, United States</p>
            <p><strong>Focus:</strong> High school baseball analytics</p>
          </div>
        </div>

        <form className="contact-form">
          <div className="form-row">
            <label htmlFor="name">Name</label>
            <input id="name" type="text" placeholder="Your name" />
          </div>

          <div className="form-row">
            <label htmlFor="organization">School / Organization</label>
            <input
              id="organization"
              type="text"
              placeholder="School or organization name"
            />
          </div>

          <div className="form-row">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" placeholder="you@example.com" />
          </div>

          <div className="form-row">
            <label htmlFor="role">Role</label>
            <select id="role" defaultValue="">
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
              rows="5"
              placeholder="Tell us a little about your program and what you’re looking for."
            ></textarea>
          </div>

          <button type="submit" className="primary-button form-button">
            Send Inquiry
          </button>

          <p className="form-note">
            This form is currently a design placeholder. We can connect it next
            so messages are actually delivered.
          </p>
        </form>
      </div>
    </section>
  )
}

export default Contact

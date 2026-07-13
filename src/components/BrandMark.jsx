function Brandmark({ dark = false }) {
  return (
    <div className={`brandmark${dark ? ' brandmark--dark' : ''}`}>
      <div className="brandmark-badge" aria-hidden="true">
        <svg
          className="brandmark-svg"
          viewBox="0 0 120 120"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id="dmGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#7dd3fc" />
              <stop offset="55%" stopColor="#38bdf8" />
              <stop offset="100%" stopColor="#2563eb" />
            </linearGradient>

            <linearGradient id="dmInnerGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#67e8f9" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#1d4ed8" stopOpacity="0.95" />
            </linearGradient>

            <filter id="dmGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* outer field / shield */}
          <path
            d="M60 10
               C82 10, 100 20, 110 36
               L90 56
               L60 88
               L30 56
               L10 36
               C20 20, 38 10, 60 10 Z"
            fill="none"
            stroke="url(#dmGradient)"
            strokeWidth="5"
            filter="url(#dmGlow)"
          />

          {/* inner infield diamond */}
          <polygon
            points="60,34 82,56 60,78 38,56"
            fill="none"
            stroke="url(#dmGradient)"
            strokeWidth="4"
          />

          {/* home plate node */}
          <circle cx="60" cy="86" r="5" fill="#7dd3fc" />

          {/* center data node */}
          <circle cx="60" cy="56" r="11" fill="#e0f2fe" />
          <circle cx="60" cy="56" r="6" fill="#94a3b8" />

          {/* subtle top arc highlight */}
          <path
            d="M28 34 C42 22, 78 20, 94 34"
            fill="none"
            stroke="url(#dmInnerGradient)"
            strokeWidth="7"
            strokeLinecap="round"
            opacity="0.9"
          />

          {/* base accents */}
          <path
            d="M28 49 L39 58"
            stroke="#dbeafe"
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.85"
          />
          <path
            d="M92 49 L81 58"
            stroke="#dbeafe"
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.85"
          />
        </svg>
      </div>

      <div className="brandmark-text">
        <span className="brandmark-title">Diamond Metrics</span>
        <span className="brandmark-subtitle">Sports Analytics</span>
      </div>
    </div>
  );
}

export default Brandmark;


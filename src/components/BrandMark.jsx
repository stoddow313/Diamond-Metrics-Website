import logo from "../assets/diamond-logo.svg";

function Brandmark() {
  return (
    <div className="brandmark">
      <img src={logo} alt="Diamond Metrics logo" className="brandmark-icon" />

      <div className="brandmark-text">
        <span className="brandmark-title">Diamond Metrics</span>
        <span className="brandmark-subtitle">Baseball Analytics</span>
      </div>
    </div>
  );
}

export default Brandmark;

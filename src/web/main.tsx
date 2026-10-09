import { createRoot } from "react-dom/client";

function App() {
  return (
    <div className="empty" style={{ marginTop: 80 }}>
      Flockline — esqueleto H1
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

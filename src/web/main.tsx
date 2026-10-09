import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TaskList } from "./components/TaskList";
import { boot, login, logout, run, useStore } from "./store";
import { getToken } from "./api";

function Login() {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  return (
    <form
      className="login"
      onSubmit={(e) => {
        e.preventDefault();
        login(name.trim()).catch((x) => setErr(x.message));
      }}
    >
      <h2>Flockline</h2>
      <p style={{ color: "var(--mut)", marginTop: 0 }}>Entrá con tu nombre. No hay contraseñas.</p>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" maxLength={40} />
      {err && <p style={{ color: "var(--err)" }}>{err}</p>}
      <button className="pri" style={{ width: "100%", marginTop: 12 }} disabled={!name.trim()}>
        Entrar
      </button>
    </form>
  );
}

function App() {
  const user = useStore((s) => s.user);
  const error = useStore((s) => s.error);
  const wsOk = useStore((s) => s.wsOk);
  const [ready, setReady] = useState(!getToken());
  useEffect(() => {
    if (getToken()) run(boot()).finally(() => setReady(true));
  }, []);
  if (!ready) return null;
  if (!user) return <Login />;
  return (
    <div className="app">
      <header className="top">
        <b>Flockline</b>
        <span className="mut">{user.name}</span>
        <span className="sp" />
        <span className={wsOk ? "ws-ok" : "ws-bad"}>{wsOk ? "● WS conectado" : "● WS desconectado"}</span>
        <button onClick={logout}>Salir</button>
      </header>
      <main className="cols">
        <TaskList />
        <section className="center">
          <p className="empty">Elegí o creá una tarea</p>
        </section>
        <section className="right" />
      </main>
      {error && <div className="toast">{error}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

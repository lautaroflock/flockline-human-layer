import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActivityFeed } from "./components/ActivityFeed";
import { PresenceBar, UserSwitcher } from "./components/Presence";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { PhaseStepper } from "./components/PhaseStepper";
import { SessionLog } from "./components/SessionLog";
import { TaskList } from "./components/TaskList";
import { boot, cycleTab, cycleTask, login, logout, primaryAction, run, setState, useStore } from "./store";
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

function Center() {
  const detail = useStore((s) => s.detail);
  if (!detail) return <section className="center"><p className="empty">Elegí o creá una tarea</p></section>;
  return (
    <section className="center">
      <PhaseStepper />
      <SessionLog />
      <ActivityFeed />
    </section>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input,textarea,select");
      if (e.ctrlKey && e.key === "Enter") return typing ? undefined : (e.preventDefault(), primaryAction());
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") return e.preventDefault(), setState({ newTaskOpen: true });
      if (e.key === "j" || e.key === "J") return cycleTask(1);
      if (e.key === "k" || e.key === "K") return cycleTask(-1);
      if (e.key === "]") return cycleTab();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  if (!ready) return null;
  if (!user) return <Login />;
  return (
    <div className="app">
      <header className="top">
        <b>Flockline</b>
        <span className="sp" />
        <PresenceBar />
        <UserSwitcher />
        <span className={wsOk ? "ws-ok" : "ws-bad"}>{wsOk ? "● WS conectado" : "● WS desconectado"}</span>
        <button onClick={logout}>Salir</button>
      </header>
      <main className="cols">
        <TaskList />
        <Center />
        <ArtifactPanel />
      </main>
      {error && <div className="toast">{error}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

import { useState } from "react";
import { login, run, useStore } from "../store";
import type { User } from "../../shared/types";

export const Avatar = ({ user, me, off, title }: { user: Pick<User, "name" | "color">; me?: boolean; off?: boolean; title?: string }) => (
  <span className={`av ${me ? "me" : ""} ${off ? "off" : ""}`} style={{ background: user.color }} title={title ?? user.name}>
    {user.name[0]?.toUpperCase()}
  </span>
);

/** Quiénes están conectados; el que mira esta tarea se resalta y se indica en qué pestaña está. */
export function PresenceBar() {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.user);
  const presence = useStore((s) => s.detail?.presence ?? []);
  return (
    <div className="presence" data-testid="presence">
      {users.map((u) => {
        const here = presence.find((p) => p.user_id === u.id);
        return <Avatar key={u.id} user={u} me={u.id === me?.id} off={!u.online && u.id !== me?.id} title={`${u.name}${here ? ` · mirando ${here.tab}` : u.online ? " · conectado" : " · desconectado"}`} />;
      })}
    </div>
  );
}

/** Cambiar de usuario = entrar con otro nombre (la identidad es solo un nombre, §11.1). */
export function UserSwitcher() {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.user);
  const [other, setOther] = useState("");
  if (!me) return null;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span className="mut">Sos:</span>
      <select style={{ width: 130 }} value={me.name} onChange={(e) => run(login(e.target.value))} data-testid="user-switcher">
        {users.map((u) => (
          <option key={u.id}>{u.name}</option>
        ))}
      </select>
      <input style={{ width: 110 }} placeholder="+ otro usuario" value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => e.key === "Enter" && other.trim() && run(login(other.trim()))} />
    </div>
  );
}

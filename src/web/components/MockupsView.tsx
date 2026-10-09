import { useEffect, useState } from "react";
import { api } from "../api";
import { run } from "../store";

// CSP propia del mockup: sin red, sin recursos externos; solo estilos, imágenes data: y scripts en línea
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'">`;
const withCsp = (html: string) => (/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${CSP}`) : `${CSP}${html}`);

/**
 * Mockups HTML versionados con el artefacto (H14). Se muestran en un iframe `sandbox="allow-scripts"` SIN
 * `allow-same-origin`: el mockup corre en un origen opaco y no puede leer el token, el localStorage ni la API de la app.
 */
export function MockupsView({ artifactId, files }: { artifactId: string; files: string[] }) {
  const [path, setPath] = useState(files[0]!);
  const [html, setHtml] = useState<string | null>(null);
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");

  useEffect(() => {
    if (!files.includes(path)) setPath(files[0]!);
  }, [files.join("|")]);

  useEffect(() => {
    setHtml(null);
    run(api<{ content: string }>(`/api/artifacts/${artifactId}/files?path=${encodeURIComponent(path)}`).then((r) => setHtml(r.content)));
  }, [artifactId, path]);

  return (
    <div className="doc" style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="mockups">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {files.length > 1 && (
          <select value={path} onChange={(e) => setPath(e.target.value)} style={{ width: 200 }}>
            {files.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        )}
        {files.length === 1 && <span className="mono">{path}</span>}
        <span className="seg">
          <button className={width === "desktop" ? "on" : ""} onClick={() => setWidth("desktop")}>Escritorio</button>
          <button className={width === "mobile" ? "on" : ""} onClick={() => setWidth("mobile")}>Móvil (375 px)</button>
        </span>
        <span style={{ color: "var(--mut)", fontSize: 12 }}>Vista aislada: el mockup no accede a la app.</span>
      </div>
      <div className="mockup-stage">
        {html === null ? (
          <p className="empty">Cargando mockup…</p>
        ) : (
          <iframe
            title={path}
            sandbox="allow-scripts"
            srcDoc={withCsp(html)}
            style={{ width: width === "mobile" ? 375 : "100%" }}
            data-testid="mockup-frame"
          />
        )}
      </div>
    </div>
  );
}

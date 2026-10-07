import { useEffect, useRef, useState } from "react";
import { Game, type HudState } from "./game";

const SCENARIOS: { id: string; label: string; note: string }[] = [
  { id: "battle-50", label: "Battle · 50 units", note: "Saudi M1A2S + infantry vs Iran Karrar + Basij, scripted attack-move" },
  { id: "battle-200", label: "Battle · 200 units", note: "100 vs 100, same rules" },
  { id: "skirmish", label: "Skirmish vs AI", note: "Tournament 2A, starting army, doctrine bot builds a base" },
];

const RUNTIMES = [
  { id: "interp", label: "Interpreter" },
  { id: "aot", label: "AOT" },
];

function pct(v: number[], q: number) {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

const mb = (b?: number) => (b ? `${(b / 1048576).toFixed(1)} MB` : "–");

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [panel, setPanel] = useState(true);
  const params = new URLSearchParams(location.search);
  const [runtime, setRuntime] = useState(params.get("runtime") ?? "interp");

  useEffect(() => {
    const g = new Game(canvasRef.current!, setHud);
    gameRef.current = g;
    (window as unknown as { game: Game }).game = g;
    const only = params.get("only");
    if (only) g.renderer.actorFilter = (t) => g.client.str(t).startsWith(only);
    g.boot(runtime, params.get("private") !== "0");
    return () => g.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async (id: string) => {
    const res = await fetch(`/scenarios/${id}.json`);
    gameRef.current?.start(await res.text());
  };

  useEffect(() => {
    const auto = params.get("scenario");
    if (auto && hud?.phase === "ready") start(auto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hud?.phase]);

  const switchRuntime = (id: string) => {
    setRuntime(id);
    const p = new URLSearchParams(location.search);
    p.set("runtime", id);
    location.search = p.toString();
  };

  const h = hud;
  const lat = h?.latency ?? [];
  const latV = h?.latencyVisible ?? [];

  return (
    <div className="app">
      <canvas ref={canvasRef} className="stage" tabIndex={0} />

      {h && h.phase === "running" && (
        <>
          <header className="topbar">
            <div className="brand">
              <span className="dot" /> RTS AI <span className="muted">· real OpenRA sim in WebAssembly</span>
            </div>
            <div className="players">
              {h.players.map((p) => (
                <span key={p.name} className={`chip ${p.local ? "local" : ""}`}>
                  <i style={{ background: p.color }} /> {p.local ? "You" : p.name} <b>{p.units}</b>
                </span>
              ))}
            </div>
            <div className="perf">
              <span title="Frames per second">{h.fps.toFixed(0)} fps</span>
              <span title="Simulation tick (World.Tick + snapshot) in the worker">{h.simTickMs.toFixed(1)} ms/tick</span>
              <span title="Input to first frame drawn from the tick that executed the order (median)">
                {lat.length ? `${pct(lat, 0.5).toFixed(0)} ms input` : "– input"}
              </span>
              <button className="ghost" onClick={() => setPanel(!panel)}>{panel ? "Hide" : "Stats"}</button>
            </div>
          </header>

          {h.selection.length > 0 && (
            <div className="selection">
              <div className="sel-units">
                {h.selection.map((s) => (
                  <span key={s.type} className="unit">{s.type}<b>×{s.count}</b></span>
                ))}
              </div>
              <div className="commands">
                <button onClick={() => gameRef.current?.stop()}>Stop <kbd>S</kbd></button>
              </div>
              <div className="hint">Right-click: move / attack (engine order generator) · drag: box select · wheel: zoom · middle-drag / arrows: pan</div>
            </div>
          )}

          {panel && (
            <aside className="panel">
              <h3>Engine</h3>
              <dl>
                <dt>Runtime</dt><dd>{h.runtime === "aot" ? "AOT" : "Interpreter"} · {h.shared ? "SharedArrayBuffer" : "postMessage"}</dd>
                <dt>Map</dt><dd>{h.info?.map} ({h.info?.mapSize.join("×")})</dd>
                <dt>Tick</dt><dd>{h.tick} · {h.tps.toFixed(1)} tps</dd>
                <dt>SyncHash</dt><dd className="mono">{(h.syncHash >>> 0).toString(16).padStart(8, "0")}</dd>
                <dt>World.Tick</dt><dd>{h.engineTickMs.toFixed(2)} ms</dd>
                <dt>Snapshot</dt><dd>{h.buildMs.toFixed(2)} ms</dd>
                <dt>Late ticks</dt><dd>{h.lateTicks}</dd>
                <dt>Units</dt><dd>{h.units}</dd>
              </dl>
              <h3>Frame</h3>
              <dl>
                <dt>Draw</dt><dd>{h.frameMs.toFixed(2)} ms · {h.draws} sprites · {h.batches} batches</dd>
                <dt>Sheets</dt><dd>{h.textures}</dd>
                <dt>Input→frame</dt>
                <dd>{lat.length ? `p50 ${pct(lat, 0.5).toFixed(0)} · p95 ${pct(lat, 0.95).toFixed(0)} ms (n=${lat.length})` : "–"}</dd>
                <dt>…visible move</dt>
                <dd>{latV.length ? `p50 ${pct(latV, 0.5).toFixed(0)} · p95 ${pct(latV, 0.95).toFixed(0)} ms` : "–"}</dd>
              </dl>
              <h3>Memory & load</h3>
              <dl>
                <dt>WASM heap</dt><dd>{h.heapMB.toFixed(0)} MB (managed {h.managedMB.toFixed(0)} MB)</dd>
                <dt>Runtime dl</dt><dd>{mb(h.downloads.runtime)}</dd>
                <dt>Bundle dl</dt><dd>{mb(h.downloads.bundle)}</dd>
                <dt>Private RA2</dt><dd>{mb(h.downloads.private)}</dd>
                <dt>Boot</dt><dd>{(h.timings["worker.total"] / 1000).toFixed(1)} s</dd>
                <dt>World</dt><dd>{(h.startMs / 1000).toFixed(1)} s</dd>
              </dl>
              <div className="actions">
                <button onClick={() => gameRef.current?.requestVerify()}>Verify SyncHash natively</button>
                <button onClick={() => gameRef.current?.latencyProbe(20)}>Latency probe</button>
                <button onClick={() => gameRef.current?.bench(250)}>Bench 250 ticks</button>
              </div>
              {h.verify && <p className={`verify ${h.verify.startsWith("Identical") ? "ok" : ""}`}>{h.verify}</p>}
              {h.bench && <p className="bench">{h.bench}</p>}
              <div className="scenarios small">
                {SCENARIOS.map((s) => (
                  <button key={s.id} className="ghost" onClick={() => start(s.id)}>{s.label}</button>
                ))}
              </div>
            </aside>
          )}
        </>
      )}

      {h && h.phase !== "running" && (
        <div className="launch">
          <div className="card">
            <h1>RTS AI <span>web engine spike</span></h1>
            <p className="lede">The real OpenRA simulation and RTS AI mod, compiled to WebAssembly and ticking in a worker. Same rules, same results as the desktop game.</p>
            {h.phase === "error" && <pre className="error">{h.error}</pre>}
            {(h.phase === "loading" || h.phase === "starting") && (
              <div className="progress"><div className="spinner" /> <div><b>{h.stage}</b><br /><span className="muted">{h.detail}</span></div></div>
            )}
            {h.phase === "ready" && (
              <div className="scenarios">
                {SCENARIOS.map((s) => (
                  <button key={s.id} onClick={() => start(s.id)}>
                    <b>{s.label}</b><span>{s.note}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="runtime">
              {RUNTIMES.map((r) => (
                <button key={r.id} className={r.id === runtime ? "on" : ""} onClick={() => switchRuntime(r.id)}>{r.label}</button>
              ))}
              <span className="muted">{h.shared ? "cross-origin isolated · shared snapshot ring" : "no SharedArrayBuffer · postMessage"}</span>
            </div>
            <p className="fine">Local admin build: terrain and stock assets come from your own Red Alert 2 install, mounted privately in this browser. Nothing from it is bundled or uploaded.</p>
          </div>
        </div>
      )}
    </div>
  );
}

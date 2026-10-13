"use client";

// Screenshot annotator, shared verbatim by RTSAI-Web (app/components/feedback) and RTSAI-WebGame (web/src/ui/feedback).
// Full-screen canvas editor: select & move, pen, line, arrow, box, ellipse and text, colours, stroke width, undo/redo,
// delete and clear. Annotations live in image pixels, so the export is full resolution (JPEG, max 1920 px wide).

import { ArrowUpRight, Check, Circle, Eraser, Minus, MousePointer2, Pencil, Plus, Redo2, Square, Trash2, Type, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { loadImage, toJpeg } from "./media";
import "./feedback-kit.css";

type Tool = "select" | "pen" | "line" | "arrow" | "rect" | "ellipse" | "text";
type Point = { x: number; y: number };
type Shape = { id: number; color: string; width: number };
type Annotation =
  | (Shape & { tool: "pen"; points: Point[] })
  | (Shape & { tool: "line" | "arrow" | "rect" | "ellipse"; from: Point; to: Point })
  | (Shape & { tool: "text"; at: Point; text: string });
type Bounds = { x: number; y: number; w: number; h: number };

const COLORS = ["#ef4444", "#facc15", "#22c55e", "#3b82f6", "#ffffff", "#111111"];
// Dual-stroke pencil: a dark outline with a light core stays visible on bright and dark screenshots alike.
const PENCIL_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' fill='none' stroke='black' stroke-width='3'/%3E%3Cpath d='M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' fill='none' stroke='white' stroke-width='1.5'/%3E%3C/svg%3E") 2 22, crosshair`;
const CURSORS: Record<Tool, string> = { select: "default", pen: PENCIL_CURSOR, line: "crosshair", arrow: "crosshair", rect: "crosshair", ellipse: "crosshair", text: "text" };
const TOOLS: { tool: Tool; label: string; icon: typeof Pencil }[] = [
  { tool: "select", label: "Select and move", icon: MousePointer2 },
  { tool: "pen", label: "Pen", icon: Pencil },
  { tool: "line", label: "Line", icon: Minus },
  { tool: "arrow", label: "Arrow", icon: ArrowUpRight },
  { tool: "rect", label: "Box", icon: Square },
  { tool: "ellipse", label: "Ellipse", icon: Circle },
  { tool: "text", label: "Text", icon: Type },
];

const fontSize = (width: number) => Math.max(12, width * 6);
const font = (size: number) => `600 ${size}px system-ui, "Segoe UI", sans-serif`;

function isLight(color: string) {
  const value = parseInt(color.slice(1), 16);
  return ((value >> 16) & 255) * 0.299 + ((value >> 8) & 255) * 0.587 + (value & 255) * 0.114 > 150;
}

function bounds(annotation: Annotation, measure: (text: string, size: number) => number): Bounds {
  if (annotation.tool === "pen") {
    const xs = annotation.points.map((p) => p.x), ys = annotation.points.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  if (annotation.tool === "text") {
    const size = fontSize(annotation.width);
    return { x: annotation.at.x, y: annotation.at.y - size, w: measure(annotation.text, size), h: size * 1.25 };
  }
  const { from, to } = annotation;
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
}

function distanceToSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hits(annotation: Annotation, p: Point, tolerance: number, measure: (text: string, size: number) => number) {
  const reach = tolerance + annotation.width / 2;
  if (annotation.tool === "pen") return annotation.points.some((point, i) => distanceToSegment(p, annotation.points[Math.max(0, i - 1)], point) <= reach);
  if (annotation.tool === "line" || annotation.tool === "arrow") return distanceToSegment(p, annotation.from, annotation.to) <= reach;
  const b = bounds(annotation, measure);
  return p.x >= b.x - reach && p.x <= b.x + b.w + reach && p.y >= b.y - reach && p.y <= b.y + b.h + reach;
}

function moved(annotation: Annotation, dx: number, dy: number): Annotation {
  const shift = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  if (annotation.tool === "pen") return { ...annotation, points: annotation.points.map(shift) };
  if (annotation.tool === "text") return { ...annotation, at: shift(annotation.at) };
  return { ...annotation, from: shift(annotation.from), to: shift(annotation.to) };
}

/** Draws annotations in image pixels; the caller sets the transform from image pixels to canvas pixels. */
function paint(context: CanvasRenderingContext2D, annotations: Annotation[]) {
  for (const annotation of annotations) {
    context.save();
    context.strokeStyle = annotation.color;
    context.fillStyle = annotation.color;
    context.lineWidth = annotation.width;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (annotation.tool === "pen") {
      context.beginPath();
      annotation.points.forEach((p, i) => (i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)));
      if (annotation.points.length === 1) context.lineTo(annotation.points[0].x + 0.1, annotation.points[0].y);
      context.stroke();
    } else if (annotation.tool === "text") {
      const size = fontSize(annotation.width);
      context.font = font(size);
      context.textBaseline = "alphabetic";
      context.shadowColor = isLight(annotation.color) ? "rgba(0,0,0,.85)" : "rgba(255,255,255,.7)";
      context.shadowBlur = Math.max(2, size / 8);
      context.fillText(annotation.text, annotation.at.x, annotation.at.y);
    } else {
      const { from, to } = annotation;
      context.beginPath();
      if (annotation.tool === "rect") context.rect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.abs(to.x - from.x), Math.abs(to.y - from.y));
      else if (annotation.tool === "ellipse") context.ellipse((from.x + to.x) / 2, (from.y + to.y) / 2, Math.abs(to.x - from.x) / 2, Math.abs(to.y - from.y) / 2, 0, 0, Math.PI * 2);
      else { context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); }
      context.stroke();
      if (annotation.tool === "arrow") {
        const angle = Math.atan2(to.y - from.y, to.x - from.x), head = Math.max(10, annotation.width * 4);
        context.beginPath();
        context.moveTo(to.x, to.y);
        context.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
        context.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
        context.closePath();
        context.fill();
      }
    }
    context.restore();
  }
}

export function ScreenshotAnnotator({ src, onSave, onCancel }: {
  /** An object URL (or data URL) of the screenshot. */
  src: string;
  onSave: (result: { blob: Blob; width: number; height: number }) => void;
  onCancel: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const colorRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [view, setView] = useState({ width: 0, height: 0, scale: 1 });
  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState(COLORS[0]);
  const [lineWidth, setLineWidth] = useState(4);
  const [history, setHistory] = useState<{ stack: Annotation[][]; index: number }>({ stack: [[]], index: 0 });
  const [live, setLiveState] = useState<Annotation[] | null>(null);
  // Mirrors `live` so the pointer-up that ends a stroke commits its last point even before React re-renders.
  const liveRef = useRef<Annotation[] | null>(null);
  const setLive = (next: Annotation[] | null) => { liveRef.current = next; setLiveState(next); };
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [textInput, setTextInput] = useState<{ at: Point; left: number; top: number } | null>(null);
  const [textValue, setTextValue] = useState("");
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ mode: "draw" | "move"; origin: Point; base: Annotation[]; id: number } | null>(null);
  const nextId = useRef(1);

  const committed = history.stack[history.index];
  const annotations = live ?? committed;

  const measure = useCallback((text: string, size: number) => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return text.length * size * 0.6;
    context.save();
    context.font = font(size);
    const width = context.measureText(text).width;
    context.restore();
    return width;
  }, []);

  const commit = useCallback((next: Annotation[]) => {
    setHistory((h) => ({ stack: [...h.stack.slice(0, h.index + 1), next], index: h.index + 1 }));
  }, []);

  // Hosts pass inline callbacks; keep the latest without reloading the image on every render.
  const cancelRef = useRef(onCancel);
  useEffect(() => { cancelRef.current = onCancel; });
  useEffect(() => {
    let alive = true;
    loadImage(src).then((loaded) => { if (alive) setImage(loaded); }).catch(() => cancelRef.current());
    return () => { alive = false; };
  }, [src]);

  useEffect(() => { rootRef.current?.focus(); }, []);

  // Fit the screenshot into the stage (contain), at device-pixel resolution.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !image) return;
    const fit = () => {
      const scale = Math.min((stage.clientWidth - 32) / image.naturalWidth, (stage.clientHeight - 32) / image.naturalHeight, 1.5);
      setView({ width: Math.round(image.naturalWidth * scale), height: Math.round(image.naturalHeight * scale), scale });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [image]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || !view.width) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(view.width * dpr), height = Math.round(view.height * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const context = canvas.getContext("2d")!;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    context.setTransform(view.scale * dpr, 0, 0, view.scale * dpr, 0, 0);
    context.drawImage(image, 0, 0);
    paint(context, annotations);
    const selected = annotations.find((a) => a.id === selectedId);
    if (selected) {
      const b = bounds(selected, measure), pad = 6 / view.scale;
      context.save();
      context.strokeStyle = "#3b82f6";
      context.lineWidth = 1.5 / view.scale;
      context.setLineDash([4 / view.scale, 4 / view.scale]);
      context.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      context.restore();
    }
  }, [image, view, annotations, selectedId, measure]);

  useEffect(() => { redraw(); }, [redraw]);

  useEffect(() => {
    if (textInput) requestAnimationFrame(() => textRef.current?.focus());
  }, [textInput]);

  const toImage = (event: ReactPointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / view.scale, y: (event.clientY - rect.top) / view.scale };
  };

  const commitText = useCallback(() => {
    if (textInput && textValue.trim()) {
      commit([...committed, { id: nextId.current++, tool: "text", color, width: lineWidth / view.scale, at: textInput.at, text: textValue.trim() }]);
    }
    setTextInput(null);
    setTextValue("");
    // The input leaves the page; keep the keyboard (undo, delete, Esc) on the editor.
    rootRef.current?.focus();
  }, [textInput, textValue, committed, color, lineWidth, view.scale, commit]);

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !image) return;
    if (textInput) { commitText(); return; }
    const p = toImage(event);
    if (tool === "text") {
      const canvasRect = canvasRef.current!.getBoundingClientRect(), stageRect = stageRef.current!.getBoundingClientRect();
      const size = fontSize(lineWidth);
      setSelectedId(null);
      setTextInput({ at: { x: p.x, y: p.y + size * 0.35 / view.scale }, left: canvasRect.left - stageRect.left + p.x * view.scale, top: canvasRect.top - stageRect.top + p.y * view.scale - size * 0.65 });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "select") {
      const hit = [...committed].reverse().find((a) => hits(a, p, 10 / view.scale, measure));
      setSelectedId(hit?.id ?? null);
      if (hit) drag.current = { mode: "move", origin: p, base: committed, id: hit.id };
      return;
    }
    const id = nextId.current++, width = lineWidth / view.scale;
    const draft: Annotation = tool === "pen" ? { id, tool, color, width, points: [p] } : { id, tool, color, width, from: p, to: p };
    setSelectedId(null);
    drag.current = { mode: "draw", origin: p, base: committed, id };
    setLive([...committed, draft]);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = drag.current;
    if (!current) return;
    const p = toImage(event);
    if (current.mode === "move") {
      setLive(current.base.map((a) => (a.id === current.id ? moved(a, p.x - current.origin.x, p.y - current.origin.y) : a)));
      return;
    }
    setLive((liveRef.current ?? current.base).map((a) => {
      if (a.id !== current.id) return a;
      if (a.tool === "pen") return { ...a, points: [...a.points, p] };
      if (a.tool === "text") return a;
      // Shift keeps boxes and ellipses square and lines at 45° steps.
      if (event.shiftKey && (a.tool === "rect" || a.tool === "ellipse")) {
        const side = Math.max(Math.abs(p.x - a.from.x), Math.abs(p.y - a.from.y));
        return { ...a, to: { x: a.from.x + Math.sign(p.x - a.from.x || 1) * side, y: a.from.y + Math.sign(p.y - a.from.y || 1) * side } };
      }
      return { ...a, to: p };
    }));
  };

  const pointerUp = () => {
    const current = drag.current, final = liveRef.current;
    drag.current = null;
    if (!current || !final) { setLive(null); return; }
    const changed = final.find((a) => a.id === current.id);
    const trivial = current.mode === "draw" && changed && changed.tool !== "pen" && changed.tool !== "text" && Math.hypot(changed.to.x - changed.from.x, changed.to.y - changed.from.y) < 3 / view.scale;
    if (!trivial) commit(final);
    setLive(null);
  };

  const undo = () => { setSelectedId(null); setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1) })); };
  const redo = () => setHistory((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }));
  const deleteSelected = () => {
    if (selectedId === null) return;
    commit(committed.filter((a) => a.id !== selectedId));
    setSelectedId(null);
  };
  const clear = () => { if (committed.length) { commit([]); setSelectedId(null); } };

  const save = async () => {
    if (!image || saving) return;
    setSaving(true);
    let final = committed;
    if (textInput && textValue.trim()) final = [...committed, { id: nextId.current++, tool: "text", color, width: lineWidth / view.scale, at: textInput.at, text: textValue.trim() }];
    // Full resolution: the image's own pixels, capped at 1920 px wide by toJpeg.
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    paint(context, final);
    try {
      onSave(await toJpeg(canvas));
    } finally {
      setSaving(false);
    }
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys never reach the game or page behind the editor.
    event.stopPropagation();
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
    else if ((event.key === "Delete" || event.key === "Backspace") && selectedId !== null) { event.preventDefault(); deleteSelected(); }
    else if (event.key === "Escape") { event.preventDefault(); if (selectedId !== null) setSelectedId(null); else onCancel(); }
    else if (event.key === "Enter" && mod) { event.preventDefault(); void save(); }
  };

  const customColor = !COLORS.includes(color);
  return (
    // The editor is modal: its shortcuts (undo, redo, delete, Esc) apply anywhere inside it, and no key reaches the page.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div ref={rootRef} className="fbk-annotator" role="dialog" aria-modal="true" aria-label="Mark up screenshot" tabIndex={-1} onKeyDown={keyDown}>
      <div className="fbk-annotator-bar" role="toolbar" aria-label="Markup tools">
        <div className="fbk-group">
          {TOOLS.map(({ tool: id, label, icon: Icon }) => (
            <button key={id} type="button" className="fbk-tool" aria-label={label} title={label} aria-pressed={tool === id} onClick={() => { setTool(id); if (id !== "select") setSelectedId(null); }}><Icon size={17} /></button>
          ))}
        </div>
        <div className="fbk-group" aria-label="Colour">
          {COLORS.map((swatch) => (
            <button key={swatch} type="button" className="fbk-swatch" aria-label={`Colour ${swatch}`} aria-pressed={color === swatch} style={{ background: swatch }} onClick={() => setColor(swatch)} />
          ))}
          <span className="fbk-custom">
            <button type="button" className="fbk-swatch fbk-swatch-custom" aria-label="Pick any colour" aria-pressed={customColor} style={customColor ? { background: color, borderStyle: "solid" } : undefined} onClick={() => colorRef.current?.click()}>{!customColor && <Plus size={12} />}</button>
            <input ref={colorRef} type="color" value={color} onChange={(event) => setColor(event.target.value)} tabIndex={-1} aria-hidden="true" />
          </span>
        </div>
        <label className="fbk-group fbk-width" title="Stroke width">
          <span className="fbk-sr">Stroke width</span>
          <input type="range" min={1} max={12} value={lineWidth} onChange={(event) => setLineWidth(Number(event.target.value))} />
          <output>{lineWidth}</output>
        </label>
        <div className="fbk-group">
          <button type="button" className="fbk-tool" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={history.index === 0} onClick={undo}><Undo2 size={17} /></button>
          <button type="button" className="fbk-tool" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={history.index >= history.stack.length - 1} onClick={redo}><Redo2 size={17} /></button>
          <button type="button" className="fbk-tool" aria-label="Delete selected" title="Delete selected (Del)" disabled={selectedId === null} onClick={deleteSelected}><Trash2 size={17} /></button>
          <button type="button" className="fbk-tool" aria-label="Clear all" title="Clear all" disabled={!committed.length} onClick={clear}><Eraser size={17} /></button>
        </div>
        <div className="fbk-group fbk-end">
          <button type="button" className="fbk-tool" aria-label="Cancel markup" title="Cancel (Esc)" onClick={onCancel}><X size={18} /></button>
          <button type="button" className="fbk-done" onClick={() => void save()} disabled={!image || saving}><Check size={17} /> Done</button>
        </div>
      </div>
      <div ref={stageRef} className="fbk-annotator-stage">
        {view.width > 0 && (
          <canvas
            ref={canvasRef}
            className="fbk-annotator-canvas"
            style={{ width: view.width, height: view.height, cursor: CURSORS[tool] }}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
          />
        )}
        {textInput && (
          <input
            ref={textRef}
            className="fbk-text-input"
            value={textValue}
            placeholder="Type, then Enter"
            onChange={(event) => setTextValue(event.target.value)}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") { event.preventDefault(); commitText(); }
              if (event.key === "Escape") { event.preventDefault(); setTextInput(null); setTextValue(""); rootRef.current?.focus(); }
            }}
            style={{
              left: textInput.left,
              top: textInput.top,
              color,
              font: font(fontSize(lineWidth)),
              textShadow: isLight(color) ? "0 0 2px rgba(0,0,0,.85), 0 1px 3px rgba(0,0,0,.5)" : "0 0 2px rgba(255,255,255,.6), 0 1px 3px rgba(0,0,0,.3)",
            }}
          />
        )}
      </div>
    </div>
  );
}

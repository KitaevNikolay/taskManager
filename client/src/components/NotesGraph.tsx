import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';

interface GraphData {
  notes: { id: number; label: string; color: string | null; done: boolean; tab: string }[];
  links: { note_id: number; kind: 'task' | 'employee' | 'note'; target_id: number; label: string | null }[];
  tasks: { id: number; title: string; status: number }[];
  employees: { id: number; name: string }[];
}
type Kind = 'note' | 'task' | 'employee';
interface GNode { key: string; kind: Kind; id: number; label: string; sub?: string; color?: string | null; done?: boolean; deg: number; x: number; y: number; vx: number; vy: number }

interface Props {
  showDone: boolean;
  onNote: (id: number) => void;
  onTask: (id: number) => void;
  onEmployee: (id: number) => void;
}

/** Силовая раскладка: отталкивание узлов, пружины по связям, притяжение к центру. Считается сразу, без анимации. */
function layout(nodes: GNode[], edges: [GNode, GNode][]) {
  const n = nodes.length;
  const R = 40 * Math.sqrt(n + 1);
  nodes.forEach((v, i) => {
    const a = (i / Math.max(n, 1)) * Math.PI * 2 * 3.1;
    const r = R * Math.sqrt((i + 1) / (n + 1));
    v.x = Math.cos(a) * r;
    v.y = Math.sin(a) * r;
  });
  const iters = n > 300 ? 120 : 260;
  for (let it = 0; it < iters; it++) {
    const cool = 1 - it / (iters + 20);
    for (const v of nodes) { v.vx = 0; v.vy = 0; }
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const f = 2600 / d2;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }
    }
    for (const [a, b] of edges) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 70) * 0.05;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const v of nodes) {
      v.vx -= v.x * 0.012;
      v.vy -= v.y * 0.012;
      v.x += Math.max(-14, Math.min(14, v.vx)) * cool;
      v.y += Math.max(-14, Math.min(14, v.vy)) * cool;
    }
  }
}

export function NotesGraph({ showDone, onNote, onTask, onEmployee }: Props) {
  const { toast, version } = useApp();
  const [data, setData] = useState<GraphData | null>(null);
  const [lonely, setLonely] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    api.get<GraphData>('/notes/graph').then(setData).catch((e) => toast(e.message, 'error'));
  }, [version, toast]);

  const graph = useMemo(() => {
    if (!data) return null;
    const nodes = new Map<string, GNode>();
    const add = (kind: Kind, id: number, label: string, extra: Partial<GNode> = {}) => {
      const key = `${kind}:${id}`;
      if (!nodes.has(key)) nodes.set(key, { key, kind, id, label, deg: 0, x: 0, y: 0, vx: 0, vy: 0, ...extra });
      return nodes.get(key)!;
    };
    const notes = data.notes.filter((n) => showDone || !n.done);
    for (const n of notes) add('note', n.id, n.label, { sub: n.tab, color: n.color, done: n.done });
    const edges: [GNode, GNode][] = [];
    for (const l of data.links) {
      const from = nodes.get(`note:${l.note_id}`);
      if (!from) continue;
      let to: GNode | undefined;
      if (l.kind === 'note') to = nodes.get(`note:${l.target_id}`);
      else if (l.kind === 'task') {
        const t = data.tasks.find((x) => x.id === l.target_id);
        to = add('task', l.target_id, `#${l.target_id} ${t?.title || l.label || ''}`.trim(), { done: t ? t.status === 5 : false });
      } else {
        const e = data.employees.find((x) => x.id === l.target_id);
        to = add('employee', l.target_id, e?.name || l.label || `#${l.target_id}`);
      }
      if (!to || to === from) continue;
      edges.push([from, to]);
      from.deg++;
      to.deg++;
    }
    const list = [...nodes.values()].filter((v) => lonely || v.deg > 0);
    layout(list, edges);
    return { nodes: list, edges };
  }, [data, showDone, lonely]);

  // Рамка по содержимому — при каждой новой раскладке
  const fit = useMemo(() => {
    if (!graph?.nodes.length) return { x: -300, y: -200, w: 600, h: 400 };
    const xs = graph.nodes.map((v) => v.x);
    const ys = graph.nodes.map((v) => v.y);
    const pad = 70;
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    return { x, y, w: Math.max(...xs) - x + pad, h: Math.max(...ys) - y + pad };
  }, [graph]);
  useEffect(() => setView(null), [fit]);
  const vb = view || fit;

  const neighbours = useMemo(() => {
    if (!hover || !graph) return null;
    const s = new Set([hover]);
    for (const [a, b] of graph.edges) {
      if (a.key === hover) s.add(b.key);
      if (b.key === hover) s.add(a.key);
    }
    return s;
  }, [hover, graph]);

  // Колесо масштабирует граф, а не прокручивает страницу: нужен непассивный обработчик
  const vbRef = useRef(vb);
  vbRef.current = vb;
  const hasNodes = !!graph?.nodes.length;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const v = vbRef.current;
      const r = svg.getBoundingClientRect();
      const px = v.x + ((e.clientX - r.left) / r.width) * v.w;
      const py = v.y + ((e.clientY - r.top) / r.height) * v.h;
      const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      setView({ x: px - (px - v.x) * k, y: py - (py - v.y) * k, w: v.w * k, h: v.h * k });
    };
    svg.addEventListener('wheel', h, { passive: false });
    return () => svg.removeEventListener('wheel', h);
  }, [hasNodes]);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('.g-node')) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const r = svgRef.current!.getBoundingClientRect();
    const dx = ((e.clientX - d.x) / r.width) * vb.w;
    const dy = ((e.clientY - d.y) / r.height) * vb.h;
    d.x = e.clientX;
    d.y = e.clientY;
    setView({ ...vb, x: vb.x - dx, y: vb.y - dy });
  };

  const open = (v: GNode) => (v.kind === 'note' ? onNote(v.id) : v.kind === 'task' ? onTask(v.id) : onEmployee(v.id));
  const many = (graph?.nodes.length || 0) > 70;

  if (!graph) return <div className="card muted center notes-empty">Строю граф…</div>;
  return (
    <div className="card notes-graph">
      <div className="notes-graph-bar">
        <span className="g-legend"><i className="g-dot note" />заметка</span>
        <span className="g-legend"><i className="g-dot task" />задача Б24</span>
        <span className="g-legend"><i className="g-dot employee" />сотрудник</span>
        <label className="check"><input type="checkbox" checked={lonely} onChange={(e) => setLonely(e.target.checked)} /> Заметки без связей</label>
        <span className="muted small">Колесо — масштаб, перетаскивание фона — сдвиг</span>
        {view && <button className="btn ghost sm" onClick={() => setView(null)}>Показать всё</button>}
      </div>
      {graph.nodes.length === 0 ? (
        <div className="muted center notes-empty">
          Связей пока нет. Упомяните в заметке задачу через <b>#</b>, сотрудника через <b>@</b> или другую заметку через <b>[[</b>.
        </div>
      ) : (
        <svg
          ref={svgRef}
          className="notes-graph-svg"
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          role="img"
          aria-label="Граф связей заметок, задач и сотрудников"
        >
          {graph.edges.map(([a, b], i) => (
            <line key={i} className={`g-edge ${hover && (a.key === hover || b.key === hover) ? 'hot' : ''}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
          ))}
          {graph.nodes.map((v) => {
            const r = 5 + Math.min(v.deg, 8) * 1.4;
            const dim = neighbours && !neighbours.has(v.key);
            const showLabel = !many || v.deg >= 3 || neighbours?.has(v.key);
            return (
              <g
                key={v.key}
                className={`g-node ${v.kind} ${v.done ? 'done' : ''} ${dim ? 'dim' : ''} ${v.color ? 'c-' + v.color : ''}`}
                tabIndex={0}
                role="button"
                aria-label={v.label}
                onMouseEnter={() => setHover(v.key)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(v.key)}
                onBlur={() => setHover(null)}
                onClick={() => open(v)}
                onKeyDown={(e) => e.key === 'Enter' && open(v)}
              >
                <title>{v.sub ? `${v.label} · ${v.sub}` : v.label}</title>
                <circle cx={v.x} cy={v.y} r={r} />
                {showLabel && <text x={v.x} y={v.y + r + 12} textAnchor="middle">{v.label.length > 34 ? v.label.slice(0, 33) + '…' : v.label}</text>}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

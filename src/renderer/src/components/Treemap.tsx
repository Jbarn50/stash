import { useEffect, useMemo, useRef, useState } from 'react'
import type { ViewNode } from '../../../shared/types'
import { formatBytes } from '../lib/format'
import { layoutTreemap, type TreemapRect } from '../lib/treemapLayout'

const HUES = [214, 262, 170, 24, 330, 120, 45, 190]

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
}

function hatch(ctx: CanvasRenderingContext2D, r: TreemapRect, color: string): void {
  ctx.save()
  ctx.beginPath()
  ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
  ctx.clip()
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  for (let x = r.x0 - (r.y1 - r.y0); x < r.x1; x += 8) {
    ctx.beginPath()
    ctx.moveTo(x, r.y1)
    ctx.lineTo(x + (r.y1 - r.y0), r.y0)
    ctx.stroke()
  }
  ctx.restore()
}

/** Finds the deepest rect under a point. */
function hit(rects: TreemapRect[], x: number, y: number): TreemapRect | null {
  let best: TreemapRect | null = null
  for (const r of rects) {
    if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1 && (!best || r.depth >= best.depth)) best = r
  }
  return best
}

export default function Treemap({
  root,
  onDrill,
  onMenu
}: {
  root: ViewNode
  onDrill: (folder: ViewNode) => void
  onMenu: (node: ViewNode, clientX: number, clientY: number) => void
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const rects = useMemo(() => layoutTreemap(root, size.w, size.h), [root, size])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    canvas.style.width = `${size.w}px`
    canvas.style.height = `${size.h}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const text = cssVar('--text')
    const hatchColor = cssVar('--hatch')
    ctx.font = '12px "Segoe UI", system-ui, sans-serif'
    ctx.textBaseline = 'top'

    const topIndex = new Map<ViewNode, number>()
    rects.filter((r) => r.depth === 1).forEach((r, i) => topIndex.set(r.node, i))
    let parentHue = 0
    for (const r of rects) {
      if (r.depth === 1) parentHue = HUES[(topIndex.get(r.node) ?? 0) % HUES.length]
      const grey = r.node.kind === 'small' || r.node.kind === 'other'
      const light = r.depth === 1 ? (dark ? 26 : 82) : dark ? 36 : 70
      ctx.fillStyle = grey ? `hsl(0 0% ${light}%)` : `hsl(${parentHue} 55% ${light}%)`
      ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
      if (r.node.unreadable) hatch(ctx, r, hatchColor)
      const w = r.x1 - r.x0
      const h = r.y1 - r.y0
      if (w > 48 && h > 14) {
        ctx.fillStyle = text
        const label = r.node.unreadable ? `${r.node.name} — Can't read` : r.node.name
        ctx.save()
        ctx.beginPath()
        ctx.rect(r.x0 + 2, r.y0, w - 4, h)
        ctx.clip()
        ctx.fillText(label, r.x0 + 4, r.y0 + 2)
        if (h > 30 && r.depth === 2)
          ctx.fillText(formatBytes(r.node.sizeOnDisk), r.x0 + 4, r.y0 + 16)
        ctx.restore()
      }
    }
  }, [rects, size])

  const point = (e: React.MouseEvent): { x: number; y: number } => {
    const box = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - box.left, y: e.clientY - box.top }
  }

  return (
    <div ref={wrapRef} className="treemap-wrap">
      <canvas
        ref={canvasRef}
        aria-label={`Treemap of ${root.name}`}
        onMouseMove={(e) => {
          const p = point(e)
          const r = hit(rects, p.x, p.y)
          setTip(
            r
              ? {
                  x: Math.min(p.x + 12, size.w - 160),
                  y: p.y + 14,
                  text: `${r.node.name} · ${formatBytes(r.node.sizeOnDisk)}${r.node.unreadable ? " · Can't read" : ''}`
                }
              : null
          )
        }}
        onMouseLeave={() => setTip(null)}
        onClick={(e) => {
          const p = point(e)
          const r = hit(rects, p.x, p.y)
          if (!r) return
          // Drill into the deepest folder under the pointer; clicking a file drills into its folder.
          const folder = r.node.kind === 'folder' ? r.node : parentOf(rects, r)
          if (folder?.kind === 'folder' && folder.id !== null && !folder.unreadable) onDrill(folder)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          const p = point(e)
          const r = hit(rects, p.x, p.y)
          if (r && r.node.id !== null && (r.node.kind === 'folder' || r.node.kind === 'file'))
            onMenu(r.node, e.clientX, e.clientY)
        }}
      />
      {tip && (
        <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </div>
  )
}

function parentOf(rects: TreemapRect[], child: TreemapRect): ViewNode | null {
  if (child.depth !== 2) return null
  const parent = rects.find(
    (r) =>
      r.depth === 1 && child.x0 >= r.x0 && child.x1 <= r.x1 && child.y0 >= r.y0 && child.y1 <= r.y1
  )
  return parent?.node ?? null
}

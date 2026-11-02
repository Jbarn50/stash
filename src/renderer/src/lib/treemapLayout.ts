import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy'
import type { ViewNode } from '../../../shared/types'

export interface TreemapRect {
  x0: number
  y0: number
  x1: number
  y1: number
  depth: number
  node: ViewNode
}

const sized = (n: ViewNode): ViewNode[] | undefined => {
  const kids = n.children?.filter((c) => c.sizeOnDisk > 0)
  return kids && kids.length > 0 ? kids : undefined
}

/**
 * A squarified treemap of a folder view. Every visible descendant gets a rect (the root itself does not);
 * zero-size nodes get none. Depth-1 folders keep a 16 px strip at the top for their label.
 */
export function layoutTreemap(root: ViewNode, width: number, height: number): TreemapRect[] {
  if (width <= 0 || height <= 0) return []
  const h = hierarchy<ViewNode>(root, sized).sum((n) => (sized(n) ? 0 : Math.max(0, n.sizeOnDisk)))
  if (!h.value) return []
  const laid = treemap<ViewNode>()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingInner(2)
    .paddingTop((d) => (d.depth === 1 && d.children ? 16 : 0))(h)
  return laid
    .descendants()
    .filter((d) => d.depth > 0 && (d.value ?? 0) > 0)
    .map((d) => ({ x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, depth: d.depth, node: d.data }))
}

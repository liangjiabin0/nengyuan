'use client';

import { useEffect, useRef } from 'react';
import { Graph, type IEvent } from '@antv/g6';
import type { GraphNode, GraphRelations } from '@/lib/graph-relations';

const TYPE_COLORS: Record<string, string> = {
  mentor: '#4f46e5',
  paper: '#0284c7',
  project: '#059669',
  entity: '#d97706',
  unknown: '#94a3b8'
};

const CLUSTER_COLORS = ['#2563eb', '#14b8a6', '#f97316', '#dc2626', '#8b5cf6', '#65a30d', '#0891b2', '#db2777'];

function nodeColor(node: GraphNode) {
  if (node.cluster !== undefined) return CLUSTER_COLORS[node.cluster % CLUSTER_COLORS.length];
  if (node.type === 'entity' && node.entityType) {
    if (node.entityType === 'person') return '#f59e0b';
    if (node.entityType === 'institution') return '#0d9488';
    if (node.entityType === 'keyword') return '#ea580c';
    if (node.entityType === 'algorithm') return '#7c3aed';
    if (node.entityType === 'discipline') return '#059669';
  }
  return TYPE_COLORS[node.type] || TYPE_COLORS.unknown;
}

export type KnowledgeGraphViewProps = {
  graph: GraphRelations | null;
  height?: number | string;
  onNodeClick?: (node: GraphNode) => void;
  className?: string;
  emptyText?: string;
};

/** 节点直径：连线越多越大，最大保持现有上限，连线少则明显更小 */
const GRAPH_MIN_NODE_SIZE = 10;
const GRAPH_MAX_NODE_SIZE = 26;
const GRAPH_NODE_SIZE = GRAPH_MIN_NODE_SIZE;
const GRAPH_FOCUS_NODE_SCALE = 1.32;
/** 滚轮/手势缩放区间：默认拉满上限，缩放下限也保持偏大 */
const GRAPH_ZOOM_RANGE: [number, number] = [1.4, 2];
const GRAPH_DEFAULT_ZOOM = GRAPH_ZOOM_RANGE[1];
const GRAPH_ZOOM_ANIMATION = { duration: 220, easing: 'out-cubic' } as const;
const GRAPH_ZOOM_SENSITIVITY = 0.42;
const GRAPH_LAYOUT = {
  type: 'd3-force' as const,
  preventOverlap: true,
  nodeSize: GRAPH_MAX_NODE_SIZE,
  linkDistance: 96,
  nodeStrength: -115,
  edgeStrength: 0.12,
  centerStrength: 0.025,
  x: { strength: 0.018 },
  y: { strength: 0.018 },
  collide: { radius: GRAPH_MAX_NODE_SIZE + 5, strength: 0.92, iterations: 2 },
  velocityDecay: 0.28,
  alphaDecay: 0.05,
  // 必须为 true：false 时布局会立刻 stop，引力/斥力与力导向拖拽都会失效
  animation: true
};

const EDGE_STROKE = '#cbd5e1';
const EDGE_STROKE_ACTIVE = '#94a3b8';
const EDGE_OPACITY = 0.7;
const EDGE_OPACITY_ACTIVE = 0.95;
const EDGE_OPACITY_INACTIVE = 0.06;
/** 悬停离开防抖：在节点间快速移动时避免反复全量重绘 */
const HOVER_LEAVE_MS = 48;

/** 悬停态动画：时长缩短；配合“只更新变化元素”避免全图堆积 */
const NODE_STATE_ANIMATION = [
  {
    shape: 'key' as const,
    fields: ['r', 'lineWidth'],
    duration: 280,
    easing: 'out-back'
  },
  {
    shape: 'key' as const,
    fields: ['fillOpacity', 'strokeOpacity'],
    duration: 200,
    easing: 'in-out-sine'
  },
  {
    shape: 'halo' as const,
    fields: ['strokeOpacity', 'lineWidth'],
    duration: 220,
    easing: 'out-cubic'
  },
  {
    shape: 'label' as const,
    fields: ['fillOpacity', 'strokeOpacity', 'fontSize'],
    duration: 180,
    easing: 'out-cubic'
  }
];

const EDGE_STATE_ANIMATION = [
  {
    shape: 'key' as const,
    fields: ['stroke', 'strokeOpacity', 'lineWidth'],
    duration: 200,
    easing: 'in-out-sine'
  }
];

function clampZoom(value: number) {
  return Math.min(GRAPH_ZOOM_RANGE[1], Math.max(GRAPH_ZOOM_RANGE[0], value));
}

function stateKey(states: string[]) {
  return states.length ? [...states].sort().join('|') : '';
}

function getNodeSizes(graph: GraphRelations) {
  const degreeById = new Map(graph.nodes.map((node) => [node.key, 0]));

  for (const edge of graph.edges) {
    degreeById.set(edge.source, (degreeById.get(edge.source) || 0) + 1);
    if (edge.target !== edge.source) {
      degreeById.set(edge.target, (degreeById.get(edge.target) || 0) + 1);
    }
  }

  const degrees = [...degreeById.values()];
  const minDegree = degrees.length ? Math.min(...degrees) : 0;
  const maxDegree = degrees.length ? Math.max(...degrees) : 0;
  const degreeRange = maxDegree - minDegree;

  return new Map(
    graph.nodes.map((node) => {
      const degree = degreeById.get(node.key) || 0;
      // sqrt 让中等连接度也能拉开层次，最高度数对应现有最大尺寸
      const ratio = degreeRange > 0 ? Math.sqrt((degree - minDegree) / degreeRange) : 0.55;
      const size = GRAPH_MIN_NODE_SIZE + (GRAPH_MAX_NODE_SIZE - GRAPH_MIN_NODE_SIZE) * ratio;
      return [node.key, Math.round(size * 10) / 10];
    })
  );
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getInitialPositions(nodes: GraphNode[], width: number, height: number) {
  const positions = new Map<string, { x: number; y: number }>();
  const ordered = [...nodes].sort((left, right) => hashString(left.key) - hashString(right.key));
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const radiusX = Math.max(180, width * 0.43);
  const radiusY = Math.max(150, height * 0.4);

  ordered.forEach((node, index) => {
    const radius = Math.sqrt((index + 0.7) / Math.max(1, ordered.length));
    const phase = ((hashString(node.key) % 31) / 31 - 0.5) * 0.22;
    const angle = index * goldenAngle + phase;
    positions.set(node.key, {
      x: width / 2 + Math.cos(angle) * radiusX * radius,
      y: height / 2 + Math.sin(angle) * radiusY * radius
    });
  });

  return positions;
}

function truncateLabel(label: string, max = 16) {
  return label.length > max ? `${label.slice(0, max)}…` : label;
}

function destroyGraphInstance(instance: Graph | null, container?: HTMLDivElement | null) {
  if (!instance) return;
  try {
    instance.destroy();
  } catch {
    // G6 force layout may throw during teardown (e.g. reading 'tick')
  }
  container?.replaceChildren();
}

export function KnowledgeGraphView({
  graph,
  height = 640,
  onNodeClick,
  className,
  emptyText = '暂无可绘制的图谱节点。请调整检索词、年份或最小共现阈值后重试。'
}: KnowledgeGraphViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !graph) return;

    let cancelled = false;
    let g: Graph | null = null;
    const abort = new AbortController();
    let hoverLeaveTimer: ReturnType<typeof setTimeout> | undefined;
    let zoomLockRaf = 0;
    let zoomLockActive = false;

    destroyGraphInstance(graphRef.current, container);
    graphRef.current = null;

    const edges = graph.edges.map((edge, index) => ({
      id: `${edge.source}-${edge.target}-${edge.relation}-${index}`,
      source: edge.source,
      target: edge.target,
      data: edge,
      style: {
        stroke: EDGE_STROKE,
        strokeOpacity: EDGE_OPACITY,
        lineWidth: Math.max(0.35, Math.min(1.05, edge.weight / 10 + 0.32))
      }
    }));
    const nodeSizes = getNodeSizes(graph);

    void (async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (cancelled || !containerRef.current) return;

      const width = container.clientWidth || 900;
      const heightPx = typeof height === 'number' ? height : Math.max(container.clientHeight || 0, 640);
      const initialPositions = getInitialPositions(graph.nodes, width, heightPx);
      const nodes = graph.nodes.map((node) => ({
        id: node.key,
        data: node,
        style: {
          ...initialPositions.get(node.key),
          size: nodeSizes.get(node.key) || GRAPH_NODE_SIZE,
          fill: nodeColor(node),
          stroke: '#ffffff',
          lineWidth: 1,
          cursor: 'grab' as const,
          labelText: truncateLabel(node.label, node.entityType === 'person' ? 8 : 16),
          labelFill: '#334155',
          labelStroke: '#ffffff',
          labelLineWidth: 2,
          labelFontSize: 9,
          labelPlacement: 'bottom' as const,
          labelOffsetY: 5,
          labelPointerEvents: 'none' as const
        }
      }));

      const edgeIds = edges.map((edge) => edge.id as string);
      const nodeIds = graph.nodes.map((node) => node.key);
      let hoveredNodeId: string | null = null;
      const committedStateKeys = new Map<string, string>();

      const buildIdleStates = () => {
        const states: Record<string, string[]> = {};
        for (const id of nodeIds) states[id] = [];
        for (const id of edgeIds) states[id] = [];
        return states;
      };

      const applyStatesDiff = (nextStates: Record<string, string[]>, animate: boolean) => {
        if (!g) return;
        const patch: Record<string, string[]> = {};
        for (const [id, states] of Object.entries(nextStates)) {
          const key = stateKey(states);
          if (committedStateKeys.get(id) === key) continue;
          patch[id] = states;
          committedStateKeys.set(id, key);
        }
        if (!Object.keys(patch).length) return;
        // 只更新变化的元素，并保留短动画；避免全图每次重跑导致卡顿
        void g.setElementState(patch, animate);
      };

      const applyNodeHover = (nodeId: string) => {
        if (!g || hoveredNodeId === nodeId) return;
        hoveredNodeId = nodeId;

        const neighborIds = new Set(
          (g.getNeighborNodesData(nodeId) || []).map((item) => String(item.id ?? ''))
        );
        neighborIds.delete('');
        const relatedEdgeIds = new Set(
          (g.getRelatedEdgesData(nodeId, 'both') || []).map((item) => String(item.id ?? ''))
        );
        relatedEdgeIds.delete('');

        const states: Record<string, string[]> = {};
        for (const id of nodeIds) {
          if (id === nodeId) states[id] = ['active', 'focus'];
          else if (neighborIds.has(id)) states[id] = ['active'];
          else states[id] = ['inactive'];
        }
        for (const id of edgeIds) {
          states[id] = relatedEdgeIds.has(id) ? ['active'] : ['inactive'];
        }

        applyStatesDiff(states, true);
      };

      const clearNodeHover = (nodeId?: string) => {
        if (!g) return;
        if (nodeId && hoveredNodeId && nodeId !== hoveredNodeId) return;
        hoveredNodeId = null;
        applyStatesDiff(buildIdleStates(), true);
      };

      const zoomFromWheel = (event: WheelEvent) => {
        if (!g || zoomLockActive) return;
        event.preventDefault();
        const rect = container.getBoundingClientRect();
        const origin: [number, number] = [event.clientX - rect.left, event.clientY - rect.top];
        const delta = -(event.deltaY || event.deltaX || 0);
        const clamped = Math.max(-50, Math.min(50, delta));
        const ratio = 1 + (clamped * GRAPH_ZOOM_SENSITIVITY) / 100;
        const nextZoom = clampZoom(g.getZoom() * ratio);
        if (Math.abs(nextZoom - g.getZoom()) < 0.0001) return;
        void g.zoomTo(nextZoom, { ...GRAPH_ZOOM_ANIMATION }, origin);
      };

      const ensureMaxZoom = () => {
        if (!g || cancelled) return;
        try {
          const zoom = g.getZoom();
          if (!Number.isFinite(zoom) || Math.abs(zoom - GRAPH_DEFAULT_ZOOM) > 0.01) {
            void g.zoomTo(GRAPH_DEFAULT_ZOOM, false);
          }
        } catch {
          // ignore during teardown
        }
      };

      const startZoomLock = () => {
        zoomLockActive = true;
        const tick = () => {
          if (cancelled || !zoomLockActive || !g) return;
          ensureMaxZoom();
          zoomLockRaf = window.requestAnimationFrame(tick);
        };
        zoomLockRaf = window.requestAnimationFrame(tick);
      };

      const stopZoomLock = () => {
        zoomLockActive = false;
        if (zoomLockRaf) {
          window.cancelAnimationFrame(zoomLockRaf);
          zoomLockRaf = 0;
        }
      };

      g = new Graph({
        container,
        width,
        height: heightPx,
        autoResize: true,
        zoomRange: GRAPH_ZOOM_RANGE,
        animation: { duration: 220, easing: 'out-cubic' },
        data: { nodes, edges },
        node: {
          type: 'circle',
          style: {
            opacity: 1,
            fillOpacity: 1,
            strokeOpacity: 1,
            halo: false,
            haloLineWidth: 0,
            haloStrokeOpacity: 0
          },
          state: {
            active: {
              halo: false,
              fillOpacity: 1,
              strokeOpacity: 1,
              labelFillOpacity: 1,
              labelStrokeOpacity: 1
            },
            focus: (datum) => {
              const node = datum.data as unknown as GraphNode;
              const nodeSize = nodeSizes.get(node.key) || GRAPH_NODE_SIZE;
              return {
                size: nodeSize * GRAPH_FOCUS_NODE_SCALE,
                lineWidth: 1.6,
                stroke: '#ffffff',
                fillOpacity: 1,
                strokeOpacity: 1,
                halo: true,
                haloStroke: nodeColor(node),
                haloStrokeOpacity: 0.34,
                haloLineWidth: 11,
                labelFontSize: 10,
                labelFontWeight: 600,
                labelFillOpacity: 1,
                labelStrokeOpacity: 1,
                zIndex: 10
              };
            },
            inactive: {
              fillOpacity: 0.22,
              strokeOpacity: 0.18,
              labelFillOpacity: 0.2,
              labelStrokeOpacity: 0.24,
              halo: false,
              haloStrokeOpacity: 0,
              haloLineWidth: 0
            }
          },
          animation: {
            enter: false,
            update: false,
            state: NODE_STATE_ANIMATION
          }
        },
        edge: {
          type: 'line',
          style: {
            stroke: EDGE_STROKE,
            strokeOpacity: EDGE_OPACITY,
            opacity: 1
          },
          state: {
            active: {
              halo: false,
              stroke: EDGE_STROKE_ACTIVE,
              strokeOpacity: EDGE_OPACITY_ACTIVE,
              lineWidth: 0.9,
              zIndex: 5
            },
            inactive: {
              // 盖住主题 inactive 换色，保证从原色淡出
              stroke: EDGE_STROKE,
              strokeOpacity: EDGE_OPACITY_INACTIVE
            }
          },
          animation: {
            enter: false,
            update: false,
            state: EDGE_STATE_ANIMATION
          }
        },
        layout: GRAPH_LAYOUT,
        behaviors: [
          {
            // 与 d3-force 联动：拖拽时重启仿真，保留引力/斥力
            type: 'drag-element-force',
            enable: (event: { targetType?: string }) => event.targetType === 'node',
            fixed: true
          },
          'drag-canvas'
        ],
        padding: 40
      });

      const eventTargetId = (event: IEvent) => {
        if (!('target' in event) || !event.target || typeof event.target !== 'object') return '';
        return 'id' in event.target ? String(event.target.id || '') : '';
      };
      const onNodePointerEnter = (event: IEvent) => {
        const id = eventTargetId(event);
        if (!id) return;
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
          hoverLeaveTimer = undefined;
        }
        applyNodeHover(id);
      };
      const onNodePointerLeave = (event: IEvent) => {
        const id = eventTargetId(event);
        if (!id) return;
        if (hoverLeaveTimer) clearTimeout(hoverLeaveTimer);
        hoverLeaveTimer = setTimeout(() => {
          hoverLeaveTimer = undefined;
          clearNodeHover(id);
        }, HOVER_LEAVE_MS);
      };

      g.on('node:pointerenter', onNodePointerEnter);
      g.on('node:pointerleave', onNodePointerLeave);
      g.on('afterrender', ensureMaxZoom);

      container.addEventListener('wheel', zoomFromWheel, { passive: false, signal: abort.signal });

      let layoutSettled = false;
      const finishInitialViewport = () => {
        if (cancelled || layoutSettled || !g) return;
        layoutSettled = true;
        stopZoomLock();
        ensureMaxZoom();
        try {
          void g.fitCenter(false);
        } catch {
          // ignore
        }
      };

      g.on('afterlayout', () => {
        finishInitialViewport();
      });

      g.on('node:click', (event) => {
        const target = (event as { target?: { id?: string } }).target;
        const id = target?.id;
        if (!id || !onNodeClickRef.current) return;
        const node = graph.nodes.find((n) => n.key === id);
        if (node) onNodeClickRef.current(node);
      });

      try {
        // 布局期间持续锁定最大缩放，杜绝首屏偏小、数秒后突然放大
        startZoomLock();
        ensureMaxZoom();
        await g.render();
        if (cancelled) {
          stopZoomLock();
          destroyGraphInstance(g, container);
          return;
        }
        graphRef.current = g;
        ensureMaxZoom();
        await g.fitCenter(false);
        ensureMaxZoom();
      } catch (error) {
        console.error('[KnowledgeGraphView] render failed', error);
        stopZoomLock();
        destroyGraphInstance(g, container);
      }
    })();

    return () => {
      cancelled = true;
      zoomLockActive = false;
      if (zoomLockRaf) window.cancelAnimationFrame(zoomLockRaf);
      if (hoverLeaveTimer) clearTimeout(hoverLeaveTimer);
      abort.abort();
      destroyGraphInstance(graphRef.current, container);
      graphRef.current = null;
    };
  }, [graph, height]);

  const fillParent = typeof height === 'string';

  if (!graph || (!graph.nodes.length && !graph.edges.length)) {
    return (
      <div
        className={`flex items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500 ${fillParent ? 'h-full min-h-[640px]' : ''} ${className || ''}`}
        style={fillParent ? undefined : { height }}
      >
        {emptyText}
      </div>
    );
  }

  return (
    <div className={`overflow-hidden rounded-xl border border-slate-200 bg-white ${fillParent ? 'h-full min-h-[640px]' : ''} ${className || ''}`}>
      <div
        ref={containerRef}
        className={fillParent ? 'h-full w-full min-h-[640px]' : undefined}
        style={fillParent ? { width: '100%', height: '100%' } : { height, width: '100%' }}
      />
    </div>
  );
}

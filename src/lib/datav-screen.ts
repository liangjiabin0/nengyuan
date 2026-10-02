import fs from 'node:fs';
import path from 'node:path';
import type { DbSummaryPayload } from '@/lib/db-summary';
import { metricValue } from '@/lib/dashboard-metrics';
import { FLYING_LINE_LAYERS, getMentorFlyingNetwork, type FlyingLineBucket } from '@/lib/datav-mentor-geo';
import { formatNumber } from '@/lib/utils';

export const DATAV_SHARE_ID = 'f876cc78fb12e315dc169f13f51ed275';

const GEO_API = {
  topojson: '/datav/geo/china_all_datav_drill.json',
  worldBorder: '/datav/geo/world_land_boundary.json',
  chinaBorder: '/datav/geo/100000_boundary.json'
} as const;

type Layer = {
  id?: string;
  hide?: boolean;
  parent?: string;
  children?: string[];
  attr?: { opacity?: number; x?: number; y?: number; w?: number; h?: number };
  config?: {
    content?: string;
    title?: { content?: string };
    counter?: {
      suffix?: { content?: string };
      numbers?: { decimal?: number; rounding?: boolean };
    };
    options?: {
      animation?: { outOfOrder?: boolean; dashSpeed0?: number; dashSpeed1?: number };
    };
  };
  data?: {
    source?: {
      handler?: string;
      data?: Array<{ name: string; value: number }>;
      dcConfig?: Record<string, unknown>;
      autoUpdate?: number;
      fields?: unknown;
    };
  };
};

const PLANE_ID = '@datav-3d-v3_datav-3dplane_2a7GL';
const BUBBLE_ID = '@datav-3d-v3_datav-3dplane-bubbles_fDVyw';

function setFlyingLineSpeed(layer: Layer | undefined, speed: number) {
  const animation = layer?.config?.options?.animation;
  if (!animation) return;
  animation.outOfOrder = false;
  animation.dashSpeed0 = speed;
  animation.dashSpeed1 = speed;
}

function attachFlyingLineLayers(layers: Record<string, Layer>) {
  const sourceId = FLYING_LINE_LAYERS.fast.id;
  const source = layers[sourceId];
  if (!source) return;

  const plane = layers[PLANE_ID];
  const extraIds: string[] = [];
  for (const [bucket, spec] of Object.entries(FLYING_LINE_LAYERS) as Array<[FlyingLineBucket, { id: string; speed: number }]>) {
    if (bucket === 'fast') {
      setFlyingLineSpeed(source, spec.speed);
      continue;
    }
    const clone = JSON.parse(JSON.stringify(source)) as Layer;
    clone.id = spec.id;
    clone.parent = PLANE_ID;
    clone.children = [];
    setFlyingLineSpeed(clone, spec.speed);
    layers[spec.id] = clone;
    extraIds.push(spec.id);
  }

  if (plane?.children) {
    const next = plane.children.filter((id) => id === sourceId || id === BUBBLE_ID || extraIds.includes(id));
    const bubbleAt = next.indexOf(BUBBLE_ID);
    let insertAt = bubbleAt >= 0 ? bubbleAt : next.length;
    for (const id of extraIds) {
      if (!next.includes(id)) {
        next.splice(insertAt, 0, id);
        insertAt += 1;
      }
    }
    plane.children = next;
  }
}

function loadBaseConfig() {
  const file = path.join(process.cwd(), 'src', 'lib', 'datav-logistics-config.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as {
    name: string;
    usePageFilter: boolean;
    pageFilters: Record<string, string>;
    scenes: Array<{ layers: Record<string, Layer> }>;
  };
}

function screenMetrics(summary: DbSummaryPayload | null) {
  return {
    papers: metricValue(summary?.papers),
    patents: metricValue(summary?.patents),
    books: metricValue(summary?.books ?? summary?.whitepapers),
    mentors: metricValue(summary?.mentors),
    edges: metricValue(summary?.stats.edges),
    entities: metricValue(summary?.stats.entities),
    terms: metricValue(summary?.indexStats.searchTerms),
    records: metricValue(summary?.indexStats.searchRecords)
  };
}

const BOTTOM_METRICS: Array<{
  flopId: string;
  groupId: string;
  title: string;
  suffix: string;
  key: keyof ReturnType<typeof screenMetrics>;
}> = [
  { flopId: '数字翻牌器_7kP31', groupId: 'group_yV83l', title: '论文', suffix: '篇', key: 'papers' },
  { flopId: '数字翻牌器_RmNeG', groupId: 'group_jYzDy', title: '专利', suffix: '件', key: 'patents' },
  { flopId: '数字翻牌器_F3Hoc', groupId: 'group_8vkC8', title: '书籍', suffix: '份', key: 'books' },
  { flopId: '数字翻牌器_KN5iu', groupId: 'group_NCB6A', title: '检索词项', suffix: '项', key: 'terms' },
  { flopId: '数字翻牌器_OiGcg', groupId: 'group_4CcL7', title: '知识实体', suffix: '个', key: 'entities' },
  { flopId: '数字翻牌器_hJj8Z', groupId: 'group_6glWR', title: '索引记录', suffix: '条', key: 'records' }
];

function columnWidth(title: string, value: number, suffix: string) {
  const titleW = title.length * 12;
  const valueW = formatNumber(value).length * 14 + (suffix ? 16 : 0);
  return Math.max(48, titleW, valueW) + 20;
}

function layoutBottomIcons(layers: Record<string, Layer>, metrics: ReturnType<typeof screenMetrics>) {
  let cursor = 0;
  const gap = 12;
  const iconSize = 37;
  for (const item of BOTTOM_METRICS) {
    const width = columnWidth(item.title, metrics[item.key], item.suffix);
    const flop = layers[item.flopId];
    if (flop?.attr) {
      flop.attr.x = cursor;
      flop.attr.w = width;
    }
    const group = layers[item.groupId];
    if (group?.attr) {
      group.attr.x = Math.round(cursor + (width - iconSize) / 2);
    }
    cursor += width + gap;
  }
}

function setFlop(layer: Layer | undefined, title: string, value: number, suffix?: string) {
  if (!layer) return;
  if (layer.config?.title) layer.config.title.content = title;
  if (suffix !== undefined && layer.config?.counter?.suffix) {
    layer.config.counter.suffix.content = suffix;
  }
  if (layer.config?.counter?.numbers) {
    layer.config.counter.numbers.decimal = 0;
    layer.config.counter.numbers.rounding = true;
  }
  const source = layer.data?.source || {};
  layer.data = {
    ...layer.data,
    source: {
      ...source,
      handler: 'render',
      data: [{ name: title, value }],
      autoUpdate: 0,
      dcConfig: {
        ...(source.dcConfig || {}),
        type: 'static',
        useFilter: false,
        pageFilters: [],
        filters: []
      }
    }
  };
}

export function buildDatavScreenConfig(summary: DbSummaryPayload | null) {
  const cfg = loadBaseConfig();
  const layers = cfg.scenes[0].layers;
  const metrics = screenMetrics(summary);

  cfg.name = '能元平台运行监测';
  cfg.usePageFilter = false;
  cfg.pageFilters = {};

  if (layers['main-title_z4BMY']?.config) {
    layers['main-title_z4BMY'].config.content = '能元平台运行监测 &gt;';
  }
  if (layers['main-title_Tyw9S']?.config) {
    layers['main-title_Tyw9S'].config.content = 'Nengyuan platform monitoring screen';
  }
  if (layers['通用标题_PEZWu']?.config) {
    layers['通用标题_PEZWu'].config.content = '资源与检索详情';
  }
  if (layers['main-img_zkkw3']) {
    layers['main-img_zkkw3'].hide = true;
    if (layers['main-img_zkkw3'].attr) layers['main-img_zkkw3'].attr.opacity = 0;
  }

  setFlop(layers['number-title-flop_sW6jO'], '关系边', metrics.edges, '条');
  setFlop(layers['number-title-flop_tFxVq'], '论文', metrics.papers, '');
  setFlop(layers['number-title-flop_GNAdz'], '导师', metrics.mentors, '');
  setFlop(layers['number-title-flop_L6Brg'], '专利', metrics.patents, '');
  setFlop(layers['number-title-flop_SOEze'], '书籍', metrics.books, '');

  setFlop(layers['数字翻牌器_7kP31'], '论文', metrics.papers, '篇');
  setFlop(layers['数字翻牌器_RmNeG'], '专利', metrics.patents, '件');
  setFlop(layers['数字翻牌器_F3Hoc'], '书籍', metrics.books, '份');
  setFlop(layers['数字翻牌器_KN5iu'], '检索词项', metrics.terms, '项');
  setFlop(layers['数字翻牌器_OiGcg'], '知识实体', metrics.entities, '个');
  setFlop(layers['数字翻牌器_hJj8Z'], '索引记录', metrics.records, '条');
  layoutBottomIcons(layers, metrics);
  attachFlyingLineLayers(layers);

  return cfg;
}

function flop(name: string, value: number) {
  return [{ name, value }];
}

function title(value: string) {
  return [{ value }];
}

function geoRedirect(url: string, origin: string) {
  // DataV's redirect handler expects an absolute URL, even for local assets.
  return { type: 'api', method: 'GET', redirect: new URL(url, origin).href };
}

export async function buildDatavDcPayload(summary: DbSummaryPayload | null, origin: string): Promise<Record<string, unknown>> {
  const metrics = screenMetrics(summary);
  const flying = await getMentorFlyingNetwork();
  return {
    'number-title-flop_sW6jO.source': flop('关系边', metrics.edges),
    'number-title-flop_tFxVq.source': flop('论文', metrics.papers),
    'number-title-flop_GNAdz.source': flop('导师', metrics.mentors),
    'number-title-flop_L6Brg.source': flop('专利', metrics.patents),
    'number-title-flop_SOEze.source': flop('书籍', metrics.books),
    '数字翻牌器_7kP31.source': flop('论文', metrics.papers),
    '数字翻牌器_RmNeG.source': flop('专利', metrics.patents),
    '数字翻牌器_F3Hoc.source': flop('书籍', metrics.books),
    '数字翻牌器_KN5iu.source': flop('检索词项', metrics.terms),
    '数字翻牌器_OiGcg.source': flop('知识实体', metrics.entities),
    '数字翻牌器_hJj8Z.source': flop('索引记录', metrics.records),
    'main-title_z4BMY.source': title('能元平台运行监测 >'),
    'main-title_Tyw9S.source': title('Nengyuan platform monitoring screen'),
    '通用标题_PEZWu.source': title('资源与检索详情'),
    'main-title_rodUw.source': title('OCT'),
    'main-title_xh60C.source': title('南海诸岛'),
    '@datav-3d-v3_datav-3dplane_2a7GL.topojson': geoRedirect(GEO_API.topojson, origin),
    '@datav-3d-v3_datav-3dplane_2a7GL.worldBorder': geoRedirect(GEO_API.worldBorder, origin),
    '@datav-3d-v3_datav-3dplane_2a7GL.chinaBorder': geoRedirect(GEO_API.chinaBorder, origin),
    [`${FLYING_LINE_LAYERS.fast.id}.dataSource`]: flying.buckets.fast,
    [`${FLYING_LINE_LAYERS.mid.id}.dataSource`]: flying.buckets.mid,
    [`${FLYING_LINE_LAYERS.slow.id}.dataSource`]: flying.buckets.slow,
    [`${BUBBLE_ID}.dataSource`]: flying.bubbles
  };
}

export async function answerDatavDcQuery(query: string, summary: DbSummaryPayload | null, origin: string) {
  const payload = await buildDatavDcPayload(summary, origin);
  const result: Record<string, unknown> = {};
  for (const item of query.split('~|#').filter(Boolean)) {
    const apiName = decodeURIComponent(item.split('?')[0] || '');
    result[item] = Object.prototype.hasOwnProperty.call(payload, apiName) ? payload[apiName] : [];
  }
  return result;
}

export function wrapDatavCubeConfig(cfg: unknown) {
  return `Cube("main:/config.js", [], function (module, exports, require, load, __dirname, __filename) {module.exports = ${JSON.stringify(cfg)};\nreturn module.exports;});`;
}

export function wrapDatavCubeHook() {
  return `Cube("main:/hook.js", [], function (module, exports, require, load, __dirname, __filename) {\nreturn module.exports;});`;
}

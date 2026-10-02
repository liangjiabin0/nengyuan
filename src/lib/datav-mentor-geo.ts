import { all } from './db';

export type MentorCity = {
  name: string;
  count: number;
  coord: [number, number];
};

export type FlyingLine = {
  geometry: { type: 'LineString'; coordinates: [[number, number], [number, number]] };
  name: string;
};

export type FlyingBubble = {
  id: string;
  lng: number;
  lat: number;
  name: string;
  radiusField: number;
};

export type FlyingLineBucket = 'fast' | 'mid' | 'slow';

export const FLYING_LINE_LAYERS: Record<FlyingLineBucket, { id: string; speed: number }> = {
  fast: { id: '@datav-3d-v3_datav-3dplane-od-flyingline_D7C93', speed: 16.7 },
  mid: { id: '@datav-3d-v3_datav-3dplane-od-flyingline_spdM', speed: 10 },
  slow: { id: '@datav-3d-v3_datav-3dplane-od-flyingline_spdS', speed: 5.2 }
};

export type FlyingNetwork = {
  at: number;
  lines: FlyingLine[];
  buckets: Record<FlyingLineBucket, FlyingLine[]>;
  bubbles: FlyingBubble[];
};

const HUB_CITY = '太原';
const MAINLAND_PROVINCES = 31;
const MIN_LINKED_PROVINCES = Math.ceil(MAINLAND_PROVINCES / 2);

const SCHOOL_CITY: Record<string, string> = {
  清华大学: '北京',
  北京大学: '北京',
  中国人民大学: '北京',
  北京师范大学: '北京',
  北京航空航天大学: '北京',
  北京理工大学: '北京',
  北京科技大学: '北京',
  北京交通大学: '北京',
  北京邮电大学: '北京',
  北京工业大学: '北京',
  中国农业大学: '北京',
  北京林业大学: '北京',
  中国科学院大学: '北京',
  中国科学院: '北京',
  华北电力大学: '北京',
  北京化工大学: '北京',
  中国石油大学: '北京',
  中国地质大学: '北京',
  中国矿业大学: '北京',
  首都师范大学: '北京',
  首都医科大学: '北京',
  中央民族大学: '北京',
  复旦大学: '上海',
  上海交通大学: '上海',
  同济大学: '上海',
  华东师范大学: '上海',
  华东理工大学: '上海',
  上海大学: '上海',
  东华大学: '上海',
  上海理工大学: '上海',
  上海师范大学: '上海',
  上海电力大学: '上海',
  浙江大学: '杭州',
  杭州电子科技大学: '杭州',
  浙江工业大学: '杭州',
  浙江理工大学: '杭州',
  浙江工商大学: '杭州',
  南京大学: '南京',
  东南大学: '南京',
  河海大学: '南京',
  南京理工大学: '南京',
  南京航空航天大学: '南京',
  南京师范大学: '南京',
  南京邮电大学: '南京',
  南京工业大学: '南京',
  南京农业大学: '南京',
  中国药科大学: '南京',
  中国科学技术大学: '合肥',
  合肥工业大学: '合肥',
  安徽大学: '合肥',
  安徽工业大学: '马鞍山',
  武汉大学: '武汉',
  华中科技大学: '武汉',
  武汉理工大学: '武汉',
  华中农业大学: '武汉',
  华中师范大学: '武汉',
  中南财经政法大学: '武汉',
  中山大学: '广州',
  华南理工大学: '广州',
  暨南大学: '广州',
  华南师范大学: '广州',
  华南农业大学: '广州',
  广东工业大学: '广州',
  西安交通大学: '西安',
  西北工业大学: '西安',
  西安电子科技大学: '西安',
  长安大学: '西安',
  陕西师范大学: '西安',
  西北大学: '西安',
  西安理工大学: '西安',
  西安建筑科技大学: '西安',
  西北农林科技大学: '西安',
  四川大学: '成都',
  电子科技大学: '成都',
  西南交通大学: '成都',
  成都理工大学: '成都',
  西南财经大学: '成都',
  重庆大学: '重庆',
  西南大学: '重庆',
  重庆邮电大学: '重庆',
  天津大学: '天津',
  南开大学: '天津',
  河北工业大学: '天津',
  天津工业大学: '天津',
  哈尔滨工业大学深圳: '深圳',
  哈尔滨工业大学: '哈尔滨',
  哈尔滨工程大学: '哈尔滨',
  东北林业大学: '哈尔滨',
  东北农业大学: '哈尔滨',
  吉林大学: '长春',
  东北师范大学: '长春',
  长春理工大学: '长春',
  东北电力大学: '吉林',
  东北大学: '沈阳',
  辽宁大学: '沈阳',
  沈阳工业大学: '沈阳',
  大连理工大学: '大连',
  大连海事大学: '大连',
  东北财经大学: '大连',
  山东大学: '济南',
  齐鲁工业大学: '济南',
  济南大学: '济南',
  山东师范大学: '济南',
  中国海洋大学: '青岛',
  青岛大学: '青岛',
  青岛科技大学: '青岛',
  厦门大学: '厦门',
  福州大学: '福州',
  福建师范大学: '福州',
  中南大学: '长沙',
  湖南大学: '长沙',
  湖南师范大学: '长沙',
  长沙理工大学: '长沙',
  郑州大学: '郑州',
  河南工业大学: '郑州',
  河南大学: '开封',
  河南理工大学: '焦作',
  南昌大学: '南昌',
  华东交通大学: '南昌',
  江西理工大学: '赣州',
  太原理工大学: '太原',
  山西大学: '太原',
  中北大学: '太原',
  山西能源学院: '太原',
  山西师范大学: '太原',
  燕山大学: '秦皇岛',
  河北科技大学: '石家庄',
  河北师范大学: '石家庄',
  石家庄铁道大学: '石家庄',
  河北医科大学: '石家庄',
  河北大学: '保定',
  兰州大学: '兰州',
  西北师范大学: '兰州',
  云南大学: '昆明',
  昆明理工大学: '昆明',
  广西大学: '南宁',
  桂林电子科技大学: '桂林',
  广西师范大学: '桂林',
  贵州大学: '贵阳',
  贵州师范大学: '贵阳',
  新疆大学: '乌鲁木齐',
  石河子大学: '乌鲁木齐',
  宁夏大学: '银川',
  北方民族大学: '银川',
  青海大学: '西宁',
  青海师范大学: '西宁',
  西藏大学: '拉萨',
  西藏农牧学院: '拉萨',
  海南大学: '海口',
  海南师范大学: '海口',
  内蒙古大学: '呼和浩特',
  内蒙古工业大学: '呼和浩特',
  苏州大学: '苏州',
  西交利物浦大学: '苏州',
  江南大学: '无锡',
  江苏大学: '镇江',
  扬州大学: '扬州',
  深圳大学: '深圳',
  南方科技大学: '深圳',
  三峡大学: '宜昌',
  宁波大学: '宁波'
};

const CITY_COORDS: Record<string, [number, number]> = {
  北京: [116.4074, 39.9042],
  上海: [121.4737, 31.2304],
  天津: [117.2008, 39.0842],
  重庆: [106.5516, 29.563],
  哈尔滨: [126.535, 45.8023],
  长春: [125.3235, 43.8171],
  沈阳: [123.4315, 41.8057],
  大连: [121.6147, 38.914],
  石家庄: [114.5149, 38.0428],
  太原: [112.5489, 37.8706],
  呼和浩特: [111.749, 40.8426],
  济南: [117.1201, 36.6512],
  青岛: [120.3826, 36.0671],
  南京: [118.7969, 32.0603],
  杭州: [120.1551, 30.2741],
  合肥: [117.2272, 31.8206],
  福州: [119.2965, 26.0745],
  厦门: [118.0894, 24.4798],
  南昌: [115.8581, 28.6832],
  郑州: [113.6254, 34.7466],
  武汉: [114.3054, 30.5931],
  长沙: [112.9388, 28.2282],
  广州: [113.2644, 23.1291],
  深圳: [114.0579, 22.5431],
  南宁: [108.3661, 22.8172],
  海口: [110.1983, 20.044],
  成都: [104.0665, 30.5723],
  贵阳: [106.6302, 26.6477],
  昆明: [102.8329, 25.047],
  拉萨: [91.1409, 29.6456],
  西安: [108.9398, 34.3416],
  兰州: [103.8343, 36.0611],
  西宁: [101.7782, 36.6171],
  银川: [106.2309, 38.4872],
  乌鲁木齐: [87.6168, 43.8256],
  苏州: [120.5853, 31.2989],
  无锡: [120.3119, 31.4912],
  宁波: [121.544, 29.8683],
  秦皇岛: [119.6005, 39.9354],
  宜昌: [111.2865, 30.6919],
  保定: [115.4648, 38.8739],
  开封: [114.3076, 34.797],
  焦作: [113.242, 35.2159],
  镇江: [119.4528, 32.2044],
  扬州: [119.4129, 32.3936],
  吉林: [126.5496, 43.8378],
  马鞍山: [118.5068, 31.6705],
  赣州: [114.9336, 25.8307],
  桂林: [110.2902, 25.2736]
};

const CITY_PROVINCE: Record<string, string> = {
  北京: '北京',
  天津: '天津',
  石家庄: '河北',
  秦皇岛: '河北',
  保定: '河北',
  太原: '山西',
  呼和浩特: '内蒙古',
  沈阳: '辽宁',
  大连: '辽宁',
  长春: '吉林',
  吉林: '吉林',
  哈尔滨: '黑龙江',
  上海: '上海',
  南京: '江苏',
  苏州: '江苏',
  无锡: '江苏',
  镇江: '江苏',
  扬州: '江苏',
  杭州: '浙江',
  宁波: '浙江',
  合肥: '安徽',
  马鞍山: '安徽',
  福州: '福建',
  厦门: '福建',
  南昌: '江西',
  赣州: '江西',
  济南: '山东',
  青岛: '山东',
  郑州: '河南',
  开封: '河南',
  焦作: '河南',
  武汉: '湖北',
  宜昌: '湖北',
  长沙: '湖南',
  广州: '广东',
  深圳: '广东',
  南宁: '广西',
  桂林: '广西',
  海口: '海南',
  重庆: '重庆',
  成都: '四川',
  贵阳: '贵州',
  昆明: '云南',
  拉萨: '西藏',
  西安: '陕西',
  兰州: '甘肃',
  西宁: '青海',
  银川: '宁夏',
  乌鲁木齐: '新疆'
};

const PROVINCE_CAPITAL: Record<string, string> = {
  北京: '北京',
  天津: '天津',
  河北: '石家庄',
  山西: '太原',
  内蒙古: '呼和浩特',
  辽宁: '沈阳',
  吉林: '长春',
  黑龙江: '哈尔滨',
  上海: '上海',
  江苏: '南京',
  浙江: '杭州',
  安徽: '合肥',
  福建: '福州',
  江西: '南昌',
  山东: '济南',
  河南: '郑州',
  湖北: '武汉',
  湖南: '长沙',
  广东: '广州',
  广西: '南宁',
  海南: '海口',
  重庆: '重庆',
  四川: '成都',
  贵州: '贵阳',
  云南: '昆明',
  西藏: '拉萨',
  陕西: '西安',
  甘肃: '兰州',
  青海: '西宁',
  宁夏: '银川',
  新疆: '乌鲁木齐'
};

const CITY_NAMES = Object.keys(CITY_COORDS).sort((a, b) => b.length - a.length);
const SCHOOL_NAMES = Object.keys(SCHOOL_CITY).sort((a, b) => b.length - a.length);
const CACHE_MS = 10 * 60 * 1000;

let cache: FlyingNetwork | null = null;

function normalizeSchool(raw: string) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const first = text.split(/[-+_|／/]/)[0]?.trim() || '';
  const match = first.match(/^([\u4e00-\u9fa5A-Za-z0-9（）()]{2,24}(?:大学|学院|研究院|研究所))/);
  return (match?.[1] || '').replace(/[（(].*$/, '');
}

function cityOf(school: string) {
  if (!school) return '';
  if (SCHOOL_CITY[school]) return SCHOOL_CITY[school];
  for (const name of SCHOOL_NAMES) {
    if (school.startsWith(name) || school.includes(name)) return SCHOOL_CITY[name];
  }
  for (const city of CITY_NAMES) {
    if (school.includes(city)) return city;
  }
  return '';
}

function toLine(from: MentorCity, to: MentorCity): FlyingLine {
  return {
    geometry: {
      type: 'LineString',
      coordinates: [from.coord, to.coord]
    },
    name: `${from.name}→${to.name}`
  };
}

function emptyBuckets(): Record<FlyingLineBucket, FlyingLine[]> {
  return { fast: [], mid: [], slow: [] };
}

function hubCity(cities: MentorCity[]): MentorCity {
  return (
    cities.find((city) => city.name === HUB_CITY) || {
      name: HUB_CITY,
      count: 0,
      coord: CITY_COORDS[HUB_CITY]
    }
  );
}

function pickProvinceCities(cities: MentorCity[]) {
  const best = new Map<string, MentorCity>();
  for (const city of cities) {
    const province = CITY_PROVINCE[city.name];
    if (!province || province === CITY_PROVINCE[HUB_CITY]) continue;
    const prev = best.get(province);
    if (!prev || city.count > prev.count) best.set(province, city);
  }
  return best;
}

function fillMissingProvinces(best: Map<string, MentorCity>, byName: Map<string, MentorCity>) {
  if (best.size + 1 >= MIN_LINKED_PROVINCES) return;
  for (const [province, capital] of Object.entries(PROVINCE_CAPITAL)) {
    if (province === CITY_PROVINCE[HUB_CITY] || best.has(province)) continue;
    const coord = CITY_COORDS[capital];
    if (!coord) continue;
    const existing = byName.get(capital);
    best.set(province, existing || { name: capital, count: 1, coord });
    if (best.size + 1 >= MIN_LINKED_PROVINCES) break;
  }
}

function speedBucket(index: number, total: number): FlyingLineBucket {
  if (total <= 1) return 'fast';
  const ratio = index / (total - 1);
  if (ratio <= 0.33) return 'fast';
  if (ratio <= 0.66) return 'mid';
  return 'slow';
}

export async function loadMentorCities(): Promise<MentorCity[]> {
  const rows = await all<{ school: string; c: number }>(
    `SELECT COALESCE(school, '') AS school, COUNT(*) AS c
     FROM mentor_profiles
     GROUP BY school`
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    const school = normalizeSchool(row.school) || row.school;
    const city = cityOf(school);
    if (!city || !CITY_COORDS[city]) continue;
    counts.set(city, (counts.get(city) || 0) + Number(row.c || 0));
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count, coord: CITY_COORDS[name] }))
    .sort((a, b) => b.count - a.count);
}

function buildGraph(cities: MentorCity[]) {
  const hub = hubCity(cities);
  const byName = new Map(cities.map((city) => [city.name, city]));
  const best = pickProvinceCities(cities);
  fillMissingProvinces(best, byName);

  const spokes = [...best.values()].sort((a, b) => b.count - a.count);
  const buckets = emptyBuckets();
  const lines: FlyingLine[] = [];

  for (const [index, city] of spokes.entries()) {
    const line = toLine(hub, city);
    lines.push(line);
    buckets[speedBucket(index, spokes.length)].push(line);
  }

  const nodes = [hub, ...spokes];
  return { lines, buckets, nodes };
}

export async function getMentorFlyingNetwork(): Promise<FlyingNetwork> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache;
  try {
    const { lines, buckets, nodes } = buildGraph(await loadMentorCities());
    const maxCount = Math.max(...nodes.map((city) => city.count), 1);
    const bubbles: FlyingBubble[] = nodes.map((city) => ({
      id: city.name,
      lng: city.coord[0],
      lat: city.coord[1],
      name: city.name,
      radiusField:
        city.name === HUB_CITY
          ? Math.max(280, Math.round((city.count / maxCount) * 1000))
          : Math.max(12, Math.round((city.count / maxCount) * 1000))
    }));
    cache = { at: now, lines, buckets, bubbles };
  } catch {
    cache = { at: now, lines: [], buckets: emptyBuckets(), bubbles: [] };
  }
  return cache;
}

'use client';

import { useEffect, useRef } from 'react';

const HUB: [number, number] = [116.4, 39.9];

const CITIES: { name: string; coord: [number, number]; value: number }[] = [
  { name: '北京', coord: [116.4, 39.9], value: 980 },
  { name: '上海', coord: [121.47, 31.23], value: 860 },
  { name: '广州', coord: [113.26, 23.13], value: 720 },
  { name: '深圳', coord: [114.06, 22.55], value: 640 },
  { name: '成都', coord: [104.07, 30.67], value: 580 },
  { name: '武汉', coord: [114.31, 30.59], value: 520 },
  { name: '西安', coord: [108.94, 34.26], value: 480 },
  { name: '杭州', coord: [120.16, 30.25], value: 510 },
  { name: '南京', coord: [118.8, 32.06], value: 430 },
  { name: '重庆', coord: [106.55, 29.56], value: 470 },
  { name: '哈尔滨', coord: [126.53, 45.8], value: 310 },
  { name: '沈阳', coord: [123.43, 41.8], value: 300 },
  { name: '乌鲁木齐', coord: [87.62, 43.83], value: 260 },
  { name: '拉萨', coord: [91.11, 29.65], value: 140 },
  { name: '昆明', coord: [102.71, 25.04], value: 280 },
  { name: '兰州', coord: [103.83, 36.06], value: 220 },
  { name: '南宁', coord: [108.32, 22.82], value: 210 },
  { name: '福州', coord: [119.3, 26.08], value: 240 },
  { name: '海口', coord: [110.33, 20.03], value: 160 },
  { name: '呼和浩特', coord: [111.66, 40.82], value: 180 }
];

function shortName(name: string) {
  return name
    .replace(/维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区$/g, '')
    .replace(/省$/g, '')
    .replace(/市$/g, '');
}

export function DatavChinaMap() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let chart: { dispose: () => void; setOption: (option: unknown) => void } | undefined;

    async function boot() {
      const echarts = await import('echarts');
      const response = await fetch('/screen/china.json');
      const geoJson = (await response.json()) as Parameters<typeof echarts.registerMap>[1];
      if (disposed || !ref.current) return;

      echarts.registerMap('china', geoJson);
      const instance = echarts.init(ref.current, undefined, {
        renderer: 'canvas',
        width: 1920,
        height: 1080
      });
      chart = instance;

      const destinations = CITIES.filter((city) => city.name !== '北京');
      instance.setOption({
        backgroundColor: 'transparent',
        geo: [
          {
            map: 'china',
            z: 1,
            silent: true,
            roam: false,
            aspectScale: 0.86,
            layoutCenter: ['39%', '50%'],
            layoutSize: '118%',
            itemStyle: {
              areaColor: '#18191a',
              borderColor: '#7a7a7a',
              borderWidth: 1
            },
            label: { show: false },
            emphasis: { disabled: true }
          },
          {
            map: 'china',
            z: 2,
            silent: true,
            roam: false,
            aspectScale: 0.86,
            layoutCenter: ['39%', '47.6%'],
            layoutSize: '118%',
            itemStyle: {
              areaColor: '#484848',
              borderColor: '#c5c2b4',
              borderWidth: 0.9,
              shadowColor: 'rgba(255,255,255,0.32)',
              shadowOffsetY: 11,
              shadowBlur: 2
            },
            label: {
              show: true,
              color: '#bfbfbf',
              fontSize: 12,
              fontFamily: 'Microsoft Yahei',
              fontWeight: 'bold',
              formatter: (params: { name: string }) => shortName(params.name)
            },
            emphasis: { disabled: true }
          }
        ],
        series: [
          {
            type: 'lines',
            zlevel: 3,
            coordinateSystem: 'geo',
            geoIndex: 1,
            polyline: false,
            effect: {
              show: true,
              period: 5.5,
              trailLength: 0.35,
              color: '#ffffff',
              symbol: 'circle',
              symbolSize: 3.6
            },
            lineStyle: {
              color: 'rgba(255,255,255,0.72)',
              width: 1.15,
              opacity: 0.85,
              curveness: 0.28
            },
            data: destinations.map((city) => ({ coords: [HUB, city.coord] }))
          },
          {
            type: 'effectScatter',
            coordinateSystem: 'geo',
            geoIndex: 1,
            zlevel: 4,
            rippleEffect: { brushType: 'stroke', scale: 3.2, period: 3.6 },
            itemStyle: { color: '#ffffcc' },
            symbolSize: (value: number[]) => 7 + Math.min(16, (value[2] || 200) / 90),
            data: CITIES.map((city) => ({
              name: city.name,
              value: [...city.coord, city.value]
            }))
          }
        ]
      });
    }

    void boot();
    return () => {
      disposed = true;
      chart?.dispose();
    };
  }, []);

  return <div ref={ref} className="dv-map" />;
}

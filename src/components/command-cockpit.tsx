'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { DatavChinaMap } from '@/components/datav-china-map';
import { useDashboardStats } from '@/components/dashboard-stats-context';
import { metricValue } from '@/lib/dashboard-metrics';
import type { DbSummaryPayload } from '@/lib/db-summary';
import { formatNumber } from '@/lib/utils';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function Layer({
  x,
  y,
  w,
  h,
  className = '',
  children
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`dv-layer ${className}`} style={{ left: x, top: y, width: w, height: h }}>
      {children}
    </div>
  );
}

function Flop({
  x,
  y,
  w,
  h,
  title,
  value,
  suffix = '',
  titleSize,
  numSize,
  suffixSize = 21
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  value: number;
  suffix?: string;
  titleSize: number;
  numSize: number;
  suffixSize?: number;
}) {
  return (
    <div className="dv-flop" style={{ left: x, top: y, width: w, height: h }}>
      <div className="dv-flop-title" style={{ fontSize: titleSize }}>
        {title}
      </div>
      <div className="dv-flop-num" style={{ fontSize: numSize }}>
        {formatNumber(value)}
        {suffix ? (
          <small style={{ fontSize: suffixSize }}>{suffix}</small>
        ) : null}
      </div>
    </div>
  );
}

function IconTile({
  x,
  y,
  color,
  children
}: {
  x: number;
  y: number;
  color: string;
  children: ReactNode;
}) {
  return (
    <div className="dv-icon-tile" style={{ left: x, top: y, color, borderColor: color }}>
      {children}
    </div>
  );
}

function isSummaryPayload(value: unknown): value is DbSummaryPayload {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<DbSummaryPayload>;
  return Boolean(row.stats && row.indexStats);
}

export function CommandCockpit() {
  const context = useDashboardStats();
  const [remote, setRemote] = useState<DbSummaryPayload | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (context.data) return;
    let cancelled = false;
    void fetch('/datav-runtime/summary', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload: unknown) => {
        if (!cancelled && isSummaryPayload(payload)) setRemote(payload);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [context.data]);

  const data = context.data || remote;
  const papers = metricValue(data?.papers);
  const patents = metricValue(data?.patents);
  const books = metricValue(data?.books ?? data?.whitepapers);
  const mentors = metricValue(data?.mentors);
  const edges = metricValue(data?.stats.edges);
  const entities = metricValue(data?.stats.entities);
  const terms = metricValue(data?.indexStats.searchTerms);
  const records = metricValue(data?.indexStats.searchRecords);

  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const ss = pad(now.getSeconds());
  const dd = pad(now.getDate());
  const mon = MONTHS[now.getMonth()];

  return (
    <div className="dv-screen">
      <div className="dv-map-wrap" aria-hidden>
        <div className="dv-radar" />
        <DatavChinaMap />
      </div>

      <Layer x={-1} y={13} w={632} h={106}>
        <div className="dv-title-capsule" />
        <div className="dv-title-cn">能元平台运行监测 &gt;</div>
        <div className="dv-title-en">Nengyuan platform monitoring screen</div>
      </Layer>

      <Layer x={1497} y={23} w={389} h={62} className="dv-clock-group">
        <div className="dv-clock-hhmm">{hhmm}</div>
        <div className="dv-clock-ss">{ss}</div>
        <div className="dv-clock-mon">{mon}</div>
        <div className="dv-clock-dd">{dd}</div>
        <div className="dv-clock-rule" />
        <div className="dv-clock-brand">能元</div>
      </Layer>

      <Layer x={1448} y={123} w={453} h={551}>
        <div className="dv-circles" aria-hidden />
        <Flop x={14} y={60} w={154} h={66} title="关系边" value={edges} suffix="条" titleSize={14} numSize={51} />
        <Flop x={224} y={132} w={154} h={66} title="论文" value={papers} titleSize={14} numSize={51} />
        <Flop x={56} y={248} w={154} h={66} title="导师" value={mentors} titleSize={14} numSize={42} />
        <Flop x={219} y={329} w={154} h={66} title="专利" value={patents} titleSize={14} numSize={40} />
        <Flop x={297} y={451} w={154} h={66} title="书籍" value={books} titleSize={12} numSize={27} />
      </Layer>

      <Layer x={1109} y={767} w={168} h={224} className="dv-nanhai">
        <div className="dv-nanhai-frame" />
        <div className="dv-nanhai-map" aria-hidden />
        <span>南海诸岛</span>
      </Layer>

      <Layer x={2} y={905} w={1898} h={168}>
        <div className="dv-foot-title">资源与检索详情</div>
        <img className="dv-foot-line" src="/screen/bottom-line.svg" alt="" />
        <IconTile x={50} y={64} color="#ffffff">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M6 7h12v12H6z" />
            <path d="M9 7V5h6v2" />
          </svg>
        </IconTile>
        <IconTile x={168} y={64} color="#ffc53d">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M3 13l9-9 4 4-9 9H3v-4z" />
            <path d="M13 6l5 5" />
          </svg>
        </IconTile>
        <IconTile x={287} y={64} color="#ffffff">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M4 16h16l-2-6H8L4 16z" />
            <path d="M8 16v3M16 16v3M6 10V8h4" />
          </svg>
        </IconTile>
        <IconTile x={415} y={64} color="#ffffff">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M5 19V9l4-4h10v14H5z" />
            <path d="M9 19v-6h6v6" />
          </svg>
        </IconTile>
        <IconTile x={533} y={64} color="#ffc53d">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 8v5l3 2" />
          </svg>
        </IconTile>
        <IconTile x={650} y={64} color="#ffffff">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M7 7h8a4 4 0 010 8H9" />
            <path d="M9 7L6 4M9 7L6 10" />
          </svg>
        </IconTile>
        <Flop x={0} y={108} w={142} h={60} title="论文" value={papers} suffix="篇" titleSize={12} numSize={24} suffixSize={14} />
        <Flop x={118} y={108} w={142} h={59} title="专利" value={patents} suffix="件" titleSize={12} numSize={24} suffixSize={14} />
        <Flop x={235} y={108} w={142} h={60} title="书籍" value={books} suffix="份" titleSize={12} numSize={24} suffixSize={14} />
        <Flop x={363} y={108} w={142} h={60} title="检索词项" value={terms} suffix="项" titleSize={12} numSize={24} suffixSize={14} />
        <Flop x={480} y={108} w={142} h={59} title="知识实体" value={entities} suffix="个" titleSize={12} numSize={24} suffixSize={14} />
        <Flop x={598} y={108} w={142} h={60} title="索引记录" value={records} suffix="条" titleSize={12} numSize={24} suffixSize={14} />
      </Layer>
    </div>
  );
}

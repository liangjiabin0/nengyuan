import { EvidenceLedger } from '../src/lib/agent/evidence-ledger';
import { formatQueryResult } from '../src/lib/tools/query-result';

const ledger = new EvidenceLedger();
const grouped = formatQueryResult(
  '论文按作者单位学校分组（1211 篇，正文抽取）',
  [
    { k: '华北电力大学', c: 164 },
    { k: '西安交通大学', c: 64 },
    { k: '清华大学', c: 60 }
  ],
  { keyField: 'k', countField: 'c' }
);

ledger.add(grouped, 'analytics.group_by');

console.log('analyticsSummary:', ledger.getAnalyticsSummary());
console.log('contextText:', ledger.buildContextText());

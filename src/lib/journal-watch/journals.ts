/** 期刊追踪：订阅的期刊清单。ISSN 第一个用于 Crossref 查询。 */
export type WatchedJournal = {
  code: string;
  name: string;
  shortName: string;
  publisher: 'IEEE' | 'Elsevier';
  issn: string[];
  /** 开放获取期刊：全文本来就免费公开 */
  openAccess: boolean;
};

export const WATCHED_JOURNALS: readonly WatchedJournal[] = [
  { code: 'TPWRS', name: 'IEEE Transactions on Power Systems', shortName: 'IEEE TPWRS', publisher: 'IEEE', issn: ['0885-8950', '1558-0679'], openAccess: false },
  { code: 'TSTE', name: 'IEEE Transactions on Sustainable Energy', shortName: 'IEEE TSTE', publisher: 'IEEE', issn: ['1949-3029', '1949-3037'], openAccess: false },
  { code: 'TSG', name: 'IEEE Transactions on Smart Grid', shortName: 'IEEE TSG', publisher: 'IEEE', issn: ['1949-3053', '1949-3061'], openAccess: false },
  { code: 'TPWRD', name: 'IEEE Transactions on Power Delivery', shortName: 'IEEE TPWRD', publisher: 'IEEE', issn: ['0885-8977', '1937-4208'], openAccess: false },
  { code: 'MPCE', name: 'Journal of Modern Power Systems and Clean Energy', shortName: 'MPCE', publisher: 'IEEE', issn: ['2196-5625', '2196-5420'], openAccess: true },
  { code: 'JPES', name: 'CSEE Journal of Power and Energy Systems', shortName: 'CSEE JPES', publisher: 'IEEE', issn: ['2096-0042'], openAccess: true },
  { code: 'PCMP', name: 'Protection and Control of Modern Power Systems', shortName: 'PCMP', publisher: 'IEEE', issn: ['2367-2617', '2367-0983'], openAccess: true },
  { code: 'EPSR', name: 'Electric Power Systems Research', shortName: 'EPSR', publisher: 'Elsevier', issn: ['0378-7796', '1873-2046'], openAccess: false },
  { code: 'APEN', name: 'Applied Energy', shortName: 'Applied Energy', publisher: 'Elsevier', issn: ['0306-2619', '1872-9118'], openAccess: false }
];

export function findJournal(code: string) {
  return WATCHED_JOURNALS.find((journal) => journal.code === code);
}

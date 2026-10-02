export type RawRow = Record<string, string>;

export type ProjectInput = {
  projectKey: string;
  grantName?: string;
  grantCategory?: string;
  country?: string;
  projectName?: string;
  projectNameEn?: string;
  keywords?: string;
  summary?: string;
  projectCode?: string;
  principalInvestigator?: string;
  institution?: string;
  year?: string;
  startDate?: string;
  endDate?: string;
  amount?: string;
  currency?: string;
  participants?: string;
  discipline?: string;
  disciplineCode?: string;
  partnerInstitutions?: string;
};

export type OutputInput = {
  outputKey: string;
  projectKey: string;
  title?: string;
  publication?: string;
  authors?: string;
};

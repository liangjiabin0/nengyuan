import type { SearchResult } from './search-index';
import { extractPersonNameFromQuery } from './person-retrieval';

const PERSON_NAME = /^[\u4e00-\u9fa5]{2,4}$/;

export function queryLooksLikePersonName(query: string) {
  const q = String(query || '').trim();
  if (PERSON_NAME.test(q)) return q;
  return extractPersonNameFromQuery(q);
}

/** 人物检索：署名论文优先，仅被他人档案提及的导师条降权 */
export function rerankForPersonQuery(query: string, results: SearchResult[]) {
  const person = queryLooksLikePersonName(query);
  if (!person) return results;

  const scored = results.map((result) => ({
    result,
    score: personRelevanceScore(person, result)
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => ({
    ...item.result,
    score: item.score,
    fields: {
      ...item.result.fields,
      person_relevance: item.score - item.result.score
    }
  }));
}

function personRelevanceScore(person: string, result: SearchResult) {
  let score = result.score || 0;
  const fields = result.fields || {};
  const hay = `${result.title}\n${result.body}\n${result.snippet || ''}`;

  if (result.sourceType === 'paper' || result.sourceType === 'paper_chunk') {
    const authors = String(fields.authors || fields.parsed_authors || '');
    if (authors.includes(person)) score += 4000;
    else if (hay.includes(person)) score += 2000;
    return score;
  }

  if (result.sourceType === 'mentor') {
    const mentorName = String(fields.name || '').trim();
    if (mentorName === person) score += 5000;
    else if (mentorName.includes(person)) score += 3500;
    else if (hay.includes(person)) score -= 2500;
    return score;
  }

  if (hay.includes(person)) score += 800;
  return score;
}

export function suggestReadAnchor(result: SearchResult): string {
  if (result.sourceType === 'mentor') return `mentor:${result.sourceKey}`;
  const paperKey = result.fields?.paper_key;
  if (paperKey) return String(paperKey);
  if (result.sourceType === 'paper' || result.sourceType === 'paper_chunk') {
    return String(result.title || result.sourceKey).replace(/^《|》$/g, '');
  }
  return String(result.sourceKey || result.title || '');
}

export function personResultHint(person: string, result: SearchResult): string {
  if (result.sourceType !== 'mentor') return '';
  const mentorName = String(result.fields?.name || '').trim();
  if (!mentorName || mentorName === person) return '';
  if (`${result.body}${result.snippet}`.includes(person)) {
    return `（档案主体是「${mentorName}」，仅提及「${person}」，勿当作 ${person} 本人档案）`;
  }
  return '';
}

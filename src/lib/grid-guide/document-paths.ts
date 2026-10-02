import type { GridGuideDocument } from './types';

export type DocumentPath = Array<string | number>;

export type StringField = {
  path: DocumentPath;
  value: string;
};

export function pathKey(path: DocumentPath) {
  return JSON.stringify(path);
}

export function normalizeMatchText(value: string) {
  return value
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[：]/g, ':')
    .replace(/[；]/g, ';')
    .replace(/[，]/g, ',')
    .replace(/[。]/g, '.')
    .toLowerCase();
}

export function walkStringFields(value: unknown, path: DocumentPath = [], out: StringField[] = []) {
  if (typeof value === 'string') {
    out.push({ path, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStringFields(item, [...path, index], out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      walkStringFields(item, [...path, key], out);
    }
  }
  return out;
}

export function getStringAtPath(document: GridGuideDocument, path: DocumentPath) {
  let current: unknown = document;
  for (const part of path) {
    if (typeof current !== 'object' || current === null || !(part in current)) return null;
    current = (current as Record<string | number, unknown>)[part];
  }
  return typeof current === 'string' ? current : null;
}

export function setStringAtPath(document: GridGuideDocument, path: DocumentPath, value: string) {
  let parent: unknown = document;
  for (const part of path.slice(0, -1)) {
    if (typeof parent !== 'object' || parent === null || !(part in parent)) return false;
    parent = (parent as Record<string | number, unknown>)[part];
  }
  const leaf = path.at(-1);
  if (
    leaf === undefined ||
    typeof parent !== 'object' ||
    parent === null ||
    !(leaf in parent) ||
    typeof (parent as Record<string | number, unknown>)[leaf] !== 'string'
  ) {
    return false;
  }
  (parent as Record<string | number, unknown>)[leaf] = value;
  return true;
}

export function findNormalizedRange(haystack: string, needle: string) {
  const target = normalizeMatchText(needle);
  if (!target) return null;
  const map: number[] = [];
  let normalized = '';
  for (let i = 0; i < haystack.length; i += 1) {
    const piece = normalizeMatchText(haystack[i]!);
    if (!piece) continue;
    for (let j = 0; j < piece.length; j += 1) map.push(i);
    normalized += piece;
  }
  const start = normalized.indexOf(target);
  if (start < 0) return null;
  const endNorm = start + target.length - 1;
  const from = map[start];
  const to = map[endNorm];
  if (from === undefined || to === undefined) return null;
  return { start: from, end: to + 1 };
}

export function replaceNormalized(haystack: string, needle: string, next: string) {
  if (haystack.includes(needle)) return haystack.replace(needle, next);
  const range = findNormalizedRange(haystack, needle);
  if (!range) return null;
  return `${haystack.slice(0, range.start)}${next}${haystack.slice(range.end)}`;
}

export function locateSelectionTargets(document: GridGuideDocument, selection?: string) {
  const raw = selection?.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim() || '';
  if (raw.length < 2) return [] as StringField[];
  const fields = walkStringFields(document);
  const normalizedSelection = normalizeMatchText(raw);

  const contained = fields.filter((field) => {
    const normalizedValue = normalizeMatchText(field.value);
    return (
      normalizedValue.includes(normalizedSelection) ||
      normalizedSelection.includes(normalizedValue)
    );
  });
  const exactSingle = contained.find(
    (field) => normalizeMatchText(field.value) === normalizedSelection
  );
  if (exactSingle) return [exactSingle];
  const fullyContaining = contained.filter((field) =>
    normalizeMatchText(field.value).includes(normalizedSelection)
  );
  if (fullyContaining.length === 1) return fullyContaining;
  if (fullyContaining.length > 1) {
    return fullyContaining.sort((a, b) => a.value.length - b.value.length).slice(0, 1);
  }

  const byParent = new Map<string, StringField[]>();
  for (const field of fields) {
    if (field.path.length < 2 || typeof field.path.at(-1) !== 'number') continue;
    const parent = pathKey(field.path.slice(0, -1));
    const list = byParent.get(parent) || [];
    list.push(field);
    byParent.set(parent, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => Number(a.path.at(-1)) - Number(b.path.at(-1)));
    for (let start = 0; start < list.length; start += 1) {
      const matched: StringField[] = [];
      for (let end = start; end < list.length; end += 1) {
        matched.push(list[end]!);
        const variants = [
          matched.map((item) => item.value).join(''),
          matched.map((item) => item.value).join(' '),
          matched.map((item) => item.value).join('\n')
        ];
        if (variants.some((value) => normalizeMatchText(value) === normalizedSelection)) {
          return matched;
        }
        const shortest = Math.min(...variants.map((value) => normalizeMatchText(value).length));
        if (shortest > normalizedSelection.length + 8) break;
      }
    }
  }

  if (contained.length > 1) {
    for (const list of byParent.values()) {
      if (!list.length) continue;
      const parentKey = pathKey(list[0]!.path.slice(0, -1));
      const indexes = contained
        .filter((field) => pathKey(field.path.slice(0, -1)) === parentKey)
        .map((field) => Number(field.path.at(-1)))
        .sort((a, b) => a - b);
      if (indexes.length < 2) continue;
      let prev = indexes[0]!;
      let best = [indexes[0]!];
      let current = [indexes[0]!];
      for (let i = 1; i < indexes.length; i += 1) {
        const index = indexes[i]!;
        if (index === prev + 1) current.push(index);
        else {
          if (current.length > best.length) best = current;
          current = [index];
        }
        prev = index;
      }
      if (current.length > best.length) best = current;
      if (best.length >= 2) {
        return list.filter((field) => best.includes(Number(field.path.at(-1))));
      }
    }
  }

  // 弱模糊兜底容易改错段落；有划选时宁可不定位，让调用方明确失败。
  if (raw.length >= 12) return [];
  let best: StringField | null = null;
  let bestScore = 0;
  for (const field of fields) {
    const value = normalizeMatchText(field.value);
    if (!value) continue;
    let score = 0;
    const window = Math.min(value.length, normalizedSelection.length, 48);
    for (let size = window; size >= 12; size -= 4) {
      for (let i = 0; i + size <= normalizedSelection.length; i += size) {
        const part = normalizedSelection.slice(i, i + size);
        if (value.includes(part)) score = Math.max(score, size);
      }
      if (score >= 24) break;
    }
    if (score > bestScore) {
      bestScore = score;
      best = field;
    }
  }
  return best && bestScore >= 24 ? [best] : [];
}

export function diffChangedPaths(before: GridGuideDocument, after: GridGuideDocument) {
  const beforeFields = new Map(walkStringFields(before).map((field) => [pathKey(field.path), field.value]));
  const changed: DocumentPath[] = [];
  for (const field of walkStringFields(after)) {
    if (beforeFields.get(pathKey(field.path)) !== field.value) changed.push(field.path);
  }
  return changed;
}

export function samePath(a: DocumentPath, b: DocumentPath) {
  return pathKey(a) === pathKey(b);
}

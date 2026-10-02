import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';
import { extractBalancedJson } from './compute-sidecar';
import type { SchemeBrainstormPayload } from './types';

const ideaSchema = z.object({
  title: z.string().trim().min(2).max(80),
  summary: z.string().trim().min(4).max(2000),
  problemClass: z.enum(['dcopf', 'lp', 'mip', 'mgplan', 'acopf', 'dispatch', 'loss', 'modelica', 'forecast']),
  decisions: z.string().trim().min(2).max(2000),
  limits: z.string().trim().min(2).max(2000),
  goal: z.string().trim().min(2).max(2000),
  caseHint: z.string().trim().max(200).optional(),
  whySolvable: z.string().trim().min(2).max(2000)
});

const rejectedSchema = z.object({
  title: z.string().trim().min(2).max(80),
  reason: z.string().trim().min(2).max(2000)
});

const payloadSchema = z.object({
  ideas: z.array(ideaSchema).max(12).default([]),
  rejected: z.array(rejectedSchema).max(20).default([])
});

function stripFences(answer: string) {
  return answer
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim();
}

function collectJsonObjects(answer: string) {
  const cleaned = stripFences(answer);
  const slices: string[] = [];
  for (let index = 0; index < cleaned.length; index += 1) {
    if (cleaned[index] !== '{') continue;
    const slice = extractBalancedJson(cleaned, index);
    if (!slice) continue;
    if (/"ideas"\s*:/.test(slice) || /"rejected"\s*:/.test(slice)) {
      slices.push(slice);
    }
    index += slice.length - 1;
  }
  if (!slices.length) {
    const start = cleaned.indexOf('{');
    if (start >= 0) {
      slices.push(extractBalancedJson(cleaned, start) || cleaned.slice(start));
    }
  }
  return [...new Set(slices)];
}

function candidatesFor(raw: string) {
  const values = [raw];
  try {
    values.push(jsonrepair(raw));
  } catch {
    // keep raw
  }
  return [...new Set(values.filter(Boolean))];
}

export function parseBrainstormPayload(answer: string): SchemeBrainstormPayload {
  const objects = collectJsonObjects(answer);
  let lastError: unknown = new Error('头脑风暴未返回 JSON。');
  for (const raw of objects) {
    for (const candidate of candidatesFor(raw)) {
      try {
        const parsed = payloadSchema.parse(JSON.parse(candidate));
        if (!parsed.ideas.length && !parsed.rejected.length) {
          throw new Error('头脑风暴没有产出任何想法。');
        }
        return parsed;
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (lastError instanceof z.ZodError) {
    throw new Error(`头脑风暴字段校验失败：${lastError.issues.map((issue) => issue.message).join('；')}`);
  }
  const hint = stripFences(answer).replace(/\s+/g, ' ').slice(0, 160);
  const message = lastError instanceof Error ? lastError.message : '头脑风暴 JSON 校验失败。';
  throw new Error(hint ? `${message}（片段：${hint}）` : message);
}

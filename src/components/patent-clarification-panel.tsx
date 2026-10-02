'use client';

import { AlertCircle, LoaderCircle, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PatentProject } from '@/lib/patent-generation/types';

export function PatentClarificationPanel({
  project,
  disabled,
  saving,
  onSubmit
}: {
  project: PatentProject;
  disabled: boolean;
  saving: boolean;
  onSubmit: (values: Record<string, string>) => Promise<void>;
}) {
  const blockers = useMemo(
    () => project.blockers.filter((item) => !item.resolved),
    [project.blockers]
  );
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    setValues(Object.fromEntries(blockers.map((item) => [
      item.id,
      item.answer || project.answers[item.id] || (
        item.id === 'confirm-applicant'
          ? project.applicant
          : item.id === 'confirm-inventors'
            ? project.inventors.join('、')
            : ''
      )
    ])));
  }, [blockers, project.answers, project.applicant, project.inventors]);

  const complete = blockers.length > 0 && blockers.every((item) => values[item.id]?.trim());
  if (!blockers.length) return null;

  return (
    <section className="rounded-xl border border-warning/30 bg-warning/5 p-4" aria-labelledby="patent-questions-title">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div>
          <h2 id="patent-questions-title" className="text-sm font-semibold text-foreground">
            请集中确认 {blockers.length} 项信息
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            候选内容仅供核对；确认后系统会从有效检查点继续。
          </p>
        </div>
      </div>
      <div className="mt-4 space-y-4">
        {blockers.map((blocker, index) => (
          <label key={blocker.id} className="block">
            <span className="text-sm font-medium text-foreground">
              {index + 1}. {blocker.question}
            </span>
            {blocker.reason ? (
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">{blocker.reason}</span>
            ) : null}
            <textarea
              value={values[blocker.id] || ''}
              onChange={(event) => setValues((current) => ({
                ...current,
                [blocker.id]: event.target.value
              }))}
              disabled={disabled || saving}
              rows={2}
              className="ui-input mt-2 max-h-40 resize-y"
              aria-label={blocker.question}
            />
          </label>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={!complete || disabled || saving}
          onClick={() => void onSubmit(values)}
          className="ui-btn-primary gap-2"
        >
          {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          确认并继续生成
        </button>
      </div>
    </section>
  );
}

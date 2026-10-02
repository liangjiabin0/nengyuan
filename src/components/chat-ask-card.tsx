'use client';

import { Check, CircleHelp, LoaderCircle, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  canSubmitChatAskAnswers,
  type ChatAskQuestion,
  type ChatAskRequest
} from '@/lib/opencode/chat-ask';

function emptyAnswers(questions: ChatAskQuestion[]) {
  return questions.map(() => [] as string[]);
}

export function ChatAskCard({
  request,
  disabled,
  onSubmit
}: {
  request: ChatAskRequest;
  disabled?: boolean;
  onSubmit: (answers: string[][]) => Promise<void>;
}) {
  const questions = request.questions;
  const [answers, setAnswers] = useState<string[][]>(() => emptyAnswers(questions));
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const resolved = useMemo(
    () => questions.map((question, index) => {
      const selected = answers[index] || [];
      const typed = custom[index]?.trim();
      if (question.custom && typed && !selected.includes(typed)) {
        return question.multiple ? [...selected, typed] : [typed];
      }
      return selected;
    }),
    [answers, custom, questions]
  );

  const complete = canSubmitChatAskAnswers(questions, resolved);

  function toggleOption(index: number, label: string, multiple: boolean) {
    setError('');
    setAnswers((current) => current.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      if (multiple) {
        return item.includes(label) ? item.filter((value) => value !== label) : [...item, label];
      }
      return item[0] === label ? [] : [label];
    }));
    if (!multiple) {
      setCustom((current) => current.map((value, itemIndex) => (itemIndex === index ? '' : value)));
    }
  }

  async function submit() {
    if (!complete || disabled || saving) return;
    setSaving(true);
    setError('');
    try {
      await onSubmit(resolved);
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败，请重试。');
      setSaving(false);
    }
  }

  return (
    <section className="rag-oc-ask" aria-label="需要你确认">
      <div className="rag-oc-ask-head">
        <CircleHelp className="rag-oc-ask-icon" aria-hidden />
        <div className="min-w-0">
          <h2 className="rag-oc-ask-title">需要确认 {questions.length} 项</h2>
          <p className="rag-oc-ask-hint">选好后能元会按你的选择继续，而不是停在最终回答里发问。</p>
        </div>
      </div>
      <div className="rag-oc-ask-list">
        {questions.map((question, index) => {
          const selected = answers[index] || [];
          return (
            <fieldset key={`${request.requestID}-${index}`} className="rag-oc-ask-item">
              <legend className="rag-oc-ask-question">
                {question.header && question.header !== question.question ? (
                  <span className="rag-oc-ask-header">{question.header}</span>
                ) : null}
                <span>{question.question}</span>
              </legend>
              {question.options.length ? (
                <div className="rag-oc-ask-options" role={question.multiple ? 'group' : 'radiogroup'}>
                  {question.options.map((option) => {
                    const active = selected.includes(option.label);
                    return (
                      <button
                        key={option.label}
                        type="button"
                        className={`rag-oc-ask-option${active ? ' is-active' : ''}`}
                        aria-pressed={active}
                        disabled={disabled || saving}
                        onClick={() => toggleOption(index, option.label, question.multiple)}
                      >
                        <span className="rag-oc-ask-check" aria-hidden>
                          {active ? <Check className="h-3 w-3" /> : null}
                        </span>
                        <span className="min-w-0">
                          <span className="rag-oc-ask-option-label">{option.label}</span>
                          {option.description ? (
                            <span className="rag-oc-ask-option-desc">{option.description}</span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {question.custom ? (
                <input
                  className="ui-input rag-oc-ask-custom"
                  value={custom[index] || ''}
                  disabled={disabled || saving}
                  placeholder={question.options.length ? '或填写其他答案' : '请填写答案'}
                  aria-label={`${question.header || question.question} 自定义答复`}
                  onChange={(event) => {
                    const value = event.target.value;
                    setError('');
                    setCustom((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? value : item
                    )));
                    if (!question.multiple && value.trim()) {
                      setAnswers((current) => current.map((item, itemIndex) => (
                        itemIndex === index ? [] : item
                      )));
                    }
                  }}
                />
              ) : null}
            </fieldset>
          );
        })}
      </div>
      {error ? <p className="rag-oc-ask-error">{error}</p> : null}
      <div className="rag-oc-ask-actions">
        <button
          type="button"
          className="ui-btn-primary h-8 gap-1.5 px-3 text-xs"
          disabled={!complete || disabled || saving}
          onClick={() => void submit()}
        >
          {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          确认并继续
        </button>
      </div>
    </section>
  );
}

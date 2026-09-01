"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X, Archive, RotateCcw, Loader2 } from "lucide-react";
import { Card, StatusBadge, notify } from "@/components/admin/ui";
import { usePersistentAction } from "@/components/admin/ui/use-form";
import { formatDate } from "@/lib/utils";
import { ANSWER_LIMITS } from "@/lib/ugc";
import {
  setQuestionStatusAction,
  answerQuestionAction,
  editAnswerAction,
  setAnswerStatusAction,
  type QAModerationState,
} from "@/lib/admin/question-actions";
import type { AdminQuestionDetail } from "@/lib/admin/questions";

type Detail = NonNullable<AdminQuestionDetail>;
type QAStatus = Detail["status"];

const TONE: Record<QAStatus, "neutral" | "success" | "warning" | "danger"> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  ARCHIVED: "neutral",
};

const EMPTY: QAModerationState = {};

export function QuestionThread({ question, canManage }: { question: Detail; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const runQuestion = (next: QAStatus, msg: string) =>
    start(async () => {
      const res = await setQuestionStatusAction({ id: question.id, status: next });
      if (res.ok) {
        notify.success(msg);
        router.refresh();
      } else {
        notify.error(res.error ?? "That didn't work.");
      }
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <Card>
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-sm font-semibold text-ink">Question</h2>
            <StatusBadge tone={TONE[question.status]}>{question.status}</StatusBadge>
          </div>
          <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-ink-soft">
            {question.body}
          </p>
          <p className="mt-3 text-xs text-ink-faint">
            {question.customer.name ?? "—"} · {question.customer.email} · {formatDate(question.createdAt)}
          </p>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-ink">
            Answers ({question.answers.length})
          </h2>
          <ul className="mt-3 space-y-4">
            {question.answers.map((a) => (
              <AnswerRow key={a.id} answer={a} canManage={canManage} />
            ))}
            {question.answers.length === 0 && (
              <li className="text-sm text-ink-faint">No answers yet.</li>
            )}
          </ul>

          {canManage && <AnswerComposer questionId={question.id} />}
        </Card>
      </div>

      <aside className="space-y-6">
        <Card>
          <h2 className="text-sm font-semibold text-ink">Moderation</h2>
          {canManage ? (
            <div className="mt-3 flex flex-col gap-2">
              {pending && <Loader2 size={14} className="animate-spin text-ink-faint" />}
              {question.status !== "APPROVED" && (
                <button type="button" onClick={() => runQuestion("APPROVED", "Question approved")} disabled={pending} className="btn btn-primary py-2 text-sm">
                  <Check size={14} /> Approve
                </button>
              )}
              {question.status !== "REJECTED" && (
                <button type="button" onClick={() => runQuestion("REJECTED", "Question rejected")} disabled={pending} className="btn btn-outline py-2 text-sm">
                  <X size={14} /> Reject
                </button>
              )}
              {question.status !== "ARCHIVED" && (
                <button type="button" onClick={() => runQuestion("ARCHIVED", "Question archived")} disabled={pending} className="btn btn-ghost py-2 text-sm text-clay">
                  <Archive size={14} /> Archive
                </button>
              )}
              {question.status !== "PENDING" && (
                <button type="button" onClick={() => runQuestion("PENDING", "Question reopened")} disabled={pending} className="btn btn-ghost py-2 text-sm">
                  <RotateCcw size={14} /> Reopen
                </button>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-faint">Read-only (needs manage_reviews).</p>
          )}
          <p className="mt-3 text-xs text-ink-faint">
            Product:{" "}
            <a href={`/p/${question.product.slug}`} target="_blank" rel="noreferrer" className="hover:underline">
              {question.product.name}
            </a>
          </p>
        </Card>
      </aside>
    </div>
  );
}

function AnswerComposer({ questionId }: { questionId: string }) {
  const router = useRouter();
  const doneRef = useRef(false);
  const { state, onSubmit, pending } = usePersistentAction<QAModerationState>(answerQuestionAction, EMPTY);

  useEffect(() => {
    if (!state.ok || doneRef.current) return;
    doneRef.current = true;
    notify.success("Answer posted as Axiaro Team");
    router.refresh();
  }, [state.ok, router]);

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-2 border-t border-line pt-4">
      <input type="hidden" name="questionId" value={questionId} />
      <label htmlFor="answer-body" className="text-sm font-medium text-ink">
        Post an official answer
      </label>
      <textarea
        id="answer-body"
        name="body"
        required
        rows={4}
        minLength={ANSWER_LIMITS.bodyMin}
        maxLength={ANSWER_LIMITS.bodyMax}
        className="field"
        placeholder="Answer as Axiaro Team…"
      />
      {state.fieldErrors?.body && <p className="text-xs text-clay">{state.fieldErrors.body}</p>}
      {state.error && !state.fieldErrors && <p className="text-xs text-clay">{state.error}</p>}
      <div className="flex justify-end">
        <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          Post answer
        </button>
      </div>
    </form>
  );
}

function AnswerRow({
  answer,
  canManage,
}: {
  answer: Detail["answers"][number];
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const doneRef = useRef(false);
  const { state, onSubmit, pending: saving } = usePersistentAction<QAModerationState>(editAnswerAction, EMPTY);

  useEffect(() => {
    if (!state.ok || doneRef.current) return;
    doneRef.current = true;
    notify.success("Answer updated");
    setEditing(false);
    router.refresh();
  }, [state.ok, router]);

  const setStatus = (next: "APPROVED" | "ARCHIVED") =>
    start(async () => {
      const res = await setAnswerStatusAction({ id: answer.id, status: next });
      if (res.ok) {
        notify.success(next === "APPROVED" ? "Answer restored" : "Answer archived");
        router.refresh();
      } else {
        notify.error(res.error ?? "That didn't work.");
      }
    });

  return (
    <li className="rounded-md border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink">
          {answer.official ? "Axiaro Team" : answer.author}
        </span>
        <span className="flex items-center gap-2">
          <StatusBadge tone={answer.status === "APPROVED" ? "success" : "neutral"}>
            {answer.status}
          </StatusBadge>
          <span className="text-xs text-ink-faint">{formatDate(answer.createdAt)}</span>
        </span>
      </div>

      {editing ? (
        <form onSubmit={onSubmit} className="mt-2 space-y-2">
          <input type="hidden" name="id" value={answer.id} />
          <textarea
            name="body"
            required
            rows={4}
            minLength={ANSWER_LIMITS.bodyMin}
            maxLength={ANSWER_LIMITS.bodyMax}
            defaultValue={answer.body}
            className="field"
          />
          {state.fieldErrors?.body && <p className="text-xs text-clay">{state.fieldErrors.body}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className="btn btn-outline py-1.5 text-xs">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn btn-primary py-1.5 text-xs">
              {saving && <Loader2 size={12} className="animate-spin" />}
              Save
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-soft">{answer.body}</p>
          {canManage && (
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <button type="button" onClick={() => setEditing(true)} className="underline underline-offset-2 hover:text-ink">
                Edit
              </button>
              {answer.status === "APPROVED" ? (
                <button type="button" onClick={() => setStatus("ARCHIVED")} disabled={pending} className="text-clay underline underline-offset-2">
                  Archive
                </button>
              ) : (
                <button type="button" onClick={() => setStatus("APPROVED")} disabled={pending} className="text-sage underline underline-offset-2">
                  Restore
                </button>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}

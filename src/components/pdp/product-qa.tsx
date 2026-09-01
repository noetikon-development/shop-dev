"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Loader2, MessageCircleQuestion } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import { usePersistentAction } from "@/components/admin/ui/use-form";
import { QUESTION_LIMITS } from "@/lib/ugc";
import {
  askQuestionAction,
  editQuestionAction,
  deleteQuestionAction,
  type QAActionState,
} from "@/lib/qa-actions";
import type { PublicQuestion } from "@/lib/qa";

type MyQuestion = {
  id: string;
  body: string;
  status: string;
  createdAt: string;
  answers: { id: string; body: string; official: boolean; status: string }[];
};

const EMPTY: QAActionState = {};

const MY_STATUS_NOTE: Record<string, string> = {
  PENDING: "Awaiting moderation",
  APPROVED: "Published",
  REJECTED: "Not approved",
  ARCHIVED: "Archived",
};

export function ProductQA({
  productId,
  questions,
  myQuestions,
  signedIn,
}: {
  productId: string;
  questions: PublicQuestion[];
  myQuestions: MyQuestion[];
  signedIn: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [asking, setAsking] = useState(false);
  const doneRef = useRef(false);

  const { state, onSubmit, pending } = usePersistentAction<QAActionState>(askQuestionAction, EMPTY);
  const fe = state.fieldErrors ?? {};

  useEffect(() => {
    if (!state.ok || doneRef.current) return;
    doneRef.current = true;
    toast.success("Question submitted — we'll review it shortly");
    setAsking(false);
    router.refresh();
  }, [state.ok, router]);
  useEffect(() => {
    if (state.error || state.fieldErrors) doneRef.current = false;
  }, [state]);

  return (
    <section id="qa" className="scroll-mt-28">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl">Questions &amp; answers</h2>
        {signedIn ? (
          !asking && (
            <button type="button" onClick={() => setAsking(true)} className="btn btn-outline py-2 text-sm">
              <MessageCircleQuestion size={15} /> Ask a question
            </button>
          )
        ) : (
          <Link
            href={`/login?redirectTo=${encodeURIComponent(pathname)}`}
            className="btn btn-outline py-2 text-sm"
          >
            Sign in to ask
          </Link>
        )}
      </div>

      {asking && (
        <form onSubmit={onSubmit} className="mt-4 space-y-3 rounded-md border border-line bg-surface-sunken/40 p-4">
          <input type="hidden" name="productId" value={productId} />
          <label htmlFor="qa-body" className="text-sm font-medium">
            Your question
          </label>
          <textarea
            id="qa-body"
            name="body"
            required
            rows={3}
            minLength={QUESTION_LIMITS.bodyMin}
            maxLength={QUESTION_LIMITS.bodyMax}
            className="field"
            placeholder="Ask about size, materials, compatibility…"
          />
          {fe.body && <p className="text-xs text-clay">{fe.body}</p>}
          {state.error && !state.fieldErrors && (
            <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
          )}
          <p className="text-xs text-ink-faint">Questions are checked before they appear publicly.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAsking(false)} className="btn btn-outline py-2 text-sm">
              Cancel
            </button>
            <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
              {pending && <Loader2 size={14} className="animate-spin" />}
              Submit question
            </button>
          </div>
        </form>
      )}

      {myQuestions.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-ink-soft">Your questions</h3>
          <ul className="mt-2 space-y-3">
            {myQuestions.map((q) => (
              <MyQuestionRow key={q.id} question={q} />
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6">
        {questions.length === 0 ? (
          <p className="text-sm text-ink-soft">No questions yet. Be the first to ask.</p>
        ) : (
          <ul className="space-y-6">
            {questions.map((q) => (
              <li key={q.id} className="border-b border-line pb-6 last:border-0">
                <p className="text-sm font-medium text-ink">Q: {q.body}</p>
                <p className="mt-1 text-xs text-ink-faint">
                  {q.author} · {formatDate(q.createdAt)}
                </p>
                {q.answers.length > 0 && (
                  <ul className="mt-3 space-y-3 border-l-2 border-line pl-4">
                    {q.answers.map((a) => (
                      <li key={a.id}>
                        <p className="whitespace-pre-line text-sm leading-relaxed text-ink-soft">
                          A: {a.body}
                        </p>
                        <p className="mt-1 text-xs text-ink-faint">
                          {a.official ? (
                            <span className="font-medium text-ink">{a.author}</span>
                          ) : (
                            a.author
                          )}{" "}
                          · {formatDate(a.createdAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function MyQuestionRow({ question }: { question: MyQuestion }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [deletePending, startDelete] = useTransition();
  const doneRef = useRef(false);

  const { state, onSubmit, pending } = usePersistentAction<QAActionState>(editQuestionAction, EMPTY);

  useEffect(() => {
    if (!state.ok || doneRef.current) return;
    doneRef.current = true;
    toast.success("Question updated");
    setEditing(false);
    router.refresh();
  }, [state.ok, router]);

  function remove() {
    startDelete(async () => {
      const res = await deleteQuestionAction({ questionId: question.id });
      if (res.ok) {
        toast.success("Question removed");
        router.refresh();
      } else {
        toast.error(res.error ?? "That didn't work.");
      }
    });
  }

  return (
    <li className="rounded-md border border-line bg-surface p-3">
      {editing ? (
        <form onSubmit={onSubmit} className="space-y-2">
          <input type="hidden" name="questionId" value={question.id} />
          <textarea
            name="body"
            required
            rows={3}
            minLength={QUESTION_LIMITS.bodyMin}
            maxLength={QUESTION_LIMITS.bodyMax}
            defaultValue={question.body}
            className="field"
          />
          {state.fieldErrors?.body && <p className="text-xs text-clay">{state.fieldErrors.body}</p>}
          {state.error && !state.fieldErrors && <p className="text-xs text-clay">{state.error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className="btn btn-outline py-1.5 text-xs">
              Cancel
            </button>
            <button type="submit" disabled={pending} className="btn btn-primary py-1.5 text-xs">
              {pending && <Loader2 size={12} className="animate-spin" />}
              Save
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-sm text-ink">{question.body}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
            <span>{MY_STATUS_NOTE[question.status] ?? question.status}</span>
            <span>·</span>
            <span>{formatDate(question.createdAt)}</span>
            {question.status === "PENDING" && (
              <>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="underline underline-offset-2 hover:text-ink"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={remove}
                  disabled={deletePending}
                  className="text-clay underline underline-offset-2"
                >
                  Delete
                </button>
              </>
            )}
            {question.status !== "PENDING" && (
              <button
                type="button"
                onClick={remove}
                disabled={deletePending}
                className="text-clay underline underline-offset-2"
              >
                Delete
              </button>
            )}
          </div>
          {question.answers.filter((a) => a.status === "APPROVED").map((a) => (
            <p key={a.id} className="mt-2 border-l-2 border-line pl-3 text-sm text-ink-soft">
              {a.official ? "Axiaro Team: " : "Answer: "}
              {a.body}
            </p>
          ))}
        </>
      )}
    </li>
  );
}

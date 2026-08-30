import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getCurrentAdmin, requirePermission } from "@/lib/admin/rbac";
import { getAdminQuestion } from "@/lib/admin/questions";
import { PageHeader } from "@/components/admin/ui";
import { QuestionThread } from "@/components/admin/reviews/question-thread";

export async function generateMetadata({
  params,
}: PageProps<"/admin/reviews/questions/[id]">): Promise<Metadata> {
  const admin = await getCurrentAdmin();
  if (!admin || !(admin.isSuperAdmin || admin.permissions.has("view_reviews"))) {
    return { title: "Question" };
  }
  const { id } = await params;
  const q = await getAdminQuestion(id);
  return { title: q ? `Question · ${q.product.name}` : "Question" };
}

export default async function AdminQuestionDetailPage({
  params,
}: PageProps<"/admin/reviews/questions/[id]">) {
  const admin = await requirePermission("view_reviews");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_reviews");
  const { id } = await params;

  const question = await getAdminQuestion(id);
  if (!question) notFound();

  return (
    <div>
      <Link
        href="/admin/reviews/questions"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> All questions
      </Link>

      <PageHeader title="Question" description={`For ${question.product.name}`} />

      <QuestionThread question={question} canManage={canManage} />
    </div>
  );
}

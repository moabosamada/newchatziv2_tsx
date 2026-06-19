import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/server/auth/guards";
import { permissions } from "@/server/permissions/permissions";
import { searchKnowledge } from "@/lib/knowledge";

const testSchema = z.object({
  botId: z.string().min(1),
  question: z.string().trim().min(2),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission(permissions.knowledgeManage);
    const body = testSchema.parse(await request.json());

    const result = await searchKnowledge({
      tenantId: session.user.tenantId,
      botId: body.botId,
      question: body.question,
      limit: 5,
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to test knowledge base.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

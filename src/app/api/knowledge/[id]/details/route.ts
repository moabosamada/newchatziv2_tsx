import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/auth/guards";
import { permissions } from "@/server/permissions/permissions";
import { KnowledgeChunk, KnowledgeEntity } from "@/lib/models";
import { connectToDatabase } from "@/lib/mongodb";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requirePermission(permissions.knowledgeRead);
    const { id } = await params;
    await connectToDatabase();

    const [chunks, entities] = await Promise.all([
      KnowledgeChunk.find({ documentId: id, tenantId: session.user.tenantId })
        .select("chunkIndex text keywords tokenEstimate contentHash")
        .sort({ chunkIndex: 1 })
        .lean(),
      KnowledgeEntity.find({ documentId: id, tenantId: session.user.tenantId })
        .select("entityType entityValue originalText metadata")
        .sort({ entityType: 1, entityValue: 1 })
        .lean(),
    ]);

    return NextResponse.json({
      success: true,
      chunks: chunks.map((c: any) => ({
        id: c._id.toString(),
        chunkIndex: c.chunkIndex,
        text: c.text,
        keywords: c.keywords || [],
        tokens: c.tokenEstimate || 0,
      })),
      entities: entities.map((e: any) => ({
        id: e._id.toString(),
        type: e.entityType,
        value: e.entityValue,
        originalText: e.originalText,
        metadata: e.metadata || {},
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to fetch knowledge details.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

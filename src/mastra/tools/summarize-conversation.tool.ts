import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Types } from "mongoose";
import { Conversation, Message } from "@/lib/models";
import { connectToDatabase } from "@/lib/mongodb";

const inputSchema = z.object({
  tenantId: z.string().min(1),
  conversationId: z.string().min(1),
  limit: z.number().int().min(2).max(20).default(10),
});

const outputSchema = z.object({
  summary: z.string(),
  messageCount: z.number(),
});

export const summarizeConversationTool = createTool({
  id: "summarize-conversation",
  description: "Summarize recent tenant-isolated conversation messages for CRM notes and handoff context.",
  inputSchema,
  outputSchema,
  execute: async (input) => {
    await connectToDatabase();
    if (!Types.ObjectId.isValid(input.tenantId) || !Types.ObjectId.isValid(input.conversationId)) {
      throw new Error("Invalid tenant or conversation identifier.");
    }

    const conversation = await Conversation.findOne({ _id: input.conversationId, tenantId: input.tenantId }).select("_id").lean();
    if (!conversation) throw new Error("Conversation not found.");

    const messages = await Message.find({ tenantId: input.tenantId, conversationId: input.conversationId })
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(Number(input.limit ?? 20), 1), 50))
      .select("sender content createdAt")
      .lean();

    const summary = messages
      .reverse()
      .map((message) => `${message.sender}: ${String(message.content || "").slice(0, 220)}`)
      .join("\n");

    return { summary, messageCount: messages.length };
  },
});

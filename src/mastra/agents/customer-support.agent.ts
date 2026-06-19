import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { TokenLimiterProcessor, UnicodeNormalizer } from "@mastra/core/processors";
import { Memory } from "@mastra/memory";
import { searchKnowledgeTool } from "@/mastra/tools/search-knowledge.tool";
import { createOrUpdateTicketTool } from "@/mastra/tools/create-or-update-ticket.tool";
import { createOrUpdateLeadTool } from "@/mastra/tools/create-or-update-lead.tool";
import { getCustomerProfileTool } from "@/mastra/tools/get-customer-profile.tool";
import { summarizeConversationTool } from "@/mastra/tools/summarize-conversation.tool";
import { GLOBAL_CRM_SYSTEM_PROMPT } from "@/lib/ai/build-system-prompt";
import { CHATZI_MASTRA_MODEL_CONTEXT_KEY } from "@/lib/ai/mastra-model-resolver";

const fallbackAgentModel: MastraModelConfig = process.env.OPENAI_API_KEY
  ? {
      providerId: "openai",
      modelId: "gpt-4o-mini",
      apiKey: process.env.OPENAI_API_KEY,
    }
  : "openai/gpt-4o-mini";

export const customerSupportAgent = new Agent({
  id: "customer-support-agent",
  name: "Customer Support Agent",
  model: ({ requestContext }) =>
    (requestContext.get(CHATZI_MASTRA_MODEL_CONTEXT_KEY) as MastraModelConfig | undefined) ||
    fallbackAgentModel,
  instructions: GLOBAL_CRM_SYSTEM_PROMPT,
  tools: {
    searchKnowledge: searchKnowledgeTool,
    getCustomerProfile: getCustomerProfileTool,
    createOrUpdateLead: createOrUpdateLeadTool,
    createOrUpdateTicket: createOrUpdateTicketTool,
    summarizeConversation: summarizeConversationTool,
  },
  memory: new Memory({
    options: {
      lastMessages: 20,
      workingMemory: {
        enabled: true,
        scope: "resource",
        template: [
          "# Customer Profile",
          "- Name:",
          "- Preferred language:",
          "- Communication style:",
          "- Known products or services of interest:",
          "- Booking or purchase intent:",
          "- Open tickets or leads:",
          "- Open issues:",
          "- Important constraints:",
          "- Last useful summary for the CRM team:",
        ].join("\n"),
      },
    },
  }),
  inputProcessors: [
    new UnicodeNormalizer({
      stripControlChars: true,
      collapseWhitespace: true,
    }),
    new TokenLimiterProcessor({
      limit: 4000,
      strategy: "truncate",
      trimMode: "best-fit",
    }),
  ],
  outputProcessors: [
    new TokenLimiterProcessor({
      limit: 400,
      strategy: "truncate",
      countMode: "part",
    }),
  ],
});

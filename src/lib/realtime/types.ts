export type RealtimeEventType =
  | "message.created"
  | "message.updated"
  | "conversation.updated"
  | "conversation.assigned"
  | "conversation.deleted"
  | "notification.created"
  | "ticket.created"
  | "ticket.updated"
  | "ticket.deleted"
  | "delivery.updated"
  | "inbox.snapshot"
  | "heartbeat"
  | "ready"
  | "sync.required"
  | "error";

export type LegacyRealtimeEventType =
  | "inbox"
  | "message"
  | "conversation"
  | "assignment"
  | "delivery";

export type AnyRealtimeEventType = RealtimeEventType | LegacyRealtimeEventType;

export type RealtimeMessagePayload = {
  message?: {
    id: string;
    conversationId: string;
    content: string;
    direction: string;
    sender?: string;
    senderType?: string;
    provider?: string;
    deliveryStatus?: string;
    createdAt: string;
    attachments?: unknown[];
  };
  conversation?: {
    id: string;
    status?: string;
    priority?: string;
    lastMessage?: string;
    lastMessageAt?: string;
    unreadCount?: number;
    channel?: string;
    provider?: string;
  };
  contact?: {
    id?: string;
    name?: string;
    email?: string;
    phone?: string;
    avatarUrl?: string;
  };
  [key: string]: unknown;
};

export interface RealtimeEnvelope<TPayload = unknown> {
  id: string;
  type: RealtimeEventType;
  payload: TPayload;
  ts: string;
}

export type LegacyRealtimeEnvelope = {
  type: LegacyRealtimeEventType;
  data: unknown;
  ts: string;
};

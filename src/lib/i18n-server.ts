type Language = "ar" | "en";

const dictionary: Record<string, Record<Language, string>> = {
  ticket_created: {
    ar: "\\n\\n---\\n✅ **تم تسجيل طلبك بنجاح**\\nرقم التذكرة: `#{ticketNumber}`\\nسيقوم فريقنا بالمتابعة معك قريباً.",
    en: "\\n\\n---\\n✅ **Your request has been registered**\\nTicket Number: `#{ticketNumber}`\\nOur team will follow up with you shortly.",
  },
  handoff_initiated: {
    ar: "\\n\\n---\\n🔄 **تم تحويلك إلى موظف بشري**\\nيرجى الانتظار لحين الرد عليك.",
    en: "\\n\\n---\\n🔄 **Transferred to a human agent**\\nPlease wait for their reply.",
  },
};

export function getSystemMessage(key: keyof typeof dictionary, lang: string = "ar", params: Record<string, string> = {}): string {
  const language = (lang.startsWith("en") ? "en" : "ar") as Language;
  let text = dictionary[key]?.[language] || dictionary[key]?.["ar"] || "";
  
  for (const [k, v] of Object.entries(params)) {
    text = text.replace(`{${k}}`, v);
  }
  
  return text;
}

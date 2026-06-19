/**
 * reset-ai-quota.ts
 * Usage:
 *   Reset all tenants: npm run reset-quota
 */

import { config } from "dotenv";
import { resolve } from "path";
// Load .env variables manually for standalone scripts
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), ".env.local") });

import { connectToDatabase } from "@/lib/mongodb";
import { TenantSubscription } from "@/lib/models";

const MONTHLY_LIMIT = 1_000_000; // مليون رسالة لتسهيل مرحلة التطوير

async function main() {
  await connectToDatabase();

  console.log("🔄 جاري تصفير رسائل جميع المستخدمين...");

  const result = await TenantSubscription.updateMany({}, {
    $set: {
      usedMessages: 0,
      monthlyMessageLimit: MONTHLY_LIMIT,
      extraMessageCredits: 999_999,
      status: "active",
    },
  });

  console.log(`✅ تم التحديث بنجاح: تم تصفير رسائل ${result.modifiedCount} مستأجر.`);
  console.log(`تم تعيين الحد الشهري لـ ${MONTHLY_LIMIT.toLocaleString()} رسالة لجميع المستخدمين لتناسب مرحلة التطوير.`);

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ خطأ:", err.message);
  process.exit(1);
});

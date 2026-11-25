import { createClient } from "npm:@supabase/supabase-js@2.89.0";
import { createFcmSender, parseFcmAccount } from "../_shared/fcm.ts";
import { nativeDeviceHandler } from "../_shared/native-device.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const serviceAccount = parseFcmAccount(Deno.env.get("FCM_SERVICE_ACCOUNT_JSON"));
const appOrigin = Deno.env.get("APP_ORIGIN");
const send = serviceAccount ? createFcmSender(serviceAccount, fetch, appOrigin) : async () => { throw new Error("FCM_NOT_CONFIGURED"); };
Deno.serve(nativeDeviceHandler({
  configured: !!serviceAccount,
  allowedOrigin: appOrigin,
  action: async params => await db.rpc("native_device_action", params),
  send,
  authenticate: async (jwt, scope) => {
    const { data: { user }, error } = await db.auth.getUser(jwt);
    if (error || !user) return null;
    const client = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: "Bearer " + jwt } } });
    if (scope === "admin") {
      const { data, error } = await client.rpc("my_access");
      if (error || data?.role !== "full") return null;
      return { userId: user.id, captainId: null, email: user.email?.toLowerCase() || null };
    }
    const { data: captainId, error: ce } = await client.rpc("my_captain_id");
    if (ce || !captainId) return null;
    const { data: captain } = await db.from("captains").select("active").eq("id", captainId).single();
    return captain?.active ? { userId: user.id, captainId, email: null } : null;
  }
}));

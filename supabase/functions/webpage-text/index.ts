import { createClient } from "npm:@supabase/supabase-js@2.89.0";
import { webpageTextHandler } from "../_shared/webpage-text.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
Deno.serve(webpageTextHandler({
  allowedOrigin: Deno.env.get("APP_ORIGIN"),
  token: Deno.env.get("APY_TOKEN"), // server-only: the ApyHub token is never sent to a client
  authenticate: async jwt => {
    const client = createClient(url, anon, {
      auth: { persistSession: false }, global: { headers: { Authorization: "Bearer " + jwt } }
    });
    const { data, error } = await client.rpc("my_access");
    return !error && data?.role === "full";
  }
}));

import { createClient } from "npm:@supabase/supabase-js@2.89.0";
import { adminPasswordHandler } from "../_shared/admin-set-password.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
Deno.serve(adminPasswordHandler({
  allowedOrigin: Deno.env.get("APP_ORIGIN"),
  admin: createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, options),
  userClient: token => createClient(url, anon, { ...options, global: { headers: { Authorization: "Bearer " + token } } }),
}));

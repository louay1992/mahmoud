import { createClient } from "npm:@supabase/supabase-js@2.89.0";
import { normalizeOrigin } from "../_shared/admin-set-password.ts";
import { createOwnerInviteHandler } from "../_shared/owner-invite-admin.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
Deno.serve(createOwnerInviteHandler({
  allowedOrigin: normalizeOrigin(Deno.env.get("APP_ORIGIN")),
  service: createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, options),
  publicAuth: createClient(url, anon, options).auth,
  userClient: jwt => createClient(url, anon, { ...options, global: { headers: { Authorization: "Bearer " + jwt } } }),
}));

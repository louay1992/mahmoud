import { createClient } from "npm:@supabase/supabase-js@2.89.0";
import { normalizeOrigin } from "../_shared/admin-set-password.ts";
import { createOwnerInviteHandler } from "../_shared/owner-invite-admin.ts";
import { createOwnerAccountHandler } from "../_shared/owner-manage-admin.ts";
const url=Deno.env.get("SUPABASE_URL")!;
const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
const service=createClient(url,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,options);
const publicClient=createClient(url,Deno.env.get("SUPABASE_ANON_KEY")!,options);
const allowedOrigin=normalizeOrigin(Deno.env.get("APP_ORIGIN"));
Deno.serve(createOwnerAccountHandler({allowedOrigin,service,
 userClient:jwt=>createClient(url,Deno.env.get("SUPABASE_ANON_KEY")!,{...options,global:{headers:{Authorization:"Bearer "+jwt}}}),
 invite:createOwnerInviteHandler({allowedOrigin,service,publicAuth:publicClient.auth})}));

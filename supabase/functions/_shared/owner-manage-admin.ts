import { corsHeaders } from "./admin-set-password.ts";
/** Owner-only account changes. Business-role revocation is durable before deleting an Auth identity. */
export function createOwnerAccountHandler({allowedOrigin,service,userClient,invite}:{allowedOrigin:string;service:any;userClient:(jwt:string)=>any;invite:(request:Request)=>Promise<Response>}){
 const production=["https://hhyyw.netlify.app","https://applications.nature-care.net","https://owner.nature-care.net"];
 const origins=new Set(production.includes(allowedOrigin)?production:[allowedOrigin]);
 return async(req:Request):Promise<Response>=>{
  const origin=req.headers.get("origin"),headers={...corsHeaders(origin&&origins.has(origin)?origin:allowedOrigin),"Content-Type":"application/json"};
  const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(origin&&!origins.has(origin))return json({error:"forbidden origin"},403);
  if(req.method==="OPTIONS")return new Response(null,{headers});if(req.method!=="POST")return json({error:"method"},405);
  try{
   const jwt=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");if(!jwt)return json({error:"سجّل الدخول إلى لوحة المالك"},401);
   const {data:identity,error}=await service.auth.getUser(jwt);if(error||!identity?.user?.id)return json({error:"تعذّر التحقق من الجلسة"},401);
   const client=userClient(jwt),owner=await client.rpc("is_subscription_owner");if(owner.error||owner.data!==true)return json({error:"هذا الإجراء لمالك النظام فقط"},403);
   const strong=await client.rpc("owner_has_strong_session");
   if(strong.error)return json({error:"تعذّر التحقق من أمان جلسة المالك"},503);
   if(strong.data!==true)return json({error:"أكمل التحقق بخطوتين من حساب المالك",code:"OWNER_MFA_REQUIRED"},403);
   const raw=await req.text();if(raw.length>4096)return json({error:"الطلب طويل جدًا"},400);let body:any;try{body=JSON.parse(raw);}catch{return json({error:"طلب غير صالح"},400);}
   const email=typeof body.email==="string"?body.email.trim().toLowerCase():"",name=typeof body.name==="string"?body.name.trim():"";
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||name.length>100)return json({error:"أدخل بريدًا صحيحًا واسمًا لا يتجاوز 100 حرف"},400);
   if(body.action==="update"){
    const next=typeof body.new_email==="string"?body.new_email.trim().toLowerCase():email;
    if(next!==email){
     if(next.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next))return json({error:"البريد الجديد غير صالح"},400);
     const prepared=await client.rpc("owner_begin_admin_email_change",{p_email:email,p_new_email:next,p_name:name});if(prepared.error)return json({error:prepared.error.message},400);
     const sent=await invite(new Request(req.url,{method:"POST",headers:req.headers,body:JSON.stringify({email:next,name})}));
     if(!sent.ok){const result=await sent.json();return json({error:result.error||"تعذّر إرسال رابط البريد الجديد. الحساب الحالي مستمر حتى التفعيل"},sent.status);}
     return json({ok:true,pending_verification:true,email:next,message:"أُرسل رابط إلى البريد الجديد. يبقى الحساب الحالي حتى تأكيد البريد وتعيين كلمة المرور"});
    }
    const saved=await client.rpc("owner_update_admin_profile",{p_email:email,p_name:name});return saved.error?json({error:saved.error.message},400):json({ok:true,message:"حُفظت معلومات الحساب"});
   }
   if(body.action==="delete"){
    const prepared=await client.rpc("owner_prepare_admin_delete",{p_email:email,p_confirmation:String(body.confirmation||"")});if(prepared.error)return json({error:prepared.error.message},400);
    const id=prepared.data?.operation_id,params={p_owner:identity.user.id,p_operation:id};
    const target=await service.rpc("owner_admin_delete_target",params);if(target.error)return json({error:"أزيلت الصلاحية، لكن تعذّر التحقق من حذف حساب الدخول. حدّث القائمة"},503);
    if(!target.data.complete&&target.data.auth_user_id){
     const deleted=await service.auth.admin.deleteUser(target.data.auth_user_id);
     if(deleted.error&&deleted.error.status!==404&&deleted.error.code!=="user_not_found")return json({ok:false,access_revoked:true,error:"تم إيقاف الحساب وإلغاء دعواته. تعذّر حذف حساب الدخول؛ يمكنك إكمال الحذف من القائمة"},202);
     const finished=await service.rpc("owner_finish_admin_delete",params);if(finished.error)return json({ok:false,access_revoked:true,error:"تم حذف حساب الدخول. حدّث الحالة لتأكيد انتهاء العملية"},202);
    }
    return json({ok:true,message:"حُذف الحساب الإداري وأُلغي وصوله إلى النظام"});
   }
   return json({error:"عملية غير صالحة"},400);
  }catch{return json({error:"تعذّر إكمال العملية. حدّث الحالة قبل إعادة المحاولة"},503);}
 };
}

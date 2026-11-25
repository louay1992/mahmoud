# نظام إدارة كباتن التوصيل

تطبيقان واجهيان عربيان (RTL) على قاعدة **Supabase** واحدة، مع تطبيقَي Android أصليين ونسخة ويب/PWA تُنشر على Netlify:

| التطبيق | الصفحة | المستخدمون |
| --- | --- | --- |
| الإدارة | `admin.html` | إداري كامل، وموظفون بصلاحيات محدودة |
| الكابتن | `captain.html` | كباتن التوصيل: طلباتهم، جرد مستودعهم، حسابهم |
| البوابة | `index.html` | اختيار التطبيق |

الواجهة بلا إطار عمل ولا bundler: HTML/CSS/JS خام، ومكتبة Supabase مثبّتة محليًا في `vendor/supabase.js`.
كل منطق البيانات والصلاحيات على الخادم (جداول + RLS + دوال RPC)، والعميل يقرأ ويستدعي RPC فقط.

## البداية السريعة

```bash
npm ci            # Node 24 (انظر engines في package.json)
npm run check     # فحص الصياغة والربط وتغطية RPC ومركزية الإعدادات
npm test          # اختبارات الوحدة (Node)
npm run build     # ينتج dist/ جاهزًا للنشر
```

تشغيل محلي للواجهة: أي خادم ملفات ساكن من جذر المشروع (`npx serve .` أو `python -m http.server`)، ثم فتح `/admin.html` أو `/captain.html`.
لا يوجد خادم تطبيق: الصفحات تتصل مباشرة بـ Supabase.

## بنية المشروع

```
app-config.js          مصدر وحيد لعنوان Supabase والمفتاح العام وأصل التطبيق (يقرأه الويب وAndroid والبناء)
admin.html             هيكل صفحة الإدارة (~64 سطرًا) — بدون أنماط أو سكربت مضمّن
admin.css              أنماط سطح المكتب للواجهة الإدارية
admin-app.js           منطق تطبيق الإدارة: البيانات، النماذج، الطباعة، الحسابات
admin-mobile.js/.css   واجهة تشغيل الطلبات على الهاتف (حتى 719px)
admin-workspace.js/.css مساحة عمل الهاتف: المخزون، المستودعات، الربحية، الإحصائيات
admin-motion.js        الحركة ودلالات النوافذ (يُلغى عند prefers-reduced-motion)
captain.html/.css/.js  تطبيق الكابتن
auth-session.js        بوابة الجلسة والخروج الآمن
offline-data.js/.css   عرض دون اتصال (IndexedDB لكل حساب، قراءة فقط)
app-refresh.js/.css    تحديث آمن للبيانات والواجهة وسحب للتحديث
mobile-ui.js           أدوات مشتركة: النسخ، CSV، زر الرجوع، لوحة المفاتيح
native-push.js         جسر مضيف Android الأصلي
push-client.js         اشتراك Web Push المشترك
push-diagnostics.js    تشخيصات الإشعارات (تطبيق الكابتن)
sw.js                  حزمة العمل دون اتصال العامة والمتحقَّق منها ببصمات SHA-256
schema.sql             مخطط Supabase الكامل (يُطبَّق من أعلاه إلى أسفله)
supabase/migrations/   ترحيلات لاحقة: أجهزة FCM، تفضيلات الإشعارات الأصلية
supabase/functions/    Edge Functions: send-push، native-device، admin-set-password، webpage-text
android/               مضيف WebView أصلي بنكهتين (admin/captain) + FCM + اختبارات Robolectric
scripts/               build-web، build-android، prepare-deployment، check-project
tests/                 اختبارات Node وPlaywright
docs/                  قرارات التصميم والتحقق لكل إصدار
```

## الإعدادات والبيئة

- **الويب وAndroid**: كل العناوين في `app-config.js` فقط. `android/app/build.gradle` يقرأ منها المفتاح والعنوان وأصل التطبيق، و`scripts/build-web.cjs` يضمّنها في `dist/`. لا تكتب عنوان مشروع أو مفتاحًا داخل الصفحات.
  المفتاح المضمّن هو **anon public** ومصمَّم للوصول من العميل؛ الصلاحيات يحكمها RLS. لا تضع أي مفتاح إداري كامل الصلاحية أو أي سرّ في هذا الملف.
- **Edge Functions**: تُقرأ الأسرار من بيئة Supabase فقط: `SUPABASE_URL`، `SUPABASE_ANON_KEY`، `APY_TOKEN` (ApyHub)، واختياريًا `APP_ORIGIN` (أصل CORS وأصل روابط الإشعارات، افتراضيًا `https://hhyyw.netlify.app`). أمّا الإعدادات الحسّاسة لخدمة Firebase فتُضاف من لوحة Supabase وحدها، ولا تُكتب قيمها في المستودع ولا في هذه الوثيقة.
- **قيم فارغة للتوثيق**: `.env.example` يسرد أسماء الأسرار بقيم فارغة فقط؛ لا يُوضع فيه أي قيمة حقيقية.
- **النشر**: `netlify.toml` ينشر `dist/` ويضيف تحويلات `/admin` و`/captain` ورؤوس عدم التخزين المؤقت لملفات الإصدار.

## قاعدة البيانات

`schema.sql` هو المخطط الكامل لأي تركيب جديد، ويُطبَّق **من أعلاه إلى أسفله في دفعة واحدة**.
الدوال مكتوبة بـ `create or replace`، وتعريفها الأخير هو النافذ؛ لذلك تظهر `deliver_order` و`create_order` وغيرهما أكثر من مرة بوصفها مراحل تطوير. لا تعِد ترتيبها ولا تحذف نسخة قديمة قبل التحقق على قاعدة اختبار.

- الترحيلات المنفصلة في `supabase/migrations` تُطبَّق **بعد** `schema.sql` ولا تُدمج فيه إلا إذا لزم أن يصل أثرها لأي تركيب من الصفر.
- `npm run check` يفشل إذا استدعى العميل RPC غير معرّف في المخطط أو الترحيلات، ويسرد الدوال المُعاد تعريفها بلا فشل.
- **أساس الإنتاج v17–v23**: `supabase/migrations/20261125091500_production_baseline_v17_v23.sql` يحمل نصًّا كل ما كان `schema.sql` يصفه بالتعليقات فقط: 18 دالة (`my_access`, `staff_lookups`, `create_order` بتوقيعه الكامل, `create_shipment`, `set_shipment_status`, `update_shipment`, `add_carrier_payment`, `mark_notifications_read`, `admin_profit_items`, `guard_once`, `notify`, `order_lines`, `fmt_money`, `has_perm`, `my_warehouse_id`, `norm_phone`, `trg_customer`, `trg_dup_guard`)، و6 جداول (`customers`, `op_guard`, `carriers`, `carrier_payments`, `shipment_events`, `notifications`)، وأعمدة الشحن وصلاحيات الموظفين والمحافظات، وسياسات RLS ومشغّلاتها وصلاحياتها. سُحب من المشروع بقراءة فقط في 2026-11-25 ويُختبر بتطبيقه مرتين على PGlite في `tests/schema-baseline.test.cjs`. `supabase/untracked-rpcs.txt` بقي فارغًا كحاجز ضد أي انحراف جديد.
- **تكافؤ الإنتاج المتبقي**: `supabase/migrations/20261125103000_staff_policies_and_constraint_parity.sql` يضيف سياستي القراءة `staff_orders` و`staff_order_items` (الموظف يرى طلباته هو فقط) ويلغي قيد `main_no_captain` الذي حذفه الإنتاج في v19. قوبلت الكائنات كلها مع `pg_catalog` في المشروع: الفهارس (39) والمشغّلات (14) والـViews الثلاثة (`captain_balances`, `marketer_balances`, `order_profits` بـ `security_invoker=true`) مطابقة، ولم يبق فرق آخر.
- **سجل الترحيلات**: النسخ `20261124180741`, `20261124203345`, `20261125091500`, `20261125103000` مسجّلة في `supabase_migrations.schema_migrations` لأن كائناتها طُبّقت فعلًا على المشروع (الأوليان عبر لوحة Supabase والأخيران نصًّا). بدون هذا التسجيل يعيد `supabase db push` تطبيقها: الأوليان تفشلان (`create table` بلا `if not exists`) والثالثة تُعيد إنشاء ما هو موجود. تحقق قبل أي `db push` بـ:

```sql
select version, name from supabase_migrations.schema_migrations order by version;
```
- الأدوار: `full` (إداري كامل)، موظف بصلاحيات (`create_orders`, `view_orders`, `pick_captain`, `pick_marketer`)، وكابتن. كل القراءات محمية بـ RLS ودوال `security definer` تتحقق من الدور.

### نشر Edge Functions

```bash
node scripts/prepare-deployment.cjs   # ينتج artifacts/supabase/{send-push,native-device}.ts بلا أسرار
npx supabase functions deploy send-push --no-verify-jwt
npx supabase functions deploy native-device --no-verify-jwt
npx supabase functions deploy admin-set-password
npx supabase functions deploy webpage-text --no-verify-jwt
```

`send-push` يولّد مفاتيح VAPID تلقائيًا ويحفظها في `push_config`، ويتحقق من كلمة سرّ مشتركة؛ لا تصل هذه القيم إلى أي تطبيق.

### استخراج نص صفحة (ApyHub)

`webpage-text` دالة خادم تعيد **كل النص الظاهر** في صفحة عامة (بما فيه التنقّل والتذييل) عبر خدمة ApyHub `extract-visible-text-from-a-webpage`.
الرمز `APY_TOKEN` يُقرأ من بيئة Supabase فقط ويُرسل في ترويسة `apy-token`؛ لا يصل إلى أي صفحة أو تطبيق.

```bash
curl "$SUPABASE_URL/functions/v1/webpage-text?url=https://apyhub.com/pricing" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

- تتطلب جلسة إداري كامل (`my_access.role = full`) وترفض `OPTIONS`/الطرق الأخرى.
- تقبل روابط `http`/`https` العامة فقط: تُرفض العناوين الخاصة والمناطقية (localhost، 10/8، 192.168/16، 169.254/16، `fc00::/7`، `fe80::/10`، `::1`) وأي رابط فيه بيانات دخول.
- الاستجابة `{ url, text, characters, truncated }` بحد 20000 حرف؛ الأخطاء عربية بحالة مناسبة (400 رابط، 401/403 صلاحية، 429 حدّ الطلبات، 502/503 الخدمة).
- النص مُدخل غير موثوق: يُعرض كنصّ فقط (`textContent`)، لا يُحقن في HTML، ويُنظّف من محارف التحكم قبل الإرجاع.

## البناء والنشر

- **الويب**: `npm run build` ينتج `dist/` (ملفات عامة فقط)، ويحسب بصمة بناء مستقلة لكل تطبيق تُحقن في `meta[name="delivery-build"]`، ويكتب `app-version.json` و`offline-shell-manifest.json` ببصمات SHA-256 لكل ملف. يعمل `sw.js` على حزمة مكتملة ومتحقَّق منها فقط، ويحتفظ بالنسخة السابقة إذا فشل أي ملف.
- **Android**: `scripts/build-android.ps1` يبني النكهتين ويوقّعهما ويتحقق من بصمة الشهادة في `.well-known/assetlinks.json` ومن إصدار الحزمة. يتطلب `android/app/google-services.json` (غير مرفوع) و`app-config.js`. مسار GitHub Actions ينتج بناءً غير موقّع عند توفر سر `GOOGLE_SERVICES_JSON`.

## العمل دون اتصال

قراءة فقط: `offline-data.js` يحفظ قراءات Supabase في IndexedDB مستقلة لكل تطبيق ومرتبطة بمعرّف الحساب، و`sw.js` يحفظ الواجهة العامة فقط.
لا توجد طوابير كتابة ولا إعادة إرسال؛ كل إنشاء/تعديل يتطلب اتصالًا. الخروج يمسح البيانات المحلية حتى لو فشل طلب الخروج البعيد. التفاصيل في `docs/offline-readonly-1.3.0.md`.

## الاختبارات وCI

```bash
npm run check                     # بلا تبعيات
npm test                          # وحدات Node
npm run test:workspace            # Playwright: مساحة عمل الإدارة (يتطلب npx playwright install chromium)
npm run test:offline              # IndexedDB وService Worker فعليان
npm run test:auth                 # الدخول والخروج
npm run test:android-wiring       # ربط إشعارات Android (Python)
```

سير العمل `.github/workflows/notifications.yml` يشغّل الفحص والاختبارات وكل اختبارات المتصفح على كل تغيير في الواجهة أو قاعدة البيانات أو Android. تقارير التصميم والتحقق لكل إصدار في `docs/`.

## القواعد المتّبعة

- تغيير واحد مركّز مع اختبار يغطيه؛ لا مكتبة جديدة لمجرد توفرها (لا إطار واجهات ولا تبعية بناء).
- الأسرار لا تدخل المستودع ولا `dist/`؛ `app-config.js` للقيم العامة فقط.
- عربية RTL في الواجهة، وأسماء الكود والدوال بالإنجليزية.
- مسافات بادئة 2 وحقول LF كما في `.editorconfig`، و`npm run check` قبل كل commit.

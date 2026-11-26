# النسخ الاحتياطي لنظام إدارة المندوبين والمستودعات

يشغّل GitHub Actions نسخة يومية من مشروع Supabase «محمود» الساعة 05:00 بتوقيت دمشق. يمكن تشغيل نسخة إضافية يدوياً من إجراء **Production backup to Backblaze B2** على فرع `main`.

تشمل النسخة PostgreSQL بكل مخططاته المتاحة، ومن ضمنها بيانات التطبيق والمصادقة وسياسات الوصول وإعدادات حاويات Storage. تُنسخ ملفات Storage إلى الأرشيف وتُسجل أسماؤها الأصلية وبصمات SHA-256 في ملف الفهرس. عند عدم وجود ملفات يكون الفهرس فارغاً. يتوقف التنفيذ إذا تغير فهرس Storage أثناء النسخ.

## إعداد GitHub Actions

| النوع | الاسم | القيمة |
| --- | --- | --- |
| Secret | `BACKUP_SUPABASE_DB_URL` | رابط PostgreSQL للإنتاج عبر Session pooler على المنفذ 5432. استخدم كلمة المرور الحالية بترميز URL واحذف معاملات الاستعلام. |
| Secret | `BACKUP_SUPABASE_STORAGE_KEY_ID` | معرّف مفتاح Supabase Storage S3 عند وجود ملفات. |
| Secret | `BACKUP_SUPABASE_STORAGE_KEY` | سر مفتاح Supabase Storage S3 عند وجود ملفات. |
| Variable | `BACKUP_SUPABASE_STORAGE_REGION` | المنطقة الظاهرة في صفحة إعداد S3 للمشروع عند وجود ملفات. |
| Secret | `BACKUP_B2_KEY_ID` | معرّف مفتاح Backblaze المقيد بالحاوية. |
| Secret | `BACKUP_B2_KEY` | سر مفتاح Backblaze المقيد بالحاوية. |
| Variable | `BACKUP_B2_REGION` | المنطقة من عنوان S3 لحاوية Backblaze. |
| Variable | `BACKUP_B2_BUCKET` | اسم حاوية Backblaze الخاصة المخصصة لهذا المشروع. |
| Variable | `BACKUP_AGE_RECIPIENT` | المفتاح العام الناتج عن `age-keygen` ويبدأ بـ `age1`. احتفظ بالمفتاح الخاص في مكان آمن لاستعادة النسخ. |

يحتاج مفتاح Backblaze إلى قراءة إعداد الحاوية ورفع الملفات وقراءتها للتحقق. استخدم مفتاحاً خاصاً بالحاوية مع صلاحيات `listBuckets` و`readBuckets` و`listFiles` و`readFiles` و`writeFiles` و`listAllBucketNames` حسب إعداد Backblaze. عطّل صلاحية حذف النسخ إن كان المفتاح المخصص يدعم ذلك.

بعد إعداد القيم، شغّل الإجراء يدوياً وتأكد من ظهور `Verified` في السجل ومن وجود الأرشيف وملف `.verified.json` بجانبه داخل المسار `delivery-production/`. يطابق الإجراء حجم ومحتوى الأرشيف بعد تنزيله من Backblaze قبل كتابة ملف التحقق. تابع عمليات GitHub Actions. يوقف GitHub الجداول الزمنية في المستودعات العامة بعد 60 يوماً من عدم النشاط.

## الاستعادة التجريبية

نزّل الأرشيف وملف التحقق من الحاوية الخاصة. قارن بصمة الملف المشفّر ببصمة `sha256` في ملف التحقق ثم فكّه على جهاز موثوق.

```bash
sha256sum backup.tar.gz.age
age --decrypt -i /secure/path/age-identity.txt -o backup.tar.gz backup.tar.gz.age
mkdir -m 700 recovery
tar -xzf backup.tar.gz -C recovery
pg_restore --list recovery/database.dump
```

جرّب الاستعادة في بيئة Supabase معزولة. راجع قائمة `pg_restore` والأدوار في `roles.sql` قبل تطبيقها على الخدمة المُدارة، التي تنشئ أدوارها ومخططاتها الأساسية مسبقاً. أنشئ الحاويات بحسب الإعدادات المحفوظة، وارفع الملفات عبر Storage API بالأسماء الأصلية في `storage.jsonl`. تجنب إدخال صفوف `storage.objects` قبل رفع الملفات عبر الـ API. قارن عدد صفوف التطبيق والمستخدمين وعدد الملفات وبصماتها، وراجع صلاحيات الملفات إذا كانت تعتمد على المالك.

إعدادات الخدمات خارج PostgreSQL، مثل أسرار Edge Functions وإعدادات بريد المصادقة، تُهيّأ بصورة مستقلة عند الاستعادة. يحتوي `roles.sql` على تعريفات الأدوار وصلاحياتها دون كلمات مرور أدوار PostgreSQL.

# اختيار المتصفح لإشعارات 1.0.2

لقطة الإداري بعد 1.0.1 أظهرت `SamsungBrowser/31.0 Chrome/148.0.0.0`، وإذنًا فعليًا `default` رغم رجوع طلب الإذن بـ`granted`، دون اشتراك. النطاق `/admin` صحيح، لكن اختيار المتصفح بقي تلقائيًا.

جدول دعم المكتبة الرسمي يذكر أن Samsung Internet يدعم TWA ولا يدعم تفويض الإشعارات، بينما Chrome يدعم الاثنين. هذا دليل يفسّر مشكلة جهاز المستخدم؛ لا يثبت نجاح الإشعارات على الجهاز قبل تجربته.

التعديل يختار الحزمة `com.android.chrome` صراحة عبر `createTwaLauncher()` ومُنشئ `TwaLauncher(Context, String)` في المكتبة المثبتة 2.5.0. يُفحص وجود Chrome وتفعيله وخدمته الداعمة لـTWA قبل محاولة التشغيل، مع تصريح رؤية الحزمة في AndroidManifest. عند غيابه أو تعطيله أو عدم دعم خدمته، تظهر رسالة تثبيت/تفعيل/تحديث، ولا يُختار Samsung Internet تلقائيًا.

الاختيار يخص التطبيق، ولا يغيّر المتصفح الافتراضي للنظام. بيانات الدخول المحلية تخص المتصفح؛ الانتقال من Samsung Internet إلى Chrome قد يستلزم تسجيل الدخول مجددًا. بيانات الطلبات والحسابات محفوظة بالخادم.

الإصدار 1.0.2، ورمز الإصدار 3، بنفس أسماء الحزم وشهادة التوقيع السابقة. يختبر بناء أندرويد غياب Chrome وتعطيله وغياب خدمة TWA وتوفره عند وجود متصفح Samsung افتراضي، إضافة إلى فحص اتجاه طلب الخدمة إلى حزمة Chrome صراحة. يبقى فحص التفويض ووصول Push على الهاتف المقفل اختبار الجهاز النهائي.

المراجع الأساسية:

- [جدول دعم المتصفحات الرسمي](https://github.com/GoogleChrome/android-browser-helper/blob/main/docs/trusted-web-activity-browser-support.md)
- [TwaLauncher في المكتبة 2.5.0](https://github.com/GoogleChrome/android-browser-helper/blob/android-browser-helper-2.5.0/androidbrowserhelper/src/main/java/com/google/androidbrowserhelper/trusted/TwaLauncher.java)
- [اختيار المتصفح الافتراضي في المكتبة 2.5.0](https://github.com/GoogleChrome/android-browser-helper/blob/android-browser-helper-2.5.0/androidbrowserhelper/src/main/java/com/google/androidbrowserhelper/trusted/TwaProviderPicker.java)

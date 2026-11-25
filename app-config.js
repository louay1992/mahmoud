/* Source of truth for deployment endpoints.
   Read by admin-app.js, captain-app.js, android/app/build.gradle and scripts/build-web.cjs.
   These are public values (the Supabase anon key is designed to ship in the client); never add
   secrets or service-role keys here. The Edge Functions read their own credentials from Deno env. */
globalThis.DELIVERY_CONFIG = Object.freeze({
  supabaseUrl: "https://jabapvnmfdflysxfxwwf.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphYmFwdm5tZmRmbHlzeGZ4d3dmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU1MTg2OTQsImV4cCI6MjExMTA5NDY5NH0.V-Axtg4cGwiSYNhcefmks0MP4iOn2DW5Ai74Ji8cv9I",
  appOrigin: "https://hhyyw.netlify.app",
  functionsPath: "/functions/v1",
});

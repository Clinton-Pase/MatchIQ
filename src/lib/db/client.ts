// src/lib/db/client.ts
// Two Supabase clients:
//   getAnonClient()    safe for the browser and server components, read-only (RLS enforces it)
//   getServiceClient() SERVER ONLY, full write access. Never import this from a client component.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Add it to .env.local (see the setup notes).`);
  return v;
}

export function getAnonClient(): SupabaseClient {
  return createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false },
  });
}

export function getServiceClient(): SupabaseClient {
  return createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}
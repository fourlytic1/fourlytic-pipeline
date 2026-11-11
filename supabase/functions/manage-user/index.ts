// Supabase Edge Function: manage-user
// Lets an ADMIN create or update team accounts (including setting
// passwords) without ever shipping the service_role key to the browser.
// Deploy via: Supabase Dashboard -> Edge Functions -> New function
// (name it exactly "manage-user") and paste this file's contents in.
//
// Required secrets (already available by default in every Edge Function):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Client acting AS the caller — used only to find out who they are.
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) {
      return json({ error: "Not signed in." }, 401);
    }

    // Privileged client — bypasses RLS, used only after we've verified admin.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: callerProfile, error: profileErr } = await admin
      .from("profiles")
      .select("role, active")
      .eq("id", user.id)
      .maybeSingle();

    if (profileErr || !callerProfile || callerProfile.role !== "admin" || !callerProfile.active) {
      return json({ error: "Admin access required." }, 403);
    }

    const body = await req.json();
    const action = body.action;

    if (action === "create") {
      const { username, email, displayName, role, password } = body;
      if (!username || !email || !displayName || !role || !password) {
        return json({ error: "Missing required fields." }, 400);
      }
      const { data: existing } = await admin
        .from("profiles")
        .select("id")
        .ilike("username", username)
        .maybeSingle();
      if (existing) return json({ error: "That username is already taken." }, 400);

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (createErr || !created?.user) {
        return json({ error: createErr?.message || "Could not create account." }, 400);
      }

      const { error: insertErr } = await admin.from("profiles").insert({
        id: created.user.id,
        username,
        email,
        display_name: displayName,
        role,
        active: true,
      });
      if (insertErr) {
        // Roll back the auth user so we don't leave an orphaned account.
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: insertErr.message }, 400);
      }
      return json({ ok: true, id: created.user.id });
    }

    if (action === "update") {
      const { targetId, displayName, role, active, password } = body;
      if (!targetId) return json({ error: "Missing targetId." }, 400);

      // Guard: an admin may not demote or deactivate their own account.
      // Without this, the only admin could accidentally lock everyone
      // (including themselves) out of the Admin Panel with no recovery path.
      if (targetId === user.id) {
        if (role !== undefined && role !== "admin") {
          return json({ error: "You can't change your own account's role away from admin." }, 400);
        }
        if (active !== undefined && active === false) {
          return json({ error: "You can't deactivate your own account." }, 400);
        }
      }

      const patch: Record<string, unknown> = {};
      if (displayName !== undefined) patch.display_name = displayName;
      if (role !== undefined) patch.role = role;
      if (active !== undefined) patch.active = active;

      if (Object.keys(patch).length) {
        const { error: updErr } = await admin.from("profiles").update(patch).eq("id", targetId);
        if (updErr) return json({ error: updErr.message }, 400);
      }
      if (password) {
        const { error: pwErr } = await admin.auth.admin.updateUserById(targetId, { password });
        if (pwErr) return json({ error: pwErr.message }, 400);
      }
      return json({ ok: true });
    }

    if (action === "delete") {
      const { targetId } = body;
      if (!targetId) return json({ error: "Missing targetId." }, 400);

      if (targetId === user.id) {
        return json({ error: "You can't delete your own account." }, 400);
      }

      const { data: target, error: targetErr } = await admin
        .from("profiles")
        .select("role")
        .eq("id", targetId)
        .maybeSingle();
      if (targetErr || !target) return json({ error: "User not found." }, 404);

      // Guard: never allow deleting the last remaining admin — that would
      // lock everyone out of the Admin Panel with no recovery path.
      if (target.role === "admin") {
        const { count, error: countErr } = await admin
          .from("profiles")
          .select("id", { count: "exact", head: true })
          .eq("role", "admin");
        if (countErr) return json({ error: countErr.message }, 400);
        if ((count ?? 0) <= 1) {
          return json({ error: "You can't delete the only remaining admin." }, 400);
        }
      }

      // Deleting the auth user cascades to its profiles row (FK: profiles.id
      // references auth.users(id) on delete cascade), so no separate
      // profiles delete is needed.
      const { error: delErr } = await admin.auth.admin.deleteUser(targetId);
      if (delErr) return json({ error: delErr.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

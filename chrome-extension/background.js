// Fourlytic Gmail Sync — background service worker
// Talks to Supabase's REST/Auth API directly via fetch (no bundled
// client library needed). Holds the signed-in team member's session
// and does every CRM read/write on behalf of content.js and popup.js.

const SUPABASE_URL = "https://rnblkqlmfxwjgfsujyxg.supabase.co";
const ANON_KEY = "sb_publishable_lAdlOIv3DQYAVI-BoTkESg_0pE9halW";

/* ---------------- session storage ---------------- */
async function getSession() {
  const { session } = await chrome.storage.local.get("session");
  return session || null;
}
async function setSession(session) {
  await chrome.storage.local.set({ session });
}
async function clearSession() {
  await chrome.storage.local.remove("session");
}

/* ---------------- auth ---------------- */
async function login(username, password) {
  // Same two-step flow as the main app: look up the email for this
  // username (RPC, callable anonymously), then sign in with password.
  const lookupRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/email_for_username`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ p_username: username.trim() }),
  });
  const email = await lookupRes.json().catch(() => null);
  if (!lookupRes.ok || !email) return { ok: false, error: "Invalid username or password." };

  const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const tokenData = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok || !tokenData?.access_token) {
    return { ok: false, error: "Invalid username or password." };
  }

  const profile = await fetchProfile(tokenData.access_token, tokenData.user.id);
  if (!profile) return { ok: false, error: "Could not load your profile." };
  if (!profile.active) return { ok: false, error: "This account is inactive." };

  await setSession({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + tokenData.expires_in * 1000,
    user_id: tokenData.user.id,
    display_name: profile.display_name,
    username: profile.username,
    email: tokenData.user.email,
  });
  return { ok: true, displayName: profile.display_name };
}

async function fetchProfile(accessToken, userId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=display_name,username,active`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  const rows = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(rows) || !rows[0]) return null;
  return rows[0];
}

async function refreshSession(session) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) return null;
  const updated = {
    ...session,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await setSession(updated);
  return updated;
}

async function logout() {
  const session = await getSession();
  if (session) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.access_token}` },
      });
    } catch (e) { /* ignore — clearing local session either way */ }
  }
  await clearSession();
}

// Several callers can land here at once (e.g. one CHECK_EMAIL per
// compose-window recipient chip, fired in a loop with no await between
// them). Without this, each one independently POSTs the SAME refresh
// token to /auth/v1/token?grant_type=refresh_token at once; Supabase's
// refresh-token rotation treats all but the first as reusing an already-
// rotated token and can fail them, or in stricter configurations revoke
// the whole session. Sharing one in-flight refresh fixes that.
let refreshPromise = null;

// Returns a session with a valid (non-expired) access token, refreshing
// it first if needed. Returns null if not logged in or refresh fails.
async function getValidSession() {
  let session = await getSession();
  if (!session) return null;
  if (Date.now() > session.expires_at - 60000) {
    if (!refreshPromise) {
      refreshPromise = refreshSession(session).finally(() => { refreshPromise = null; });
    }
    session = await refreshPromise;
    if (!session) { await clearSession(); return null; }
  }
  return session;
}

/* ---------------- CRM REST calls ---------------- */
async function restFetch(session, path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Request failed (${res.status})`);
    err.status = res.status; // lets callers tell "expected conflict" apart from a real failure
    throw err;
  }
  return data;
}

// Escapes ilike's own wildcard characters so an email containing a
// literal "%" or "_" (rare but valid) can't be (mis)treated as a
// pattern -- this keeps the ilike filter a plain case-insensitive exact
// match, nothing more.
function escapeIlike(value) {
  return value.replace(/[\\%_]/g, (c) => "\\" + c);
}

async function findContactByEmail(session, email) {
  // Case-insensitive on purpose: Gmail always hands us a lowercased
  // address, but a contact may have been entered with mixed case
  // elsewhere in the CRM. A case-sensitive eq. match would silently
  // miss that contact and let a duplicate get created for the same
  // person. order=created_at.asc makes the pick deterministic if a
  // duplicate already exists (oldest wins, consistently) rather than
  // whatever order Postgres happens to return.
  const rows = await restFetch(
    session,
    `contacts?email=ilike.${encodeURIComponent(escapeIlike(email))}&select=*&order=created_at.asc&limit=1`
  );
  return rows && rows[0] ? rows[0] : null;
}

async function findSyncedEmail(session, messageId) {
  const rows = await restFetch(session, `synced_emails?gmail_message_id=eq.${encodeURIComponent(messageId)}&select=id&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}

async function getLastSyncedAt(session, contactId) {
  const rows = await restFetch(
    session,
    `synced_emails?contact_id=eq.${encodeURIComponent(contactId)}&select=created_at&order=created_at.desc&limit=1`
  );
  return rows && rows[0] ? rows[0].created_at : null;
}

async function updateContact(session, contactId, { firstName, lastName, email }) {
  await restFetch(session, `contacts?id=eq.${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      first_name: firstName || email,
      last_name: lastName || null,
      email,
    }),
  });
}

async function createContact(session, { firstName, lastName, email }) {
  const rows = await restFetch(session, "contacts", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      first_name: firstName || email,
      last_name: lastName || null,
      email,
      created_by: session.display_name,
    }),
  });
  return rows[0];
}

async function logSyncedActivity(session, { contactId, messageId, subject, snippet }) {
  await restFetch(session, "activities", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      parent_type: "contact",
      parent_id: contactId,
      kind: "email",
      text: subject ? `${subject}\n\n${snippet || ""}`.trim() : (snippet || "(no subject)"),
      by: session.display_name,
    }),
  });
  // Best-effort de-dupe marker; if another tab/message races us and the
  // gmail_message_id unique constraint trips (HTTP 409), that's fine —
  // it just means it's already logged. Anything else (network failure,
  // RLS denial, a dropped connection) must NOT be swallowed here: the
  // caller already reported this sync as a success, so a swallowed
  // failure here would leave the thread looking "synced" with no
  // dedupe row behind it -- the next time anyone opens it, it would
  // look unsynced again and logSyncedActivity's unconditional insert
  // above would write a second (third, fourth...) activity row.
  try {
    await restFetch(session, "synced_emails", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ gmail_message_id: messageId, contact_id: contactId, synced_by: session.display_name }),
    });
  } catch (e) {
    if (e.status !== 409) throw e;
  }
}

/* ---------------- message handling ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "LOGIN") {
        sendResponse(await login(msg.username, msg.password));
        return;
      }
      if (msg.type === "LOGOUT") {
        await logout();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "GET_AUTH_STATE") {
        const session = await getValidSession();
        sendResponse(session ? { loggedIn: true, displayName: session.display_name, email: session.email } : { loggedIn: false });
        return;
      }

      // Everything past here needs a valid session.
      const session = await getValidSession();
      if (!session) { sendResponse({ ok: false, error: "not_logged_in" }); return; }

      if (msg.type === "CHECK_EMAIL") {
        const contact = await findContactByEmail(session, msg.senderEmail);
        // The compose-badge scan only needs "is this a contact?" -- skip
        // the sync-log lookups it never uses, so a reply with several
        // recipients doesn't fire two extra queries per chip for
        // nothing.
        let synced = false, lastSyncedAt = null;
        if (!msg.skipSyncCheck) {
          [synced, lastSyncedAt] = await Promise.all([
            findSyncedEmail(session, msg.messageId),
            contact ? getLastSyncedAt(session, contact.id) : Promise.resolve(null),
          ]);
        }
        sendResponse({ ok: true, contact, alreadySynced: !!synced, lastSyncedAt });
        return;
      }

      if (msg.type === "SYNC_EXISTING") {
        if (msg.email) await updateContact(session, msg.contactId, msg);
        await logSyncedActivity(session, msg);
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "CREATE_AND_SYNC") {
        // Re-check for an existing contact right before creating one.
        // This covers two real races: (a) the user retrying after a
        // network drop between createContact() and logSyncedActivity()
        // on an earlier attempt -- which left a contact already
        // created with no activity logged -- and (b) another team
        // member creating the same contact in the few seconds since
        // this popover opened. Either way, reusing what's there beats
        // creating a second row for the same person.
        const existing = await findContactByEmail(session, msg.email);
        if (existing) {
          await updateContact(session, existing.id, msg);
          await logSyncedActivity(session, { ...msg, contactId: existing.id });
          sendResponse({ ok: true, contact: { ...existing, first_name: msg.firstName || existing.first_name, last_name: msg.lastName, email: msg.email } });
          return;
        }
        const contact = await createContact(session, msg);
        await logSyncedActivity(session, { ...msg, contactId: contact.id });
        sendResponse({ ok: true, contact });
        return;
      }

      sendResponse({ ok: false, error: "unknown_message_type" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // keep the message channel open for the async response
});

// Fourlytic Gmail Sync — content script
// Runs on mail.google.com. Watches for an open email/thread, finds who
// it's with, and checks/syncs that contact against the Fourlytic CRM
// via the background service worker (which holds the Supabase session).
//
// Note: Gmail's DOM has no public API and its class names are
// unstable/obfuscated over time. The selectors below (`.gD[email]` for
// sender chips, `h2.hP` for subject, `.a3s` for message body) are the
// long-standing ones most Gmail extensions rely on, but Google can
// change them in a redesign — if syncing silently stops working, this
// is the first place to check.

let myEmail = null;
let lastProcessedKey = null;
let banner = null;

function ensureBanner() {
  if (banner && document.body.contains(banner)) return banner;
  banner = document.createElement("div");
  banner.id = "fourlytic-sync-banner";
  document.body.appendChild(banner);
  return banner;
}

function showBanner(html) {
  const el = ensureBanner();
  el.innerHTML = html;
  el.style.display = "flex";
}

function hideBanner() {
  if (banner) banner.style.display = "none";
}

function getParticipants() {
  const chips = Array.from(document.querySelectorAll("span.gD[email]"));
  const seen = new Map();
  for (const c of chips) {
    const email = c.getAttribute("email");
    const name = c.getAttribute("name") || email;
    if (email) seen.set(email.toLowerCase(), name);
  }
  return seen; // Map<emailLower, name>
}

function pickLeadEmail(participants) {
  const entries = Array.from(participants.entries());
  if (entries.length === 0) return null;
  // Prefer the most recently-seen participant that isn't the signed-in
  // team member themselves; fall back to the first one otherwise.
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!myEmail || entries[i][0] !== myEmail.toLowerCase()) return entries[i];
  }
  return entries[0];
}

function getSubject() {
  const h2 = document.querySelector("h2.hP");
  return h2 ? h2.textContent.trim() : "";
}

function getSnippet() {
  const bodies = document.querySelectorAll(".a3s");
  if (!bodies.length) return "";
  const text = bodies[bodies.length - 1].innerText || "";
  return text.trim().slice(0, 500);
}

function splitName(fullName, email) {
  if (!fullName || fullName === email) return { firstName: email, lastName: null };
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") || null };
}

async function processOpenThread() {
  const participants = getParticipants();
  if (participants.size === 0) { hideBanner(); return; }

  const key = location.hash;
  const lead = pickLeadEmail(participants);
  if (!lead) { hideBanner(); return; }
  const [leadEmail, leadName] = lead;

  if (key === lastProcessedKey) return; // already handled this thread view
  lastProcessedKey = key;

  const auth = await chrome.runtime.sendMessage({ type: "GET_AUTH_STATE" });
  if (!auth || !auth.loggedIn) {
    showBanner(`<span>Sign in to <b>Fourlytic Gmail Sync</b> (toolbar icon) to sync this conversation.</span>`);
    myEmail = null;
    return;
  }
  myEmail = auth.email || myEmail;

  const check = await chrome.runtime.sendMessage({ type: "CHECK_EMAIL", senderEmail: leadEmail, messageId: key });
  if (!check.ok) { showBanner(`<span>Fourlytic sync error: ${escapeHtml(check.error || "unknown")}</span>`); return; }

  if (check.contact) {
    if (!check.alreadySynced) {
      await chrome.runtime.sendMessage({
        type: "SYNC_EXISTING",
        contactId: check.contact.id,
        messageId: key,
        subject: getSubject(),
        snippet: getSnippet(),
      });
    }
    showBanner(`<span>&#10003; Synced to <b>${escapeHtml(contactDisplayName(check.contact))}</b> in Fourlytic CRM.</span>`);
    return;
  }

  // Not in the CRM yet — offer to add + sync.
  showBanner(`
    <span>Not in Fourlytic CRM —</span>
    <button id="fourlytic-add-btn">Add &amp; Sync ${escapeHtml(leadName || leadEmail)}</button>
  `);
  const btn = document.getElementById("fourlytic-add-btn");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "Syncing…";
      const { firstName, lastName } = splitName(leadName, leadEmail);
      const res = await chrome.runtime.sendMessage({
        type: "CREATE_AND_SYNC",
        email: leadEmail,
        firstName, lastName,
        messageId: key,
        subject: getSubject(),
        snippet: getSnippet(),
      });
      if (!res.ok) {
        showBanner(`<span>Could not sync: ${escapeHtml(res.error || "unknown error")}</span>`);
        return;
      }
      showBanner(`<span>&#10003; Added <b>${escapeHtml(contactDisplayName(res.contact))}</b> to Fourlytic CRM and synced.</span>`);
    });
  }
}

function contactDisplayName(contact) {
  return [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Gmail is a single-page app — watch for DOM changes (new thread opened)
// and hash changes (navigating between threads), debounced.
let debounceTimer = null;
function scheduleProcess() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(processOpenThread, 600);
}

window.addEventListener("hashchange", scheduleProcess);
new MutationObserver(scheduleProcess).observe(document.body, { childList: true, subtree: true });
scheduleProcess();

// Fourlytic Gmail Sync — content script
// Runs on mail.google.com. Watches for an open email/thread, finds who
// it's with, and checks/syncs that contact against the Fourlytic CRM
// via the background service worker (which holds the Supabase session).
//
// UI: a small icon docks itself in Gmail's own right-side rail (next to
// Calendar/Keep/Tasks/Contacts) instead of an always-visible banner.
// Clicking it opens a popover with the current thread's sync status.
// A small orange dot on the icon means "needs action" (not signed in,
// a matched contact awaiting confirmation, or an unmatched contact).
//
// Nothing is written to the CRM until the team member explicitly
// confirms in the popover:
//   - matched contact, not yet synced -> popover shows who it will log
//     to; "Confirm & Sync" actually logs it.
//   - no matching contact -> popover shows the name/email Gmail gave us
//     (read-only); "Add & Sync" switches those into editable inputs;
//     "Confirm & Sync" (same button, now relabeled) creates the contact
//     with whatever is in the inputs at that point and logs the email.
//
// Note: Gmail's DOM has no public API and its class names are
// unstable/obfuscated over time. The selectors below (`.gD[email]` for
// sender chips, `h2.hP` for subject, `.a3s` for message body, and the
// `aria-label`/`data-tooltip` lookups used to find the native side
// rail) are long-standing conventions most Gmail extensions rely on,
// but Google can change them in a redesign — if the icon stops docking
// correctly, or syncing silently stops working, this is the first
// place to check.

let myEmail = null;
let lastProcessedKey = null;
let lastState = null; // { type, ...fields } for the current thread; see processOpenThread()

/* ---------------- docked rail icon + popover ---------------- */

function ensureIcon() {
  let icon = document.getElementById("fourlytic-rail-icon");
  if (icon) return icon;
  icon = document.createElement("div");
  icon.id = "fourlytic-rail-icon";
  icon.title = "Fourlytic Gmail Sync";
  const img = document.createElement("img");
  img.src = chrome.runtime.getURL("icons/icon48.png");
  const dot = document.createElement("div");
  dot.className = "fourlytic-dot";
  icon.appendChild(img);
  icon.appendChild(dot);
  document.body.appendChild(icon);
  icon.addEventListener("click", () => togglePopover());
  return icon;
}

function ensurePopover() {
  let pop = document.getElementById("fourlytic-popover");
  if (pop) return pop;
  pop = document.createElement("div");
  pop.id = "fourlytic-popover";
  document.body.appendChild(pop);
  return pop;
}

// Finds one of Gmail's own native side-rail icons (Calendar, Keep,
// Tasks, Contacts) to anchor ours directly beneath, so it reads as
// part of that rail rather than a random floating button. Picks
// whichever found icon sits lowest on screen, so ours docks below
// ALL of them rather than the first one matched.
function findRailAnchor() {
  const labels = ["Calendar", "Keep", "Tasks", "Contacts"];
  let lowest = null;
  for (const label of labels) {
    const el = document.querySelector(
      `[aria-label="${label}" i], [data-tooltip="${label}" i]`
    );
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (!lowest || rect.bottom > lowest.rect.bottom) lowest = { el, rect };
  }
  return lowest ? lowest.el : null;
}

function positionIcon() {
  const icon = document.getElementById("fourlytic-rail-icon");
  if (!icon) return;
  const anchor = findRailAnchor();
  if (!anchor) { icon.style.display = "none"; return; }
  const rect = anchor.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) { icon.style.display = "none"; return; }
  const railRight = window.innerWidth - rect.right;
  icon.style.right = `${Math.max(railRight, 8)}px`;
  icon.style.top = `${rect.bottom + 12}px`;
  icon.style.display = "flex";
}

function togglePopover() {
  const pop = ensurePopover();
  if (pop.classList.contains("open")) {
    pop.classList.remove("open");
    return;
  }
  const icon = document.getElementById("fourlytic-rail-icon");
  const iconRect = icon.getBoundingClientRect();
  pop.style.right = `${window.innerWidth - iconRect.left + 10}px`;
  pop.style.top = `${iconRect.top}px`;
  renderPopover();
  pop.classList.add("open");
}

function closePopover() {
  const pop = document.getElementById("fourlytic-popover");
  if (pop) pop.classList.remove("open");
}

function setNeedsAction(needs) {
  const icon = document.getElementById("fourlytic-rail-icon");
  if (icon) icon.classList.toggle("has-action", !!needs);
}

function renderIfOpen() {
  if (document.getElementById("fourlytic-popover")?.classList.contains("open")) renderPopover();
}

function renderPopover() {
  const pop = ensurePopover();
  const s = lastState;

  if (!s) {
    pop.innerHTML = `<div class="fourlytic-title">Fourlytic Gmail Sync</div><span>Open an email to sync it.</span>`;
    return;
  }

  if (s.type === "signed_out") {
    pop.innerHTML = `<div class="fourlytic-title">Fourlytic Gmail Sync</div><span>Sign in via the extension's toolbar icon to sync this conversation.</span>`;
    return;
  }

  if (s.type === "error") {
    pop.innerHTML = `<div class="fourlytic-title">Fourlytic Gmail Sync</div><span>Sync error: ${escapeHtml(s.message)}</span>`;
    return;
  }

  if (s.type === "synced") {
    pop.innerHTML = `<div class="fourlytic-title">Fourlytic Gmail Sync</div><span>&#10003; Synced to <b>${escapeHtml(s.name)}</b> in Fourlytic CRM.</span>`;
    return;
  }

  // Matched contact, not yet logged -- show the contact it will log to
  // and confirm before writing anything.
  if (s.type === "matched_confirm") {
    pop.innerHTML = `
      <div class="fourlytic-title">Fourlytic Gmail Sync</div>
      <span>Sync this email to this contact in Fourlytic CRM?</span>
      <span><b>${escapeHtml(s.name)}</b><br>${escapeHtml(s.email)}</span>
      <button id="fourlytic-confirm-btn">Confirm &amp; Sync</button>
    `;
    document.getElementById("fourlytic-confirm-btn").addEventListener("click", async (e) => {
      const btn = e.target;
      btn.disabled = true; btn.textContent = "Syncing…";
      const res = await chrome.runtime.sendMessage({
        type: "SYNC_EXISTING",
        contactId: s.contactId,
        messageId: s.key,
        subject: s.subject,
        snippet: s.snippet,
      });
      if (!res.ok) {
        pop.innerHTML = `<div class="fourlytic-title">Fourlytic Gmail Sync</div><span>Could not sync: ${escapeHtml(res.error || "unknown error")}</span>`;
        return;
      }
      lastState = { type: "synced", name: s.name };
      setNeedsAction(false);
      renderPopover();
    });
    return;
  }

  // No matching contact -- two steps: preview the scraped details, then
  // (same button, relabeled) edit them before confirming.
  if (s.type === "unmatched_preview" || s.type === "unmatched_editing") {
    const editing = s.type === "unmatched_editing";
    if (!editing) {
      pop.innerHTML = `
        <div class="fourlytic-title">Fourlytic Gmail Sync</div>
        <span>Not in Fourlytic CRM yet:</span>
        <span><b>${escapeHtml(s.name)}</b><br>${escapeHtml(s.email)}</span>
        <button id="fourlytic-add-btn">Add &amp; Sync</button>
      `;
      document.getElementById("fourlytic-add-btn").addEventListener("click", () => {
        lastState = { ...s, type: "unmatched_editing" };
        renderPopover();
      });
      return;
    }

    pop.innerHTML = `
      <div class="fourlytic-title">Fourlytic Gmail Sync</div>
      <span>New contact details — edit if needed:</span>
      <input id="fourlytic-edit-name" type="text" value="${escapeAttr(s.name)}" placeholder="Full name">
      <input id="fourlytic-edit-email" type="text" value="${escapeAttr(s.email)}" placeholder="Email">
      <button id="fourlytic-confirm-add-btn">Confirm &amp; Sync</button>
    `;
    document.getElementById("fourlytic-confirm-add-btn").addEventListener("click", async (e) => {
      const btn = e.target;
      const name = document.getElementById("fourlytic-edit-name").value.trim();
      const email = document.getElementById("fourlytic-edit-email").value.trim();
      if (!email) { btn.textContent = "Email is required"; return; }
      btn.disabled = true; btn.textContent = "Syncing…";
      const { firstName, lastName } = splitName(name, email);
      const res = await chrome.runtime.sendMessage({
        type: "CREATE_AND_SYNC",
        email, firstName, lastName,
        messageId: s.key,
        subject: s.subject,
        snippet: s.snippet,
      });
      if (!res.ok) {
        pop.innerHTML = `<div class="fourlytic-title">Fourlytic Gmail Sync</div><span>Could not sync: ${escapeHtml(res.error || "unknown error")}</span>`;
        return;
      }
      lastState = { type: "synced", name: contactDisplayName(res.contact) };
      setNeedsAction(false);
      renderPopover();
    });
  }
}

/* ---------------- Gmail DOM reading ---------------- */

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

function contactDisplayName(contact) {
  return [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/\n/g, "&#10;");
}

/* ---------------- thread processing ---------------- */

async function processOpenThread() {
  const participants = getParticipants();
  if (participants.size === 0) { lastState = null; setNeedsAction(false); renderIfOpen(); return; }

  const key = location.hash;
  const lead = pickLeadEmail(participants);
  if (!lead) { lastState = null; setNeedsAction(false); renderIfOpen(); return; }
  const [leadEmail, leadName] = lead;

  if (key === lastProcessedKey) return; // already handled this thread view
  lastProcessedKey = key;

  const auth = await chrome.runtime.sendMessage({ type: "GET_AUTH_STATE" });
  if (!auth || !auth.loggedIn) {
    myEmail = null;
    lastState = { type: "signed_out" };
    setNeedsAction(true);
    renderIfOpen();
    return;
  }
  myEmail = auth.email || myEmail;

  const check = await chrome.runtime.sendMessage({ type: "CHECK_EMAIL", senderEmail: leadEmail, messageId: key });
  if (!check.ok) {
    lastState = { type: "error", message: check.error || "unknown" };
    setNeedsAction(true);
    renderIfOpen();
    return;
  }

  const subject = getSubject();
  const snippet = getSnippet();

  if (check.contact) {
    if (check.alreadySynced) {
      lastState = { type: "synced", name: contactDisplayName(check.contact) };
      setNeedsAction(false);
    } else {
      lastState = {
        type: "matched_confirm",
        contactId: check.contact.id,
        name: contactDisplayName(check.contact),
        email: check.contact.email,
        key, subject, snippet,
      };
      setNeedsAction(true);
    }
  } else {
    lastState = {
      type: "unmatched_preview",
      email: leadEmail,
      name: leadName || leadEmail,
      key, subject, snippet,
    };
    setNeedsAction(true);
  }

  renderIfOpen();
}

/* ---------------- bootstrap ---------------- */

ensureIcon();
ensurePopover();
positionIcon();

// Close the popover on an outside click.
document.addEventListener("click", (e) => {
  const pop = document.getElementById("fourlytic-popover");
  const icon = document.getElementById("fourlytic-rail-icon");
  if (!pop || !pop.classList.contains("open")) return;
  if (pop.contains(e.target) || (icon && icon.contains(e.target))) return;
  closePopover();
});

// Gmail is a single-page app — watch for DOM changes (new thread opened,
// rail re-rendered) and hash changes (navigating between threads),
// debounced.
let debounceTimer = null;
function scheduleProcess() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    positionIcon();
    processOpenThread();
  }, 600);
}

window.addEventListener("hashchange", scheduleProcess);
window.addEventListener("resize", positionIcon);
new MutationObserver(scheduleProcess).observe(document.body, { childList: true, subtree: true });
scheduleProcess();

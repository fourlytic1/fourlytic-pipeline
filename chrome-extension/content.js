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

// status: "none" (no dot -- nothing to do), "pending" (orange -- needs
// action: sign in, confirm, or edit a new contact), "synced" (green --
// this email is already logged).
function setIconStatus(status) {
  const icon = document.getElementById("fourlytic-rail-icon");
  if (!icon) return;
  icon.classList.toggle("has-action", status === "pending");
  icon.classList.toggle("has-synced", status === "synced");
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
    const lastSyncedLine = s.lastSyncedAt
      ? `<span class="fourlytic-last-synced">Last synced ${formatRelativeTime(s.lastSyncedAt)}</span>`
      : "";
    pop.innerHTML = `<div class="fourlytic-title">Fourlytic Gmail Sync</div><span>&#10003; Synced to <b>${escapeHtml(s.name)}</b> in Fourlytic CRM.</span>${lastSyncedLine}`;
    return;
  }

  // Matched contact, not yet logged -- show its fields, editable (like
  // HubSpot's extension), and confirm before writing anything.
  if (s.type === "matched_confirm") {
    const lastSyncedLine = s.lastSyncedAt
      ? `<span class="fourlytic-last-synced">Last synced ${formatRelativeTime(s.lastSyncedAt)}</span>`
      : `<span class="fourlytic-last-synced">Never synced before</span>`;
    pop.innerHTML = `
      <div class="fourlytic-title">Fourlytic Gmail Sync</div>
      <span>Sync this email to this contact — edit if needed:</span>
      <input id="fourlytic-matched-name" type="text" value="${escapeAttr(s.name)}" placeholder="Full name">
      <input id="fourlytic-matched-email" type="text" value="${escapeAttr(s.email)}" placeholder="Email">
      ${lastSyncedLine}
      ${renderSyncPreview(s)}
      <button id="fourlytic-confirm-btn">Confirm &amp; Sync</button>
    `;
    document.getElementById("fourlytic-confirm-btn").addEventListener("click", async (e) => {
      const btn = e.target;
      const name = document.getElementById("fourlytic-matched-name").value.trim();
      const email = document.getElementById("fourlytic-matched-email").value.trim();
      if (!email) { btn.textContent = "Email is required"; return; }
      btn.disabled = true; btn.textContent = "Syncing…";
      const { firstName, lastName } = splitName(name, email);
      const res = await chrome.runtime.sendMessage({
        type: "SYNC_EXISTING",
        contactId: s.contactId,
        firstName, lastName, email,
        messageId: s.key,
        subject: s.subject,
        snippet: s.snippet,
      });
      if (!res.ok) {
        pop.innerHTML = `<div class="fourlytic-title">Fourlytic Gmail Sync</div><span>Could not sync: ${escapeHtml(res.error || "unknown error")}</span>`;
        return;
      }
      lastState = { type: "synced", name: name || s.name, lastSyncedAt: new Date().toISOString() };
      setIconStatus("synced");
      renderPopover();
    });
    return;
  }

  // No matching contact -- show editable fields right away (prefilled
  // from Gmail), same single-step pattern as the matched-contact box.
  if (s.type === "unmatched_editing") {
    pop.innerHTML = `
      <div class="fourlytic-title">Fourlytic Gmail Sync</div>
      <span>New contact details — edit if needed:</span>
      <input id="fourlytic-edit-name" type="text" value="${escapeAttr(s.name)}" placeholder="Full name">
      <input id="fourlytic-edit-email" type="text" value="${escapeAttr(s.email)}" placeholder="Email">
      ${renderSyncPreview(s)}
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
      lastState = { type: "synced", name: contactDisplayName(res.contact), lastSyncedAt: new Date().toISOString() };
      setIconStatus("synced");
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

// Shows what will actually get logged as the activity -- this email's
// subject + a short snippet of its body -- so the team member can see
// exactly what's about to be written before they confirm.
function renderSyncPreview(s) {
  const subject = (s.subject || "").trim();
  const snippet = (s.snippet || "").trim();
  if (!subject && !snippet) return "";
  const subjectLine = subject
    ? `<div class="fourlytic-preview-subject">${escapeHtml(subject)}</div>`
    : "";
  const snippetLine = snippet
    ? `<div class="fourlytic-preview-snippet">${escapeHtml(snippet.slice(0, 140))}${snippet.length > 140 ? "…" : ""}</div>`
    : "";
  return `
    <div class="fourlytic-sync-preview">
      <div class="fourlytic-preview-label">Will be logged as an activity:</div>
      ${subjectLine}
      ${snippetLine}
    </div>
  `;
}

function formatRelativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

/* ---------------- thread processing ---------------- */

async function processOpenThread() {
  const participants = getParticipants();
  if (participants.size === 0) { lastState = null; setIconStatus("none"); renderIfOpen(); return; }

  const key = location.hash;
  const lead = pickLeadEmail(participants);
  if (!lead) { lastState = null; setIconStatus("none"); renderIfOpen(); return; }
  const [leadEmail, leadName] = lead;

  if (key === lastProcessedKey) return; // already handled this thread view
  lastProcessedKey = key;

  const auth = await chrome.runtime.sendMessage({ type: "GET_AUTH_STATE" });
  if (!auth || !auth.loggedIn) {
    myEmail = null;
    lastState = { type: "signed_out" };
    setIconStatus("pending");
    renderIfOpen();
    return;
  }
  myEmail = auth.email || myEmail;

  const check = await chrome.runtime.sendMessage({ type: "CHECK_EMAIL", senderEmail: leadEmail, messageId: key });
  if (!check.ok) {
    lastState = { type: "error", message: check.error || "unknown" };
    setIconStatus("pending");
    renderIfOpen();
    return;
  }

  const subject = getSubject();
  const snippet = getSnippet();

  if (check.contact) {
    if (check.alreadySynced) {
      lastState = { type: "synced", name: contactDisplayName(check.contact), lastSyncedAt: check.lastSyncedAt };
      setIconStatus("synced");
    } else {
      lastState = {
        type: "matched_confirm",
        contactId: check.contact.id,
        name: contactDisplayName(check.contact),
        lastSyncedAt: check.lastSyncedAt,
        email: check.contact.email,
        key, subject, snippet,
      };
      setIconStatus("pending");
    }
  } else {
    lastState = {
      type: "unmatched_editing",
      email: leadEmail,
      name: leadName || leadEmail,
      key, subject, snippet,
    };
    setIconStatus("pending");
  }

  renderIfOpen();
}

/* ---------------- compose-window recipient badges ----------------
   Shows a small dot next to each recipient chip while composing/
   replying: green = already a Fourlytic contact, orange = not yet.
   Purely informational -- no sync action happens from here.

   Harder to target reliably than the read-thread selectors above:
   a compose box (popup OR inline reply) is identified by its editable
   message body (`[g_editable="true"]`, aria-label "Message Body"),
   then we climb to the nearest ancestor that also contains a Send
   button and treat that as the whole compose box, scanning it for
   `[email]` recipient chips. This is a newer, less proven assumption
   than the thread-reading selectors -- if badges don't show up (or
   show up in the wrong place) after a real test, this is the first
   place to check. */

const composeContactCache = new Map(); // emailLower -> true/false/null (null = lookup failed)

function findComposeContainers() {
  const bodies = document.querySelectorAll(
    '[g_editable="true"][aria-label], [contenteditable="true"][aria-label="Message Body" i]'
  );
  const containers = new Set();
  bodies.forEach((body) => {
    let el = body;
    for (let i = 0; i < 8 && el; i++) {
      if (el.querySelector && el.querySelector('[aria-label^="Send" i], [data-tooltip^="Send" i]')) {
        containers.add(el);
        return;
      }
      el = el.parentElement;
    }
  });
  return Array.from(containers);
}

async function addComposeBadge(chip, email) {
  const badge = document.createElement("span");
  badge.className = "fourlytic-compose-badge fourlytic-badge-pending";
  badge.title = "Checking Fourlytic CRM…";
  chip.insertAdjacentElement("afterend", badge);

  let known = composeContactCache.get(email);
  if (known === undefined) {
    const res = await chrome.runtime.sendMessage({ type: "CHECK_EMAIL", senderEmail: email, messageId: "__compose_check__" });
    known = res && res.ok ? !!res.contact : null;
    composeContactCache.set(email, known);
  }

  if (known === true) {
    badge.className = "fourlytic-compose-badge fourlytic-badge-known";
    badge.title = "Already in Fourlytic CRM";
  } else if (known === false) {
    badge.className = "fourlytic-compose-badge fourlytic-badge-new";
    badge.title = "Not in Fourlytic CRM yet";
  } else {
    badge.remove(); // lookup failed -- don't show a possibly-wrong signal
  }
}

async function scanComposeRecipients() {
  const auth = await chrome.runtime.sendMessage({ type: "GET_AUTH_STATE" });
  if (!auth || !auth.loggedIn) return;

  for (const box of findComposeContainers()) {
    const chips = box.querySelectorAll("[email]");
    for (const chip of chips) {
      if (chip.dataset.fourlyticBadged) continue;
      const email = (chip.getAttribute("email") || "").toLowerCase();
      if (!email) continue;
      chip.dataset.fourlyticBadged = "1";
      addComposeBadge(chip, email);
    }
  }
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
    scanComposeRecipients();
  }, 600);
}

window.addEventListener("hashchange", scheduleProcess);
window.addEventListener("resize", positionIcon);
new MutationObserver(scheduleProcess).observe(document.body, { childList: true, subtree: true });
scheduleProcess();

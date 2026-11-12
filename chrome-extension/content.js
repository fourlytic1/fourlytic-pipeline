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
// Blocks a second Confirm&Sync click while one is still in flight. This
// is deliberately module-level, not per-button: renderPopover() always
// rebuilds a fresh, enabled button from lastState, so closing and
// reopening the popover mid-request (e.g. an outside click) would
// otherwise present a brand-new enabled button and let a second click
// fire a second concurrent sync.
let syncInFlight = false;

/* ---------------- docked rail icon + popover ---------------- */

// Once the team member drags the icon, its position is theirs to keep --
// stored as {top, right} (px from those edges, matching how the icon is
// already positioned) in chrome.storage.local so it persists across
// Gmail reloads. Until they drag it, it auto-docks under Gmail's native
// side rail as before. `customIconPos` is loaded async on startup; drag
// handling lives on the icon itself, wired up once in ensureIcon().
let customIconPos = null; // null = not dragged yet -> auto-dock
let customIconPosLoaded = false;
// True for the whole pointerdown..pointerup span. Gmail's own DOM churns
// constantly, which re-triggers our MutationObserver -> positionIcon()
// mid-drag; without this guard that call would see customIconPos still
// null (it's only committed on pointerup) and snap the icon straight
// back to its auto-docked spot, fighting the drag in real time.
let isDraggingIcon = false;

// A stored position could be corrupted (crash mid-write, hand-edited
// storage) or just missing a field. Without this check, a bad value
// like {right: undefined, top: 140} flows straight into clampIconPos's
// Math.max/Math.min and produces NaN, which becomes "right: NaNpx" --
// invalid CSS the browser silently ignores, leaving the icon wherever
// it last rendered (possibly off-screen) with no way to recover, since
// customIconPos being non-null skips the auto-dock fallback entirely.
function isValidIconPos(pos) {
  return !!pos && Number.isFinite(pos.top) && Number.isFinite(pos.right);
}

chrome.storage.local.get("fourlyticIconPos", ({ fourlyticIconPos }) => {
  if (fourlyticIconPos && !isValidIconPos(fourlyticIconPos)) {
    chrome.storage.local.remove("fourlyticIconPos"); // don't keep re-reading a corrupt value
  }
  customIconPos = isValidIconPos(fourlyticIconPos) ? fourlyticIconPos : null;
  customIconPosLoaded = true;
  positionIcon();
});

// Two Gmail tabs share the same chrome.storage.local -- without this,
// dragging the icon in tab A leaves tab B showing the old position
// until it's reloaded. This keeps them live-consistent.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.fourlyticIconPos) return;
  if (isDraggingIcon) return; // don't let a remote update fight our own in-progress drag
  const next = changes.fourlyticIconPos.newValue;
  customIconPos = isValidIconPos(next) ? next : null;
  positionIcon();
});

const ICON_SIZE = 40;
const ICON_MARGIN = 4; // keep it fully on-screen, not flush against the edge

function clampIconPos(pos) {
  const maxRight = Math.max(ICON_MARGIN, window.innerWidth - ICON_SIZE - ICON_MARGIN);
  const maxTop = Math.max(ICON_MARGIN, window.innerHeight - ICON_SIZE - ICON_MARGIN);
  return {
    right: Math.min(Math.max(pos.right, ICON_MARGIN), maxRight),
    top: Math.min(Math.max(pos.top, ICON_MARGIN), maxTop),
  };
}

function wireDrag(icon) {
  // Scoped to a single pointerId, not a bare boolean: a second touch
  // landing on the icon mid-drag (plausible on a tablet/touch laptop)
  // would otherwise reset startX/startY/startRight/startTop from the
  // new touch's coordinates while the first touch is still captured
  // and moving, corrupting the in-progress drag.
  let activePointerId = null;
  let moved = false;
  let startX = 0, startY = 0;
  let startRight = 0, startTop = 0;

  function endDrag() {
    activePointerId = null;
    isDraggingIcon = false;
    icon.classList.remove("dragging");
  }

  icon.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return; // left button / touch only
    if (activePointerId !== null) return; // already tracking a different pointer
    activePointerId = e.pointerId;
    isDraggingIcon = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = icon.getBoundingClientRect();
    startRight = window.innerWidth - rect.right;
    startTop = rect.top;
    try {
      icon.setPointerCapture(e.pointerId);
    } catch (err) {
      // Capture can throw (pointerId already released, element not
      // connected yet) -- the drag still works fine without it since
      // our own listeners are on the icon itself, not the document.
    }
    e.preventDefault();
  });

  icon.addEventListener("pointermove", (e) => {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 4) return; // ignore tiny jitter -- still a click
    moved = true;
    icon.classList.add("dragging");
    const next = clampIconPos({ right: startRight - dx, top: startTop + dy });
    icon.style.right = `${next.right}px`;
    icon.style.top = `${next.top}px`;
    if (document.getElementById("fourlytic-popover")?.classList.contains("open")) {
      togglePopover(); // close it rather than let it float away from the icon mid-drag
    }
  });

  icon.addEventListener("pointerup", (e) => {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    const wasMoved = moved;
    try { icon.releasePointerCapture(e.pointerId); } catch (err) { /* already released -- fine */ }
    endDrag();
    if (wasMoved) {
      const rect = icon.getBoundingClientRect();
      customIconPos = clampIconPos({ right: window.innerWidth - rect.right, top: rect.top });
      chrome.storage.local.set({ fourlyticIconPos: customIconPos });
    } else {
      togglePopover(); // a plain click, no drag
    }
  });

  // If the browser interrupts the gesture (e.g. focus loss, Gmail
  // handling the pointer elsewhere) we still must clear isDraggingIcon,
  // or positionIcon() would stay frozen forever.
  icon.addEventListener("pointercancel", (e) => {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    endDrag();
  });

  // Safety net for interruptions that fire neither pointerup nor
  // pointercancel at all -- Alt-Tab mid-drag, the OS stealing focus, a
  // native context menu -- any of which would otherwise leave
  // isDraggingIcon stuck true forever and freeze positionIcon().
  window.addEventListener("blur", () => { if (activePointerId !== null) endDrag(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && activePointerId !== null) endDrag();
  });
}

function ensureIcon() {
  let icon = document.getElementById("fourlytic-rail-icon");
  if (icon) return icon;
  icon = document.createElement("div");
  icon.id = "fourlytic-rail-icon";
  icon.title = "Fourlytic Gmail Sync — drag to move";
  const img = document.createElement("img");
  img.src = chrome.runtime.getURL("icons/icon48.png");
  const dot = document.createElement("div");
  dot.className = "fourlytic-dot";
  icon.appendChild(img);
  icon.appendChild(dot);
  document.body.appendChild(icon);
  wireDrag(icon);
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
  if (isDraggingIcon) return; // don't fight an in-progress drag (see note above)
  const icon = document.getElementById("fourlytic-rail-icon");
  if (!icon) return;

  // Once the team member has dragged the icon, that position wins --
  // re-clamped on resize so it can't end up off-screen -- instead of
  // re-anchoring under Gmail's native rail every time.
  if (customIconPos) {
    const pos = clampIconPos(customIconPos);
    icon.style.right = `${pos.right}px`;
    icon.style.top = `${pos.top}px`;
    icon.style.display = "flex";
    return;
  }
  if (!customIconPosLoaded) return; // wait for storage read to resolve first

  const anchor = findRailAnchor();
  if (!anchor) { icon.style.display = "none"; return; }
  const rect = anchor.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) { icon.style.display = "none"; return; }
  const railRight = window.innerWidth - rect.right;
  icon.style.right = `${Math.max(railRight, 8)}px`;
  icon.style.top = `${rect.bottom + 12}px`;
  icon.style.display = "flex";
}

async function togglePopover() {
  const pop = ensurePopover();
  if (pop.classList.contains("open")) {
    pop.classList.remove("open");
    return;
  }
  // The thread's hash doesn't change just because the user signed in
  // (or a transient error cleared) since we last checked, so
  // processOpenThread() never naturally re-fires for that. Force one
  // fresh check right before showing stale "signed out"/error state,
  // so signing in via the toolbar popup and reopening the popover
  // doesn't still say "sign in" forever.
  if (!lastState || lastState.type === "signed_out" || lastState.type === "error") {
    lastProcessedKey = null;
    await processOpenThread();
  }
  const icon = document.getElementById("fourlytic-rail-icon");
  if (!icon) return;
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
      if (syncInFlight) return; // a request from a previous click (e.g. close/reopen mid-sync) is still pending
      const btn = e.target;
      const name = document.getElementById("fourlytic-matched-name").value.trim();
      const email = document.getElementById("fourlytic-matched-email").value.trim();
      if (!email) { btn.textContent = "Email is required"; return; }
      syncInFlight = true;
      btn.disabled = true; btn.textContent = "Syncing…";
      const { firstName, lastName } = splitName(name, email);
      let res;
      try {
        res = await chrome.runtime.sendMessage({
          type: "SYNC_EXISTING",
          contactId: s.contactId,
          firstName, lastName, email,
          messageId: s.key,
          subject: s.subject,
          snippet: s.snippet,
        });
      } catch (err) {
        res = { ok: false, error: String(err && err.message || err) };
      }
      syncInFlight = false;
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
      if (syncInFlight) return; // a request from a previous click (e.g. close/reopen mid-sync) is still pending
      const btn = e.target;
      const name = document.getElementById("fourlytic-edit-name").value.trim();
      const email = document.getElementById("fourlytic-edit-email").value.trim();
      if (!email) { btn.textContent = "Email is required"; return; }
      syncInFlight = true;
      btn.disabled = true; btn.textContent = "Syncing…";
      const { firstName, lastName } = splitName(name, email);
      let res;
      try {
        res = await chrome.runtime.sendMessage({
          type: "CREATE_AND_SYNC",
          email, firstName, lastName,
          messageId: s.key,
          subject: s.subject,
          snippet: s.snippet,
        });
      } catch (err) {
        res = { ok: false, error: String(err && err.message || err) };
      }
      syncInFlight = false;
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

// Best-effort scope to "the thread that's actually open," not the
// whole document. Gmail's multi-inbox/preview-pane layouts (or simply
// a prior thread's DOM not yet torn down during fast navigation) can
// leave more than one thread's markup present at once; querying the
// whole document for participants/subject/snippet separately can then
// mix pieces of two different threads into one state. This climbs from
// the LAST message body on the page (the convention already used for
// the snippet) up to the nearest ancestor that also contains a subject
// header, and uses that one element as the scope for all three reads so
// they're at least internally consistent with each other. Like the
// compose-container climbing below, this is a heuristic over
// unofficial DOM, not a guarantee -- if thread data still looks mixed
// up after a real test, this is the first place to check.
function getThreadScope() {
  const bodies = document.querySelectorAll(".a3s");
  if (!bodies.length) return document;
  let el = bodies[bodies.length - 1];
  for (let i = 0; i < 12 && el && el !== document.body; i++) {
    if (el.querySelector && el.querySelector("h2.hP")) return el;
    el = el.parentElement;
  }
  return document;
}

function getParticipants(scope) {
  const chips = Array.from(scope.querySelectorAll("span.gD[email]"));
  const seen = new Map();
  for (const c of chips) {
    const email = c.getAttribute("email");
    const name = c.getAttribute("name") || email;
    if (email) seen.set(email.toLowerCase(), name);
  }
  return seen; // Map<emailLower, name>
}

// Automated senders (no-reply@, notifications@, mailer-daemon@, ...)
// make poor CRM contacts -- if a real person is also on the thread,
// prefer them.
const AUTOMATED_SENDER_RE = /^(no-?reply|do-?not-?reply|notifications?|bounce|mailer-daemon)@/i;

function pickLeadEmail(participants) {
  const entries = Array.from(participants.entries());
  if (entries.length === 0) return null;
  // Prefer a participant that isn't the signed-in team member.
  const notMe = entries.filter(([email]) => !myEmail || email !== myEmail.toLowerCase());
  const candidates = notMe.length ? notMe : entries;
  // Among those, prefer the most recently-seen one that doesn't look
  // automated; fall back to the most recent regardless if every
  // candidate looks automated (still better than syncing nothing).
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (!AUTOMATED_SENDER_RE.test(candidates[i][0])) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

function getSubject(scope) {
  const h2s = scope.querySelectorAll("h2.hP");
  if (!h2s.length) return "";
  return h2s[h2s.length - 1].textContent.trim(); // last, matching the "most recent" convention used below
}

function getSnippet(scope) {
  const bodies = scope.querySelectorAll(".a3s");
  if (!bodies.length) return "";
  const text = bodies[bodies.length - 1].innerText || "";
  return text.trim().slice(0, 500);
}

// A cheap, non-cryptographic fingerprint of "how many messages are in
// this thread, and what does the latest one say" -- used to detect a
// new reply arriving in an already-open, already-synced thread (see
// getMessageFingerprint's caller for why this matters).
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

function getMessageFingerprint(scope) {
  const bodies = scope.querySelectorAll(".a3s");
  const count = bodies.length;
  const lastText = count ? (bodies[count - 1].innerText || "").slice(0, 200) : "";
  return `${count}:${simpleHash(lastText)}`;
}

function splitName(fullName, email) {
  if (!fullName || fullName === email) return { firstName: email, lastName: null };
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") || null };
}

function contactDisplayName(contact) {
  const name = [contact.first_name, contact.last_name]
    .filter((part) => part && part.trim())
    .join(" ")
    .trim();
  return name || contact.email;
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
  const scope = getThreadScope();
  const participants = getParticipants(scope);
  if (participants.size === 0) { lastState = null; setIconStatus("none"); renderIfOpen(); return; }

  const threadHash = location.hash; // Gmail's own permalink hash -- identifies the THREAD, not any one message in it
  const lead = pickLeadEmail(participants);
  if (!lead) { lastState = null; setIconStatus("none"); renderIfOpen(); return; }
  const [leadEmail, leadName] = lead;

  // messageKey combines the thread hash with a fingerprint of the
  // latest message. location.hash alone does NOT change when a new
  // reply lands in an already-open thread, so gating purely on it
  // meant: sync a thread once, and every later reply in that same
  // thread is silently never offered for sync again, forever, because
  // this function returns before even re-querying the CRM. Folding the
  // fingerprint in means a new reply changes the key, which both lets
  // this function run again AND gives that specific message its own
  // dedupe identity when logged.
  const fingerprint = getMessageFingerprint(scope);
  const messageKey = `${threadHash}::${fingerprint}`;
  if (messageKey === lastProcessedKey) return; // already handled this exact thread+message state
  lastProcessedKey = messageKey;

  let auth;
  try {
    auth = await chrome.runtime.sendMessage({ type: "GET_AUTH_STATE" });
  } catch (e) {
    return; // service worker hiccup -- next trigger (hash change, DOM mutation) will retry
  }
  // The user may have navigated to a different thread while we were
  // waiting on that round-trip. Without this check, a slower response
  // for thread A can land AFTER a faster response for thread B and
  // overwrite the state currently on screen -- including which
  // contactId a "Confirm & Sync" click would act on.
  if (location.hash !== threadHash) return;
  if (!auth || !auth.loggedIn) {
    myEmail = null;
    lastState = { type: "signed_out" };
    setIconStatus("pending");
    renderIfOpen();
    return;
  }
  myEmail = auth.email || myEmail;

  let check;
  try {
    check = await chrome.runtime.sendMessage({ type: "CHECK_EMAIL", senderEmail: leadEmail, messageId: messageKey });
  } catch (e) {
    lastState = { type: "error", message: String(e && e.message || e) };
    setIconStatus("pending");
    renderIfOpen();
    return;
  }
  if (location.hash !== threadHash) return; // see note above
  if (!check || !check.ok) {
    lastState = { type: "error", message: (check && check.error) || "unknown" };
    setIconStatus("pending");
    renderIfOpen();
    return;
  }

  const subject = getSubject(scope);
  const snippet = getSnippet(scope);

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
        key: messageKey, subject, snippet,
      };
      setIconStatus("pending");
    }
  } else {
    lastState = {
      type: "unmatched_editing",
      email: leadEmail,
      name: leadName || leadEmail,
      key: messageKey, subject, snippet,
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
    for (let i = 0; i < 14 && el; i++) {
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
    let res = null;
    try {
      // skipSyncCheck: this is only asking "is this a contact?" -- the
      // background worker skips the sync-log lookups it would
      // otherwise do per call, which matters once there are several
      // recipient chips firing this in a loop.
      res = await chrome.runtime.sendMessage({ type: "CHECK_EMAIL", senderEmail: email, messageId: "__compose_check__", skipSyncCheck: true });
    } catch (e) {
      // background worker hiccup -- fall through with res still null,
      // handled the same as any other failed lookup below.
    }
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
  let auth = null;
  try {
    auth = await chrome.runtime.sendMessage({ type: "GET_AUTH_STATE" });
  } catch (e) {
    return; // background worker hiccup -- next scheduled scan will retry
  }
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

const loginView = document.getElementById("loginView");
const signedInView = document.getElementById("signedInView");
const errBox = document.getElementById("err");

async function refreshView() {
  const state = await chrome.runtime.sendMessage({ type: "GET_AUTH_STATE" });
  if (state && state.loggedIn) {
    loginView.classList.add("hidden");
    signedInView.classList.remove("hidden");
    document.getElementById("displayName").textContent = state.displayName;
  } else {
    signedInView.classList.add("hidden");
    loginView.classList.remove("hidden");
  }
}

document.getElementById("loginBtn").addEventListener("click", async () => {
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  errBox.classList.remove("show");
  if (!username || !password) {
    errBox.textContent = "Enter your username and password.";
    errBox.classList.add("show");
    return;
  }
  const btn = document.getElementById("loginBtn");
  btn.disabled = true; btn.textContent = "Signing in…";
  const res = await chrome.runtime.sendMessage({ type: "LOGIN", username, password });
  btn.disabled = false; btn.textContent = "Sign in";
  if (!res.ok) {
    errBox.textContent = res.error || "Could not sign in.";
    errBox.classList.add("show");
    return;
  }
  await refreshView();
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "LOGOUT" });
  await refreshView();
});

refreshView();

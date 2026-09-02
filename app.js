const state = { user: null, posts: [], status: null };

const el = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || "Request failed");
  return data;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

/* ------------------------------- banners -------------------------------- */

function renderBanners() {
  const s = state.status;
  const parts = [];
  if (s?.maintenanceMode) {
    parts.push(`<div class="banner maintenance">🛠️ ${escapeHtml(s.maintenanceMessage)}</div>`);
  }
  if (s?.updateMode) {
    parts.push(`<div class="banner update">⬆️ ${escapeHtml(s.updateMessage)}</div>`);
  }
  if (s?.announcementActive && s.announcementText) {
    parts.push(`<div class="banner announce">📢 ${escapeHtml(s.announcementText)}</div>`);
  }
  el("#banners").innerHTML = parts.join("");
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}

/* --------------------------------- auth --------------------------------- */

function renderAuthArea() {
  const area = el("#auth-area");
  if (state.user) {
    area.innerHTML = `<span>Hi, <strong>${escapeHtml(state.user.username)}</strong>${state.user.isAdmin ? " (admin)" : ""}</span> <button class="ghost" id="logout-btn">Log out</button>`;
    el("#logout-btn").onclick = async () => {
      await api("/api/logout", { method: "POST" });
      state.user = null;
      refreshAll();
    };
  } else {
    area.innerHTML = "";
  }

  el("#login-panel").hidden = !!state.user;
  el("#composer").hidden = !state.user;
  el("#admin-panel").hidden = !state.user?.isAdmin;

  if (state.user?.restricted) {
    const note = document.createElement("p");
    note.className = "restricted-note";
    note.textContent =
      "Restricted mode is on for your account (accounts under 13 can browse but can't post or comment until they turn 13).";
    el("#composer").hidden = true;
    el("#feed").prepend(note);
  }
}

el("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  el("#login-error").textContent = "";
  try {
    const { user } = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({
        username: form.get("username"),
        email: form.get("email"),
        age: form.get("age"),
      }),
    });
    state.user = user;
    refreshAll();
  } catch (err) {
    el("#login-error").textContent = err.message;
  }
});

/* -------------------------------- posts ---------------------------------- */

async function loadPosts() {
  const { posts } = await api("/api/posts");
  state.posts = posts;
  renderFeed();
}

el("#post-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  el("#post-error").textContent = "";
  try {
    await api("/api/posts", {
      method: "POST",
      body: JSON.stringify({
        content: form.get("content"),
        location: form.get("location"),
        temperature: form.get("temperature"),
        condition: form.get("condition"),
      }),
    });
    e.target.reset();
    await loadPosts();
  } catch (err) {
    el("#post-error").textContent = err.message;
  }
});

function renderFeed() {
  const feed = el("#feed");
  feed.innerHTML = "";
  for (const post of state.posts) {
    feed.appendChild(renderPost(post));
  }
}

function renderPost(post) {
  const wrap = document.createElement("div");
  wrap.className = "post";

  const tags = [];
  if (post.location) tags.push(`📍 ${escapeHtml(post.location)}`);
  if (post.temperature) tags.push(`🌡️ ${escapeHtml(post.temperature)}`);
  if (post.condition) tags.push(`☁️ ${escapeHtml(post.condition)}`);

  wrap.innerHTML = `
    <div class="post-header">
      <span class="post-username">${escapeHtml(post.username)}</span>
      <span class="post-meta">${fmtDate(post.createdAt)}${post.edited ? " (edited)" : ""}</span>
    </div>
    ${tags.length ? `<div class="post-tags">${tags.map((t) => `<span class="tag">${t}</span>`).join("")}</div>` : ""}
    <div class="post-content">${escapeHtml(post.content)}</div>
    <div class="post-actions">
      <button class="ghost like-btn ${post.likedByMe ? "liked" : ""}">${post.likedByMe ? "♥" : "♡"} ${post.likeCount}</button>
      <button class="ghost comment-toggle">💬 ${post.commentCount}</button>
      ${post.canEdit ? `<button class="ghost edit-btn">Edit</button>` : ""}
    </div>
    <div class="comments" hidden></div>
  `;

  wrap.querySelector(".like-btn").onclick = async () => {
    await api(`/api/posts/${post.id}/like`, { method: "POST" });
    await loadPosts();
  };

  wrap.querySelector(".comment-toggle").onclick = () => toggleComments(wrap, post);

  if (post.canEdit) {
    wrap.querySelector(".edit-btn").onclick = () => renderEditForm(wrap, post);
  }

  return wrap;
}

function renderEditForm(wrap, post) {
  const contentDiv = wrap.querySelector(".post-content");
  const original = post.content;
  contentDiv.innerHTML = `
    <textarea class="edit-textarea">${escapeHtml(original)}</textarea>
    <button class="save-edit">Save</button>
    <button class="ghost cancel-edit">Cancel</button>
    <p class="error edit-error"></p>
  `;
  wrap.querySelector(".cancel-edit").onclick = () => loadPosts();
  wrap.querySelector(".save-edit").onclick = async () => {
    const newContent = wrap.querySelector(".edit-textarea").value.trim();
    try {
      await api(`/api/posts/${post.id}`, {
        method: "PUT",
        body: JSON.stringify({ content: newContent }),
      });
      await loadPosts();
    } catch (err) {
      wrap.querySelector(".edit-error").textContent = err.message;
    }
  };
}

async function toggleComments(wrap, post) {
  const box = wrap.querySelector(".comments");
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  const { comments } = await api(`/api/posts/${post.id}/comments`);
  box.innerHTML =
    comments
      .map(
        (cm) =>
          `<div class="comment"><span class="comment-username">${escapeHtml(cm.username)}</span>${escapeHtml(cm.content)}</div>`
      )
      .join("") +
    (state.user && !state.user.restricted
      ? `<form class="comment-form">
           <input placeholder="Write a comment..." required maxlength="1000" />
           <button type="submit">Send</button>
         </form>
         <p class="error comment-error"></p>`
      : "");
  box.hidden = false;

  const form = box.querySelector(".comment-form");
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const input = form.querySelector("input");
      try {
        await api(`/api/posts/${post.id}/comments`, {
          method: "POST",
          body: JSON.stringify({ content: input.value.trim() }),
        });
        input.value = "";
        await loadPosts();
        // Re-open comments after the feed re-renders
        const newWrap = [...document.querySelectorAll(".post")].find((p) =>
          p.querySelector(".post-content")?.textContent.includes(post.content.slice(0, 20))
        );
        if (newWrap) toggleComments(newWrap, post);
      } catch (err) {
        box.querySelector(".comment-error").textContent = err.message;
      }
    };
  }
}

/* --------------------------------- admin --------------------------------- */

function wireAdminPanel() {
  el("#maint-save").onclick = async () => {
    await api("/api/admin/maintenance", {
      method: "POST",
      body: JSON.stringify({
        enabled: el("#maint-enabled").checked,
        message: el("#maint-message").value,
      }),
    });
    await refreshStatus();
  };
  el("#update-save").onclick = async () => {
    await api("/api/admin/update-mode", {
      method: "POST",
      body: JSON.stringify({
        enabled: el("#update-enabled").checked,
        message: el("#update-message").value,
      }),
    });
    await refreshStatus();
  };
  el("#announce-save").onclick = async () => {
    await api("/api/admin/announcement", {
      method: "POST",
      body: JSON.stringify({
        active: el("#announce-enabled").checked,
        text: el("#announce-text").value,
      }),
    });
    await refreshStatus();
  };
}

function fillAdminPanelFromStatus() {
  if (!state.user?.isAdmin || !state.status) return;
  el("#maint-enabled").checked = state.status.maintenanceMode;
  el("#maint-message").value = state.status.maintenanceMessage;
  el("#update-enabled").checked = state.status.updateMode;
  el("#update-message").value = state.status.updateMessage;
  el("#announce-enabled").checked = state.status.announcementActive;
  el("#announce-text").value = state.status.announcementText;
}

/* -------------------------------- boot ----------------------------------- */

async function refreshStatus() {
  state.status = await api("/api/site-status");
  renderBanners();
  fillAdminPanelFromStatus();
}

async function refreshAll() {
  const { user } = await api("/api/me");
  state.user = user;
  renderAuthArea();
  await refreshStatus();
  await loadPosts();
  renderAuthArea(); // re-run after posts load, in case restricted-note needs re-adding
}

wireAdminPanel();
refreshAll();

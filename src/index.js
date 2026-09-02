import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";

const app = new Hono();

const SESSION_COOKIE = "session_token";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/* ---------------------------- small helpers ---------------------------- */

function uid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

// Because we only collect an *age*, not a birthdate, we can't know the
// user's exact 13th birthday. We approximate: restriction lifts
// (13 - age) years from the day they registered. This is a best-effort
// stand-in, not a precise age check — see README for the compliance note.
function restrictedUntilFromAge(age) {
  const years = Math.max(0, 13 - age);
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString();
}

async function createSession(env, userId) {
  const token = uid();
  await env.SESSIONS.put(`session:${token}`, userId, {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

async function getUserFromRequest(c) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const userId = await c.env.SESSIONS.get(`session:${token}`);
  if (!userId) return null;
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first();
  return user || null;
}

// Lifts a restricted user out of restricted mode if their approximate
// 13th-birthday date has passed. Called lazily whenever we load a user.
async function maybeLiftRestriction(env, user) {
  if (!user || !user.restricted) return user;
  if (user.restricted_until && new Date(user.restricted_until) <= new Date()) {
    await env.DB.prepare(
      "UPDATE users SET restricted = 0, restricted_until = NULL WHERE id = ?"
    )
      .bind(user.id)
      .run();
    user.restricted = 0;
    user.restricted_until = null;
  }
  return user;
}

async function getSettings(env) {
  return env.DB.prepare("SELECT * FROM site_settings WHERE id = 1").first();
}

function isAdminUser(user, env) {
  if (!user) return false;
  return user.username.toLowerCase() === env.ADMIN_USERNAME.toLowerCase();
}

function publicUser(u) {
  if (!u) return null;
  // Never send other users' emails to the client; only the user's own.
  return {
    id: u.id,
    username: u.username,
    age: u.age,
    restricted: !!u.restricted,
    isAdmin: u.is_admin === 1,
  };
}

/* ------------------------------ middleware ------------------------------ */

// Attaches c.var.user (or null) on every request.
app.use("*", async (c, next) => {
  const user = await getUserFromRequest(c);
  if (user) await maybeLiftRestriction(c.env, user);
  c.set("user", user);
  await next();
});

// Blocks non-admin API traffic while maintenance mode is on.
// Auth endpoints and the public status endpoint stay reachable so
// people can still see the maintenance message.
app.use("/api/*", async (c, next) => {
  const allowlist = ["/api/site-status", "/api/login", "/api/register", "/api/me"];
  if (allowlist.includes(c.req.path)) return next();

  const settings = await getSettings(c.env);
  const user = c.get("user");
  if (settings.maintenance_mode && !isAdminUser(user, c.env)) {
    return c.json(
      { error: "maintenance", message: settings.maintenance_message },
      503
    );
  }
  await next();
});

function requireAuth(c) {
  const user = c.get("user");
  if (!user) return null;
  return user;
}

function requireAdmin(c) {
  const user = c.get("user");
  if (!user || !isAdminUser(user, c.env)) return null;
  return user;
}

/* --------------------------------- auth --------------------------------- */

// One-step signup/login: this app has no passwords. Provide a username,
// email, and age; if the username already exists we just log you back in.
// (Simple by design per the spec — for real deployments you'd want a real
// auth flow / email verification.)
app.post("/api/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username, email, age } = body;

  if (!username || typeof username !== "string" || username.length < 3) {
    return c.json({ error: "Username must be at least 3 characters." }, 400);
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "A valid email is required." }, 400);
  }
  const ageNum = Number(age);
  if (!Number.isInteger(ageNum) || ageNum < 1 || ageNum > 120) {
    return c.json({ error: "A valid age is required." }, 400);
  }

  const existing = await c.env.DB.prepare(
    "SELECT * FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(username)
    .first();

  let user;
  if (existing) {
    user = existing;
  } else {
    const id = uid();
    const restricted = ageNum < 13 ? 1 : 0;
    const restrictedUntil = restricted ? restrictedUntilFromAge(ageNum) : null;
    const isAdmin =
      username.toLowerCase() === c.env.ADMIN_USERNAME.toLowerCase() ? 1 : 0;

    await c.env.DB.prepare(
      `INSERT INTO users (id, username, email, age, restricted, restricted_until, is_admin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, username, email, ageNum, restricted, restrictedUntil, isAdmin, nowIso())
      .run();

    user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  }

  const token = await createSession(c.env, user.id);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  return c.json({ user: publicUser(user) });
});

app.post("/api/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.SESSIONS.delete(`session:${token}`);
  setCookie(c, SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const user = c.get("user");
  return c.json({ user: publicUser(user) });
});

/* --------------------------------- posts --------------------------------- */

app.get("/api/posts", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM comments cm WHERE cm.post_id = p.id) AS comment_count
     FROM posts p
     ORDER BY p.created_at DESC
     LIMIT 100`
  ).all();

  const user = c.get("user");
  let likedIds = new Set();
  if (user) {
    const { results: likedRows } = await c.env.DB.prepare(
      "SELECT post_id FROM likes WHERE user_id = ?"
    )
      .bind(user.id)
      .all();
    likedIds = new Set(likedRows.map((r) => r.post_id));
  }

  const posts = results.map((p) => ({
    id: p.id,
    userId: p.user_id,
    username: p.username,
    content: p.content,
    location: p.location,
    temperature: p.temperature,
    condition: p.condition,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    edited: !!p.edited,
    likeCount: p.like_count,
    commentCount: p.comment_count,
    likedByMe: likedIds.has(p.id),
    canEdit: !!user && user.id === p.user_id,
  }));

  return c.json({ posts });
});

app.post("/api/posts", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "You must sign in first." }, 401);
  if (user.restricted) {
    return c.json(
      { error: "Restricted mode is on for your account until you turn 13. Posting is disabled." },
      403
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const content = (body.content || "").trim();
  if (!content) return c.json({ error: "Post content is required." }, 400);
  if (content.length > 2000) return c.json({ error: "Post is too long." }, 400);

  const id = uid();
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO posts (id, user_id, username, content, location, temperature, condition, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      user.id,
      user.username,
      content,
      body.location || null,
      body.temperature || null,
      body.condition || null,
      ts,
      ts
    )
    .run();

  return c.json({ ok: true, id });
});

app.put("/api/posts/:id", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "You must sign in first." }, 401);

  const postId = c.req.param("id");
  const post = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?")
    .bind(postId)
    .first();
  if (!post) return c.json({ error: "Post not found." }, 404);
  if (post.user_id !== user.id) {
    return c.json({ error: "You can only edit your own posts." }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const content = (body.content || "").trim();
  if (!content) return c.json({ error: "Post content is required." }, 400);

  await c.env.DB.prepare(
    `UPDATE posts SET content = ?, location = ?, temperature = ?, condition = ?, updated_at = ?, edited = 1
     WHERE id = ?`
  )
    .bind(
      content,
      body.location ?? post.location,
      body.temperature ?? post.temperature,
      body.condition ?? post.condition,
      nowIso(),
      postId
    )
    .run();

  return c.json({ ok: true });
});

/* --------------------------------- likes --------------------------------- */

// Toggling: like if not liked, unlike if already liked.
app.post("/api/posts/:id/like", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "You must sign in first." }, 401);

  const postId = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT * FROM likes WHERE post_id = ? AND user_id = ?"
  )
    .bind(postId, user.id)
    .first();

  if (existing) {
    await c.env.DB.prepare("DELETE FROM likes WHERE id = ?").bind(existing.id).run();
    return c.json({ liked: false });
  } else {
    await c.env.DB.prepare(
      "INSERT INTO likes (id, post_id, user_id, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(uid(), postId, user.id, nowIso())
      .run();
    return c.json({ liked: true });
  }
});

/* ------------------------------- comments -------------------------------- */

app.get("/api/posts/:id/comments", async (c) => {
  const postId = c.req.param("id");
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC"
  )
    .bind(postId)
    .all();
  return c.json({
    comments: results.map((cm) => ({
      id: cm.id,
      username: cm.username,
      content: cm.content,
      createdAt: cm.created_at,
    })),
  });
});

app.post("/api/posts/:id/comments", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "You must sign in first." }, 401);
  if (user.restricted) {
    return c.json(
      { error: "Restricted mode is on for your account until you turn 13. Commenting is disabled." },
      403
    );
  }

  const postId = c.req.param("id");
  const post = await c.env.DB.prepare("SELECT id FROM posts WHERE id = ?")
    .bind(postId)
    .first();
  if (!post) return c.json({ error: "Post not found." }, 404);

  const body = await c.req.json().catch(() => ({}));
  const content = (body.content || "").trim();
  if (!content) return c.json({ error: "Comment content is required." }, 400);
  if (content.length > 1000) return c.json({ error: "Comment is too long." }, 400);

  await c.env.DB.prepare(
    "INSERT INTO comments (id, post_id, user_id, username, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(uid(), postId, user.id, user.username, content, nowIso())
    .run();

  return c.json({ ok: true });
});

/* ------------------------------ site status ------------------------------ */

// Public: powers the banners on the front page for every visitor.
app.get("/api/site-status", async (c) => {
  const s = await getSettings(c.env);
  return c.json({
    maintenanceMode: !!s.maintenance_mode,
    maintenanceMessage: s.maintenance_message,
    updateMode: !!s.update_mode,
    updateMessage: s.update_message,
    announcementActive: !!s.announcement_active,
    announcementText: s.announcement_text,
  });
});

/* --------------------------------- admin --------------------------------- */
// All admin routes require the signed-in user's username to match
// ADMIN_USERNAME (set in wrangler.toml). Reserve that username for
// yourself first so nobody else can register it.

app.post("/api/admin/maintenance", async (c) => {
  const admin = requireAdmin(c);
  if (!admin) return c.json({ error: "Admin access required." }, 403);
  const body = await c.req.json().catch(() => ({}));
  const enabled = !!body.enabled;
  const message = (body.message || "").trim() || "We are down for maintenance. Check back soon!";

  await c.env.DB.prepare(
    "UPDATE site_settings SET maintenance_mode = ?, maintenance_message = ? WHERE id = 1"
  )
    .bind(enabled ? 1 : 0, message)
    .run();

  return c.json({ ok: true });
});

app.post("/api/admin/update-mode", async (c) => {
  const admin = requireAdmin(c);
  if (!admin) return c.json({ error: "Admin access required." }, 403);
  const body = await c.req.json().catch(() => ({}));
  const enabled = !!body.enabled;
  const message = (body.message || "").trim() || "Please update the app to keep using it.";

  await c.env.DB.prepare(
    "UPDATE site_settings SET update_mode = ?, update_message = ? WHERE id = 1"
  )
    .bind(enabled ? 1 : 0, message)
    .run();

  return c.json({ ok: true });
});

app.post("/api/admin/announcement", async (c) => {
  const admin = requireAdmin(c);
  if (!admin) return c.json({ error: "Admin access required." }, 403);
  const body = await c.req.json().catch(() => ({}));
  const active = !!body.active;
  const text = (body.text || "").trim();

  await c.env.DB.prepare(
    "UPDATE site_settings SET announcement_active = ?, announcement_text = ? WHERE id = 1"
  )
    .bind(active ? 1 : 0, text)
    .run();

  return c.json({ ok: true });
});

export default app;

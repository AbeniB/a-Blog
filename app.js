const express = require("express");
const mongoose = require("mongoose");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;
const dataDir = path.join(__dirname, "data");
const postsFile = path.join(dataDir, "posts.json");
const usersFile = path.join(dataDir, "users.json");
const COOKIE_NAME = process.env.NODE_ENV === "production" ? "__Host-ablog_session" : "ablog_session";
const SESSION_TTL = 12 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const scrypt = promisify(crypto.scrypt);

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true, limit: "30kb" }));
app.use(express.static(path.join(__dirname, "public")));

const pageInfo = {
  about: "Hi, I’m Abenezer Berhanu, a Computer Science graduate who enjoys learning new technologies and working with a team. I believe in continuous learning and building thoughtful, useful web solutions just like this one. care to try it ?",
  contact: { email: "abenischool@gmail.com", location: "Addis Ababa, Ethiopia" }
};

function createFileStore() {
  let writes = Promise.resolve();
  function serialize(operation) {
    const result = writes.then(operation, operation);
    writes = result.catch(() => {});
    return result;
  }
  async function read(file) {
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(file, "[]", "utf8");
      return [];
    }
  }
  async function write(file, records) {
    await fs.mkdir(dataDir, { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, file);
  }
  const ensureWritesDone = () => writes;
  return {
    list: async () => { await ensureWritesDone(); return (await read(postsFile)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); },
    get: async id => { await ensureWritesDone(); return (await read(postsFile)).find(post => post._id === id) || null; },
    create: data => serialize(async () => {
      const posts = await read(postsFile);
      const post = { _id: crypto.randomUUID(), ...data, createdAt: new Date().toISOString() };
      posts.push(post); await write(postsFile, posts); return post;
    }),
    updateOwned: (id, userId, data) => serialize(async () => {
      const posts = await read(postsFile); const index = posts.findIndex(post => post._id === id && post.authorId === userId);
      if (index < 0) return null;
      posts[index] = { ...posts[index], ...data }; await write(postsFile, posts); return posts[index];
    }),
    removeOwned: (id, userId) => serialize(async () => {
      const posts = await read(postsFile); const next = posts.filter(post => !(post._id === id && post.authorId === userId));
      if (next.length === posts.length) return false;
      await write(postsFile, next); return true;
    }),
    findUserByEmail: async email => { await ensureWritesDone(); return (await read(usersFile)).find(user => user.email === email) || null; },
    findUserById: async id => { await ensureWritesDone(); return (await read(usersFile)).find(user => user._id === id) || null; },
    createUser: data => serialize(async () => {
      const users = await read(usersFile);
      if (users.some(user => user.email === data.email)) return null;
      const user = { _id: crypto.randomUUID(), ...data, createdAt: new Date().toISOString() };
      users.push(user); await write(usersFile, users); return user;
    })
  };
}

function createMongoStore() {
  const postSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true, maxlength: 120 },
    content: { type: String, required: true, trim: true, maxlength: 20000 },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true, index: true },
    authorName: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now }
  });
  const userSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    passwordSalt: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  });
  const Post = mongoose.models.Post || mongoose.model("Post", postSchema);
  const Account = mongoose.models.Account || mongoose.model("Account", userSchema);
  return {
    list: () => Post.find({}).sort({ createdAt: -1 }).lean(),
    get: id => mongoose.isValidObjectId(id) ? Post.findById(id).lean() : null,
    create: data => Post.create(data),
    updateOwned: async (id, userId, data) => mongoose.isValidObjectId(id) ? Post.findOneAndUpdate({ _id: id, authorId: userId }, data, { new: true, runValidators: true }).lean() : null,
    removeOwned: async (id, userId) => {
      if (!mongoose.isValidObjectId(id)) return false;
      const deleted = await Post.findOneAndDelete({ _id: id, authorId: userId });
      return Boolean(deleted);
    },
    findUserByEmail: email => Account.findOne({ email }).lean(),
    findUserById: id => mongoose.isValidObjectId(id) ? Account.findById(id).lean() : null,
    createUser: async data => {
      try { return await Account.create(data); }
      catch (error) { if (error.code === 11000) return null; throw error; }
    }
  };
}

function cookieOptions(value, maxAge) {
  return [`${COOKIE_NAME}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, ...(process.env.NODE_ENV === "production" ? ["Secure"] : [])].join("; ");
}
function newSession(userId = null) {
  const id = crypto.randomBytes(32).toString("base64url");
  const session = { userId, csrfToken: crypto.randomBytes(32).toString("base64url"), expiresAt: Date.now() + SESSION_TTL };
  sessions.set(id, session);
  return { id, session };
}
app.use((req, res, next) => {
  const pairs = (req.headers.cookie || "").split(";");
  const cookie = pairs.map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`));
  const id = cookie ? cookie.slice(COOKIE_NAME.length + 1) : "";
  let session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    if (id) sessions.delete(id);
    const fresh = newSession();
    req.sessionId = fresh.id; session = fresh.session;
    res.setHeader("Set-Cookie", cookieOptions(fresh.id, Math.floor(SESSION_TTL / 1000)));
  } else {
    req.sessionId = id;
    session.expiresAt = Date.now() + SESSION_TTL;
    res.setHeader("Set-Cookie", cookieOptions(id, Math.floor(SESSION_TTL / 1000)));
  }
  req.session = session;
  res.locals.currentUser = session.user || null;
  res.locals.csrfToken = session.csrfToken;
  if (Math.random() < 0.01) {
    const now = Date.now();
    for (const [sessionId, active] of sessions) if (active.expiresAt <= now) sessions.delete(sessionId);
    for (const [address, attempt] of loginAttempts) if (now - attempt.startedAt > 15 * 60 * 1000) loginAttempts.delete(address);
  }
  next();
});
app.use(async (req, res, next) => {
  if (req.session.userId) {
    try {
      const user = await store.findUserById(req.session.userId);
      if (!user) {
        sessions.delete(req.sessionId);
        res.setHeader("Set-Cookie", cookieOptions("", 0));
        req.session = { userId: null, csrfToken: crypto.randomBytes(32).toString("base64url") };
      } else {
        req.session.user = { id: String(user._id), name: user.name, email: user.email };
      }
    } catch (error) { return next(error); }
  }
  res.locals.currentUser = req.session.user || null;
  next();
});
app.use((req, res, next) => {
  if (req.method === "POST") {
    const supplied = req.body.csrfToken || "";
    const expected = req.session.csrfToken || "";
    const actualBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
      return res.status(403).render("message", { heading: "Please refresh and try again.", message: "Your form session expired. Reload the page and submit it once more." });
    }
  }
  next();
});

function formatPost(post, currentUser) {
  const item = post.toObject ? post.toObject() : post;
  return {
    ...item,
    authorName: item.authorName || "a-Blog",
    isOwner: Boolean(currentUser && item.authorId && String(item.authorId) === currentUser.id),
    dateLabel: new Date(item.createdAt || Date.now()).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })
  };
}
function safeReturnTo(value) { return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/"; }
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}
function renderAuth(res, type, error = null, values = {}) {
  res.status(error ? 400 : 200).render(type, { error, values });
}
function authRateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const state = loginAttempts.get(key);
  if (!state || now - state.startedAt > 15 * 60 * 1000) loginAttempts.set(key, { count: 1, startedAt: now });
  else if (state.count >= 10) return res.status(429).render("message", { heading: "Take a short break.", message: "Too many account attempts. Please wait a few minutes and try again." });
  else state.count += 1;
  next();
}
async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt, hash: hash.toString("hex") };
}
async function passwordMatches(password, user) {
  const { hash } = await hashPassword(password, user.passwordSalt);
  const actual = Buffer.from(hash, "hex"); const expected = Buffer.from(user.passwordHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function setSessionCookie(res, sessionId, maxAge = Math.floor(SESSION_TTL / 1000)) {
  res.setHeader("Set-Cookie", cookieOptions(sessionId, maxAge));
}
function startUserSession(req, res, user) {
  sessions.delete(req.sessionId);
  const fresh = newSession(String(user._id));
  fresh.session.user = { id: String(user._id), name: user.name, email: user.email };
  req.sessionId = fresh.id;
  setSessionCookie(res, fresh.id);
}

app.get("/", async (req, res, next) => {
  try { res.render("home", { posts: (await store.list()).map(post => formatPost(post, req.session.user)) }); }
  catch (error) { next(error); }
});
app.get("/about", (req, res) => res.render("about", { content: pageInfo.about }));
app.get("/contact", (req, res) => res.render("contact", { contact: pageInfo.contact }));
app.get("/register", (req, res) => req.session.user ? res.redirect("/") : renderAuth(res, "register", null, {}));
app.post("/register", authRateLimit, async (req, res, next) => {
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  if (name.length < 2 || name.length > 60 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 10 || password.length > 128) {
    return renderAuth(res, "register", "Use a name, a valid email, and a password between 10 and 128 characters.", { name, email });
  }
  try {
    if (await store.findUserByEmail(email)) return renderAuth(res, "register", "An account with that email already exists. Try logging in.", { name, email });
    const credentials = await hashPassword(password);
    const user = await store.createUser({ name, email, passwordSalt: credentials.salt, passwordHash: credentials.hash });
    if (!user) return renderAuth(res, "register", "An account with that email already exists. Try logging in.", { name, email });
    startUserSession(req, res, user);
    res.redirect("/");
  } catch (error) { next(error); }
});
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("login", { error: null, values: { next: safeReturnTo(req.query.next) }, nextUrl: safeReturnTo(req.query.next) });
});
app.post("/login", authRateLimit, async (req, res, next) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  const nextUrl = safeReturnTo(req.body.next);
  try {
    const user = await store.findUserByEmail(email);
    if (!user) await scrypt(password, "littlejournal-dummy-salt", 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const valid = Boolean(user && await passwordMatches(password, user));
    if (!user || !valid) return res.status(400).render("login", { error: "Email or password wasn’t recognized.", values: { email, next: nextUrl }, nextUrl });
    loginAttempts.delete(req.ip || req.socket.remoteAddress || "unknown");
    startUserSession(req, res, user);
    res.redirect(nextUrl);
  } catch (error) { next(error); }
});
app.post("/logout", requireAuth, (req, res) => {
  sessions.delete(req.sessionId);
  res.setHeader("Set-Cookie", cookieOptions("", 0));
  res.redirect("/");
});
app.get("/compose", requireAuth, (req, res) => res.render("compose", { error: null, values: {}, editing: false }));
app.post("/compose", requireAuth, async (req, res, next) => {
  const title = (req.body.postTitle || "").trim(); const content = (req.body.postBody || "").trim();
  if (!title || !content || title.length > 120 || content.length > 20000) {
    return res.status(400).render("compose", { error: "Add a title (up to 120 characters) and story (up to 20,000 characters).", values: { title, content }, editing: false });
  }
  try {
    const post = await store.create({ title, content, authorId: req.session.user.id, authorName: req.session.user.name });
    res.redirect(`/posts/${post._id}`);
  } catch (error) { next(error); }
});
app.get("/posts/:id", async (req, res, next) => {
  try {
    const post = await store.get(req.params.id);
    if (!post) return res.status(404).render("not-found");
    res.render("post", { post: formatPost(post, req.session.user) });
  } catch (error) { next(error); }
});
app.get("/posts/:id/edit", requireAuth, async (req, res, next) => {
  try {
    const post = await store.get(req.params.id);
    if (!post || String(post.authorId) !== req.session.user.id) return res.status(404).render("not-found");
    res.render("compose", { error: null, values: { title: post.title, content: post.content }, editing: true, postId: post._id });
  } catch (error) { next(error); }
});
app.post("/posts/:id/edit", requireAuth, async (req, res, next) => {
  const title = (req.body.postTitle || "").trim(); const content = (req.body.postBody || "").trim();
  if (!title || !content || title.length > 120 || content.length > 20000) {
    return res.status(400).render("compose", { error: "Add a title (up to 120 characters) and story (up to 20,000 characters).", values: { title, content }, editing: true, postId: req.params.id });
  }
  try {
    const post = await store.updateOwned(req.params.id, req.session.user.id, { title, content });
    if (!post) return res.status(404).render("not-found");
    res.redirect(`/posts/${post._id}`);
  } catch (error) { next(error); }
});
app.post("/posts/:id/delete", requireAuth, async (req, res, next) => {
  try {
    if (!await store.removeOwned(req.params.id, req.session.user.id)) return res.status(404).render("not-found");
    res.redirect("/");
  } catch (error) { next(error); }
});
app.use((req, res) => res.status(404).render("not-found"));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).render("error");
});

let store;
async function start() {
  if (process.env.MONGO_URI || process.env.mongoSRV) {
    try {
      await mongoose.connect(process.env.MONGO_URI || process.env.mongoSRV, { dbName: "a_blog", serverSelectionTimeoutMS: 4000 });
      store = createMongoStore(); console.log("Connected to MongoDB");
    } catch (error) {
      console.warn(`MongoDB unavailable (${error.message}). Using the local JSON store.`);
      store = createFileStore();
    }
  } else {
    store = createFileStore(); console.log("MONGO_URI not set; using the local JSON store.");
  }
  app.listen(port, () => console.log(`a-Blog is running at http://localhost:${port}`));
}
start().catch(error => { console.error("Could not start the blog:", error); process.exitCode = 1; });

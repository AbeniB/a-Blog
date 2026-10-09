const mongoose = require("mongoose");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
require("dotenv").config();

const scrypt = promisify(crypto.scrypt);
const dataDirectory = path.join(__dirname, "data");
const usersFile = path.join(dataDirectory, "users.json");
const postsFile = path.join(dataDirectory, "posts.json");
const demoUsers = [
  { name: "Abenezer Berhanu", email: "abenezer@ablog.example" },
  { name: "Sara Bekele", email: "sara@ablog.example" },
  { name: "Mikael Tesfaye", email: "mikael@ablog.example" }
];
const stories = [
  { title: "Making room for a slower morning", email: demoUsers[0].email, content: "I used to treat the first hour of the day like a race. Lately, I have been trying something simpler: opening the window, making coffee, and choosing one thing to do well. It is a small change, but the day feels more like mine when I begin it on purpose." },
  { title: "A walk with no destination", email: demoUsers[1].email, content: "Yesterday I took the long way home without checking a map. I noticed a tiny bookshop, a jacaranda tree dropping purple flowers, and a bakery I had passed dozens of times. Sometimes the best plan is to leave a little space for an unexpected turn." },
  { title: "The joy of learning one small thing", email: demoUsers[2].email, content: "I have been learning a new recipe one step at a time. The first attempt was uneven, the second was better, and the third finally tasted like the dish I had imagined. Progress is often quiet. It looks a lot like being willing to try again." },
  { title: "Notes from a curious developer", email: demoUsers[0].email, content: "The best part of building something is the moment a confusing idea becomes a useful little feature. I am trying to spend more time listening, sketching the simplest version, and improving it with care. There is always another detail to learn." }
];

async function hashPassword(password) {
  const passwordSalt = crypto.randomBytes(16).toString("hex");
  const passwordHash = (await scrypt(password, passwordSalt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString("hex");
  return { passwordSalt, passwordHash };
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(dataDirectory, { recursive: true });
    await fs.writeFile(file, "[]", { encoding: "utf8", mode: 0o600 });
    return [];
  }
}
async function writeJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
}

function models() {
  const accountSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    passwordSalt: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  });
  const postSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true, maxlength: 120 },
    content: { type: String, required: true, trim: true, maxlength: 20000 },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true, index: true },
    authorName: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now }
  });
  return {
    Account: mongoose.models.Account || mongoose.model("Account", accountSchema),
    Post: mongoose.models.Post || mongoose.model("Post", postSchema)
  };
}

async function seedMongo() {
  await mongoose.connect(process.env.MONGO_URI || process.env.mongoSRV, { dbName: "a_blog", serverSelectionTimeoutMS: 4000 });
  const { Account, Post } = models();
  await Account.init();
  const credentials = [];
  const users = new Map();
  for (const details of demoUsers) {
    let user = await Account.findOne({ email: details.email });
    if (!user) {
      const password = crypto.randomBytes(15).toString("base64url");
      const secrets = await hashPassword(password);
      user = await Account.create({ ...details, ...secrets });
      credentials.push({ name: details.name, email: details.email, password });
    }
    users.set(details.email, user);
  }
  let addedPosts = 0;
  for (const story of stories) {
    const author = users.get(story.email);
    const existing = await Post.findOne({ title: story.title, authorId: author._id });
    if (!existing) {
      await Post.create({ title: story.title, content: story.content, authorId: author._id, authorName: author.name });
      addedPosts += 1;
    }
  }
  return { backend: "MongoDB database a_blog", credentials, addedPosts, accountCount: users.size };
}

async function seedFiles() {
  const accounts = await readJson(usersFile);
  const posts = await readJson(postsFile);
  const credentials = [];
  const users = new Map();
  for (const details of demoUsers) {
    let user = accounts.find(account => account.email === details.email);
    if (!user) {
      const password = crypto.randomBytes(15).toString("base64url");
      user = { _id: crypto.randomUUID(), ...details, ...(await hashPassword(password)), createdAt: new Date().toISOString() };
      accounts.push(user);
      credentials.push({ name: details.name, email: details.email, password });
    }
    users.set(details.email, user);
  }
  let addedPosts = 0;
  for (const story of stories) {
    const author = users.get(story.email);
    if (!posts.some(post => post.title === story.title && post.authorId === author._id)) {
      posts.push({ _id: crypto.randomUUID(), title: story.title, content: story.content, authorId: author._id, authorName: author.name, createdAt: new Date(Date.now() - addedPosts * 86400000).toISOString() });
      addedPosts += 1;
    }
  }
  await writeJson(usersFile, accounts);
  await writeJson(postsFile, posts);
  return { backend: "local JSON store", credentials, addedPosts, accountCount: users.size };
}

(async () => {
  let result;
  if (process.env.MONGO_URI || process.env.mongoSRV) {
    try { result = await seedMongo(); }
    catch {
      await mongoose.disconnect().catch(() => {});
      result = await seedFiles();
      result.mongoUnavailable = true;
    }
  } else result = await seedFiles();

  console.log(`Seeded ${result.backend}: ${result.accountCount} demo accounts, ${result.addedPosts} new sample posts.`);
  if (result.mongoUnavailable) console.log("MongoDB could not be reached; these records are in the local JSON store.");
  if (result.credentials.length) {
    console.log("Save these one-time demo passwords:");
    for (const account of result.credentials) console.log(`${account.name} | ${account.email} | ${account.password}`);
  } else console.log("Demo accounts already existed; their existing passwords were left unchanged.");
  await mongoose.disconnect().catch(() => {});
})().catch(async error => {
  console.error("Could not seed the blog:", error.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});

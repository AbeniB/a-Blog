# a-Blog

A small Express and EJS blog. Create an account, publish stories, and manage your own posts. Visitors can read all published posts.

## Run locally

```sh
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000), then create an account to publish. MongoDB connections always use the `a_blog` database. Without a reachable MongoDB connection, posts and password hashes are saved in `data/posts.json` and `data/users.json`.

Passwords are stored as salted scrypt hashes. The app uses expiring, server-side sessions, HTTP-only same-site cookies, CSRF checks on forms, and ownership-scoped edit and delete operations. Existing posts without an account owner remain public but cannot be edited or deleted through the app.

## Use MongoDB

Create a `.env` file in the project folder and set `MONGO_URI` to your MongoDB connection string. The app also accepts the original `mongoSRV` variable. When MongoDB is unavailable, the app falls back to the local JSON store.

Set `PORT` in `.env` to change the default port.

Run `npm run seed` to add three demo accounts and four sample stories. It is safe to run again; existing demo accounts keep their passwords and existing sample posts are not duplicated. Newly created account passwords are printed once in the terminal.

For deployment, set `NODE_ENV=production` and serve the app over HTTPS so the secure session cookie is accepted. Sessions are held in memory and expire after 12 hours; a process restart signs everyone out.

// Drizzle: `drizzle-kit pull` writes the schema and its relations from the database into TypeScript, and each query is built on them. An expression Drizzle has no helper for is its `sql` fragment, untyped as Drizzle leaves it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../probes.ts";
import { gitDelta, gitInit, sh, workdir } from "./lib.ts";
import { ormTool, projectDir, root, versionOf, type Entry } from "./orm.ts";

const DIALECT: Record<Db, string> = { postgres: "postgresql", mysql: "mysql", sqlite: "sqlite" };
const CLIENT: Record<Db, [string, string]> = { postgres: ["NodePgDatabase", "drizzle-orm/node-postgres"], mysql: ["MySql2Database", "drizzle-orm/mysql2"], sqlite: ["BetterSQLite3Database", "drizzle-orm/better-sqlite3"] };

const bySql = (pg: string, mysql: string) => ({ postgres: pg, sqlite: pg, mysql });
const LEFT = "db.select({ name: users.name, title: posts.title }).from(users).leftJoin(posts, eq(posts.authorId, users.id))";
const queries: Record<string, Entry> = {
  "outer-joins:left": LEFT,
  "outer-joins:left-sorted": `${LEFT}.orderBy(posts.title)`,
  "outer-joins:left-where": `${LEFT}.where(eq(users.id, $1))`,
  "outer-joins:left-subquery": "{ const x = db.select({ authorId: posts.authorId, title: posts.title }).from(posts).as('x'); return db.select({ name: users.name, title: x.title }).from(users).leftJoin(x, eq(x.authorId, users.id)); }",
  "outer-joins:right": "db.select({ name: users.name, title: posts.title }).from(posts).rightJoin(users, eq(users.id, posts.authorId))",
  "outer-joins:full": "db.select({ name: users.name, title: posts.title }).from(users).fullJoin(posts, eq(posts.authorId, users.id))",

  "expressions:count": "db.select({ v: count() }).from(posts)",
  "expressions:max": "db.select({ v: max(posts.id) }).from(posts)",
  "expressions:sum": "db.select({ v: sum(posts.score) }).from(posts)",
  "expressions:coalesce": "db.select({ v: sql`coalesce(${users.nickname}, 'x')` }).from(users)",
  "expressions:concat": bySql("db.select({ v: sql`${users.name} || '!'` }).from(users)", "db.select({ v: sql`concat(${users.name}, '!')` }).from(users)"),
  "expressions:concat-nullable": bySql("db.select({ v: sql`${users.nickname} || '!'` }).from(users)", "db.select({ v: sql`concat(${users.nickname}, '!')` }).from(users)"),
  "expressions:upper": "db.select({ v: sql`upper(${users.name})` }).from(users)",
  "expressions:upper-nullable": "db.select({ v: sql`upper(${users.nickname})` }).from(users)",
  "expressions:add": "db.select({ v: sql`${posts.id} + 1` }).from(posts)",
  "expressions:add-nullable": "db.select({ v: sql`${posts.score} + 1` }).from(posts)",
  "expressions:nullif": "db.select({ v: sql`nullif(${users.name}, 'x')` }).from(users)",
  "expressions:case-no-else": "db.select({ v: sql`case when ${users.id} > 0 then ${users.name} end` }).from(users)",
  "expressions:is-null": "db.select({ v: isNull(users.nickname) }).from(users)",
  "expressions:subquery-count": "db.select({ v: db.$count(posts) }).from(users)",
  "expressions:exists": "db.select({ v: exists(db.select({ one: sql`1` }).from(posts)) }).from(users)",
  "expressions:row-number": "db.select({ v: sql`row_number() over (order by ${users.id})` }).from(users)",
  "expressions:lag": "db.select({ v: sql`lag(${users.id}) over (order by ${users.id})` }).from(users)",
  "expressions:union": "db.select({ v: users.id }).from(users).unionAll(db.select({ v: posts.score }).from(posts))",
  "expressions:grouped-max": "db.select({ v: max(posts.id) }).from(posts).groupBy(posts.authorId)",

  "parameter-types:eq-int": "db.select({ name: users.name }).from(users).where(eq(users.id, $1))",
  "parameter-types:eq-text": "db.select({ id: users.id }).from(users).where(eq(users.name, $1))",
  "parameter-types:insert": "db.insert(posts).values({ id: $1, authorId: $2, title: $3, score: $4 })",
  "parameter-types:limit": "db.select({ id: users.id }).from(users).limit($1)",
  "parameter-types:like": "db.select({ id: users.id }).from(users).where(like(users.name, $1))",
  "parameter-types:uuid": "db.select({ id: users.id }).from(users).where(eq(users.externalId, $1))",
  "parameter-types:timestamp": "db.select({ id: posts.id }).from(posts).where(gt(posts.createdAt, $1))",

  "parameter-nullability:insert": "db.insert(users).values({ id: $1, email: $2, name: $3, nickname: $4 })",
  "parameter-nullability:update": "db.update(users).set({ nickname: $1 }).where(eq(users.id, $2))",
  "parameter-nullability:eq-key": "db.select({ name: users.name }).from(users).where(eq(users.id, $1))",
  "parameter-nullability:eq-nullable": "db.select({ id: users.id }).from(users).where(eq(users.nickname, $1))",

  // A nested object is a nested selection; rows nested in a row are the relational query's `with`.
  "json-shapes:object": "db.select({ v: { id: users.id, name: users.name } }).from(users)",
  "json-shapes:aggregate": "db.query.users.findMany({ columns: {}, with: { posts: { columns: { id: true, title: true } } } })",

  "json-schema:column": "db.select({ payload: events.payload }).from(events)",
  "json-schema:parameter": "db.insert(events).values({ id: $1, payload: $2 })",

  "smoke:smoke": "db.select({ id: users.id, name: users.name }).from(users)",
};

export const drizzle = ormTool({
  id: "drizzle",
  name: "Drizzle",
  version: versionOf("drizzle-orm"),
  dbs: ["postgres", "mysql", "sqlite"],
  cardinalityNote: "Each call picks how many rows it takes: a query returns an array, and `findFirst` at most one row.",
  queries,
  raw: /sql`/,
  project(db, urls) {
    const dir = workdir("drizzle");
    projectDir(dir);
    const credentials = db === "sqlite" ? { url: urls.sqlite } : { url: db === "postgres" ? urls.postgres : urls.mysql };
    writeFileSync(join(dir, "drizzle.config.ts"), `import { defineConfig } from "drizzle-kit";\nexport default defineConfig({ dialect: "${DIALECT[db]}", out: "./db", dbCredentials: ${JSON.stringify(credentials)} });\n`);
    gitInit(dir);
    const pull = sh(join(root, "node_modules/.bin/drizzle-kit"), ["pull"], { cwd: dir });
    if (pull.status !== 0) throw new Error(`drizzle-kit pull on ${db}: ${pull.all}`);
    const wrote = gitDelta(dir);
    const [type, from] = CLIENT[db];
    const tables = db === "postgres" ? "users, posts, events" : "users, posts";
    const prelude = [
      `import { eq, gt, like, isNull, exists, count, max, sum, sql } from "drizzle-orm";`,
      `import type { ${type} } from "${from}";`,
      `import * as schema from "./db/schema";`,
      `import * as relations from "./db/relations";`,
      `import { ${tables} } from "./db/schema";`,
      `declare const db: ${type}<typeof schema & typeof relations>;`,
    ].join("\n");
    return { dir, prelude, wrote };
  },
});

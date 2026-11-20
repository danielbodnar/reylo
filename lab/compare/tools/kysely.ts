// Kysely: `kysely-codegen` writes the database's tables as TypeScript interfaces, and each query is built on them. A function Kysely has no typed helper for is its `eb.fn(…)`, untyped as Kysely leaves it.
import { join } from "node:path";
import type { Db } from "../probes.ts";
import { gitDelta, gitInit, sh, workdir } from "./lib.ts";
import { ormTool, projectDir, root, versionOf, type Entry } from "./orm.ts";

const HELPERS: Record<Db, string> = { postgres: "postgres", mysql: "mysql", sqlite: "sqlite" };

const LEFT = "db.selectFrom('users as u').leftJoin('posts as p', 'p.author_id', 'u.id').select(['u.name', 'p.title'])";
const one = (expr: string, from = "users") => `db.selectFrom('${from}').select((eb) => ${expr}.as('v')).execute()`;
const noFrom = (expr: string) => `db.selectNoFrom((eb) => ${expr}.as('v')).execute()`;
const queries: Record<string, Entry> = {
  "outer-joins:left": `${LEFT}.execute()`,
  "outer-joins:left-sorted": `${LEFT}.orderBy('p.title').execute()`,
  "outer-joins:left-where": `${LEFT}.where('u.id', '=', $1).execute()`,
  "outer-joins:left-subquery": "db.selectFrom('users as u').leftJoin(db.selectFrom('posts').select(['author_id', 'title']).as('x'), 'x.author_id', 'u.id').select(['u.name', 'x.title']).execute()",
  "outer-joins:right": "db.selectFrom('posts as p').rightJoin('users as u', 'u.id', 'p.author_id').select(['u.name', 'p.title']).execute()",
  "outer-joins:full": "db.selectFrom('users as u').fullJoin('posts as p', 'p.author_id', 'u.id').select(['u.name', 'p.title']).execute()",

  "expressions:count": one("eb.fn.countAll()", "posts"),
  "expressions:max": one("eb.fn.max('id')", "posts"),
  "expressions:sum": one("eb.fn.sum('score')", "posts"),
  "expressions:coalesce": one("eb.fn.coalesce('nickname', eb.val('x'))"),
  "expressions:concat": { postgres: one("eb('name', '||', '!')"), sqlite: one("eb('name', '||', '!')"), mysql: one("eb.fn('concat', ['name', eb.val('!')])") },
  "expressions:concat-nullable": { postgres: one("eb('nickname', '||', '!')"), sqlite: one("eb('nickname', '||', '!')"), mysql: one("eb.fn('concat', ['nickname', eb.val('!')])") },
  "expressions:upper": one("eb.fn('upper', ['name'])"),
  "expressions:upper-nullable": one("eb.fn('upper', ['nickname'])"),
  "expressions:add": one("eb('id', '+', 1)", "posts"),
  "expressions:add-nullable": one("eb('score', '+', 1)", "posts"),
  "expressions:nullif": one("eb.fn('nullif', ['name', eb.val('x')])"),
  "expressions:case-no-else": one("eb.case().when('id', '>', 0).then(eb.ref('name')).end()"),
  "expressions:is-null": one("eb('nickname', 'is', null)"),
  "expressions:subquery-count": noFrom("eb.selectFrom('posts').select(eb.fn.countAll().as('c'))"),
  "expressions:exists": noFrom("eb.exists(eb.selectFrom('posts').select(eb.lit(1).as('one')))"),
  "expressions:row-number": one("eb.fn.agg('row_number').over((ob) => ob.orderBy('id'))"),
  "expressions:lag": one("eb.fn.agg('lag', ['id']).over((ob) => ob.orderBy('id'))"),
  "expressions:union": "db.selectFrom('users').select('id as v').unionAll(db.selectFrom('posts').select('score as v')).execute()",
  "expressions:grouped-max": "db.selectFrom('posts').select((eb) => eb.fn.max('id').as('v')).groupBy('author_id').execute()",

  "parameter-types:eq-int": "db.selectFrom('users').select('name').where('id', '=', $1).execute()",
  "parameter-types:eq-text": "db.selectFrom('users').select('id').where('name', '=', $1).execute()",
  "parameter-types:insert": "db.insertInto('posts').values({ id: $1, author_id: $2, title: $3, score: $4 }).execute()",
  "parameter-types:limit": "db.selectFrom('users').select('id').limit($1).execute()",
  "parameter-types:like": "db.selectFrom('users').select('id').where('name', 'like', $1).execute()",
  "parameter-types:uuid": "db.selectFrom('users').select('id').where('external_id', '=', $1).execute()",
  "parameter-types:timestamp": "db.selectFrom('posts').select('id').where('created_at', '>', $1).execute()",

  "parameter-nullability:insert": "db.insertInto('users').values({ id: $1, email: $2, name: $3, nickname: $4 }).execute()",
  "parameter-nullability:update": "db.updateTable('users').set({ nickname: $1 }).where('id', '=', $2).execute()",
  "parameter-nullability:eq-key": "db.selectFrom('users').select('name').where('id', '=', $1).execute()",
  "parameter-nullability:eq-nullable": "db.selectFrom('users').select('id').where('nickname', '=', $1).execute()",

  "json-shapes:object": one("jsonBuildObject({ id: eb.ref('id'), name: eb.ref('name') })"),
  "json-shapes:aggregate": noFrom("jsonArrayFrom(eb.selectFrom('posts').select(['id', 'title']))"),

  "json-schema:column": "db.selectFrom('events').select('payload').execute()",
  "json-schema:parameter": "db.insertInto('events').values({ id: $1, payload: $2 }).execute()",

  "smoke:smoke": "db.selectFrom('users').select(['id', 'name']).execute()",
};

export const kysely = ormTool({
  id: "kysely",
  name: "Kysely",
  version: versionOf("kysely"),
  dbs: ["postgres", "mysql", "sqlite"],
  cardinalityNote: "Each call picks how many rows it takes: `execute` returns an array, and `executeTakeFirst` at most one row.",
  queries,
  raw: /eb\.fn\(|eb\.fn\.agg\(/,
  project(db, urls) {
    const dir = workdir("kysely");
    projectDir(dir);
    gitInit(dir);
    const url = db === "postgres" ? urls.postgres : db === "mysql" ? urls.mysql : urls.sqlite;
    const gen = sh(join(root, "node_modules/.bin/kysely-codegen"), ["--dialect", db, "--url", url, "--out-file", "db.d.ts"], { cwd: dir });
    if (gen.status !== 0) throw new Error(`kysely-codegen on ${db}: ${gen.all}`);
    const wrote = gitDelta(dir);
    const prelude = [
      `import { Kysely, sql } from "kysely";`,
      `import { jsonArrayFrom, jsonBuildObject } from "kysely/helpers/${HELPERS[db]}";`,
      `import type { DB } from "./db";`,
      `declare const db: Kysely<DB>;`,
    ].join("\n");
    return { dir, prelude, wrote };
  },
});

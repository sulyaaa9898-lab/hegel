import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('cyber_stack.db');

db.all("SELECT name, type, sql FROM sqlite_master WHERE sql LIKE '%admins_old%' ORDER BY type, name", (err, rows) => {
  if (err) {
    console.error(err);
    process.exitCode = 1;
    db.close();
    return;
  }

  console.log(JSON.stringify(rows, null, 2));
  db.close();
});

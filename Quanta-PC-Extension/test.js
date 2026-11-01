const fs = require('fs');
const initSqlJs = require('sql.js');
initSqlJs().then(SQL => {
  const filebuffer = fs.readFileSync('C:/Users/soham/.gemini/antigravity-ide/conversations/f878a2aa-b340-4634-8217-b2bb7fdb6420.db');
  const db = new SQL.Database(filebuffer);
  const res = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  const res2 = db.exec("SELECT step_payload, step_type FROM steps");
  const payloads = res2[0].values.map(v => {
    if (!v[0]) return null;
    const text = Buffer.from(v[0]).toString('utf8').replace(/[^\x20-\x7E\n]/g, '');
    return { type: v[1], text: text.substring(0, 500) };
  });
  console.log(JSON.stringify(payloads.slice(0, 10), null, 2));
});

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DBSOURCE = "/data/db.sqlite";

// Ensure the directory for the database exists
const dbDir = path.dirname(DBSOURCE);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`Created database directory: ${dbDir}`);
}

let db = new sqlite3.Database(DBSOURCE, (err) => {
    if (err) {
      // Cannot open database
      console.error(err.message)
      throw err
    }else{
        console.log('Connected to the SQLite database.');
        db.run(`CREATE TABLE IF NOT EXISTS articles (
            link TEXT PRIMARY KEY,
            open_count INTEGER DEFAULT 0
        )`, (err) => {
            if (err) {
                // Table already created
            }else{
                // Table just created, creating some rows
                console.log('Table "articles" created.');
            }
        });
    }
});

module.exports = db;

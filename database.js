const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DBSOURCE = "./db/db.sqlite";

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
        db.serialize(() => {
            // First, ensure the table exists
            db.run(`CREATE TABLE IF NOT EXISTS articles (
                link TEXT PRIMARY KEY,
                open_count INTEGER DEFAULT 0
            )`, (err) => {
                if (err) {
                    console.error('Error creating articles table:', err.message);
                    return;
                }
                console.log('Table "articles" is ready.');

                // Next, add new columns for caching if they don't exist
                const columns = [
                    { name: 'title', type: 'TEXT' },
                    { name: 'summary', type: 'TEXT' },
                    { name: 'date', type: 'TEXT' },
                    { name: 'cached_at', type: 'DATETIME' }
                ];
//Sigmas
                db.all("PRAGMA table_info(articles)", (err, existingColumns) => {
                    if (err) {
                        console.error('Error fetching table info:', err.message);
                        return;
                    }
                    const existingColumnNames = existingColumns.map(c => c.name);
                    columns.forEach(column => {
                        if (!existingColumnNames.includes(column.name)) {
                            db.run(`ALTER TABLE articles ADD COLUMN ${column.name} ${column.type}`, (err) => {
                                if (err) {
                                    console.error(`Error adding column ${column.name}:`, err.message);
                                } else {
                                    console.log(`Column "${column.name}" added to "articles" table.`);
                                }
                            });
                        }
                    });
                });
            });
        });
    }
});

module.exports = db;

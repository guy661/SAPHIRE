const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const DBSOURCE = "./db/db.sqlite";


const dbDir = path.dirname(DBSOURCE);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`Created database directory: ${dbDir}`);
}

let db = new sqlite3.Database(DBSOURCE, (err) => {
    if (err) {
      
      console.error(err.message)
      throw err
    }else{
        console.log('Connected to the SQLite database.');
        db.serialize(() => {
            
            db.run(`CREATE TABLE IF NOT EXISTS articles (
                link TEXT PRIMARY KEY,
                open_count INTEGER DEFAULT 0
            )`, (err) => {
                if (err) {
                    console.error('Error creating articles table:', err.message);
                    return;
                }
                                console.log('Table "articles" is ready.');
                
                                db.run(`CREATE TABLE IF NOT EXISTS users (
                                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                                    username TEXT UNIQUE,
                                    password TEXT
                                )`, (err) => {
                                    if (err) {
                                        console.error('Error creating users table:', err.message);
                                        return;
                                    }
                                    console.log('Table "users" is ready.');
                                });
                
                                const columns = [
                    { name: 'title', type: 'TEXT' },
                    { name: 'summary', type: 'TEXT' },
                    { name: 'date', type: 'TEXT' },
                    { name: 'cached_at', type: 'DATETIME' }
                ];

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


function createUser(username, password) {
    return new Promise(async (resolve, reject) => {
        try {
            
            const hashedPassword = await bcrypt.hash(password, 10);
            
            db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], function(err) {
                if (err) {
                    
                    reject(err);
                } else {
                    
                    resolve({ id: this.lastID });
                }
            });
        } catch (error) {
            
            reject(error);
        }
    });
}

function getUserByUsername(username) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

module.exports = { db, createUser, getUserByUsername };
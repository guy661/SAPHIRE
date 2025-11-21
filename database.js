const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const DBSOURCE = path.join(__dirname, 'db', 'db.sqlite');


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

                                    db.run(`CREATE TABLE IF NOT EXISTS topics (
                                        user_id INTEGER PRIMARY KEY,
                                        main_topic TEXT,
                                        include_keywords TEXT,
                                        exclude_keywords TEXT,
                                        FOREIGN KEY (user_id) REFERENCES users (id)
                                    )`, (err) => {
                                        if (err) {
                                            console.error('Error creating topics table:', err.message);
                                            return;
                                        }
                                        console.log('Table "topics" is ready.');
                                    });
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

            db.run(`
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    user_id INTEGER,
                    status TEXT DEFAULT 'pending',
                    progress INTEGER DEFAULT 0,
                    FOREIGN KEY (user_id) REFERENCES users (id)
                )
            `, (err) => {
                if (err) {
                    console.error('Error creating jobs table:', err.message);
                } else {
                    console.log('Table "jobs" is ready.');
                }
            });

            db.run(`
                CREATE TABLE IF NOT EXISTS job_articles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT,
                    link TEXT,
                    title TEXT,
                    content TEXT,
                    summary TEXT,
                    status TEXT DEFAULT 'pending',
                    FOREIGN KEY (job_id) REFERENCES jobs (id)
                )
            `, (err) => {
                if (err) {
                    console.error('Error creating job_articles table:', err.message);
                } else {
                    console.log('Table "job_articles" is ready.');
                }
            });
        });
    }
});

function createJob(jobId, userId, status = 'pending') {
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO jobs (id, user_id, status) VALUES (?, ?, ?)`;
        db.run(sql, [jobId, userId, status], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ id: jobId });
            }
        });
    });
}

function addArticlesToJob(jobId, articles) {
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO job_articles (job_id, link, title, content) VALUES (?, ?, ?, ?)`;
        db.parallelize(() => {
            const stmt = db.prepare(sql);
            for (const article of articles) {
                stmt.run(jobId, article.link, article.title, article.content);
            }
            stmt.finalize((err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    });
}

function getJob(jobId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM jobs WHERE id = ?', [jobId], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

function getJobArticles(jobId) {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM job_articles WHERE job_id = ?', [jobId], (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

function getPendingArticles() {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT ja.*, j.user_id 
            FROM job_articles ja 
            JOIN jobs j ON ja.job_id = j.id 
            WHERE ja.status = 'pending' 
            LIMIT 5
        `;
        db.all(sql, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

function getPendingArticlesCountForJob(jobId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT COUNT(*) as count FROM job_articles WHERE job_id = ? AND status = ?', [jobId, 'pending'], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row.count);
            }
        });
    });
}

function updateArticle(articleId, summary, status) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE job_articles SET summary = ?, status = ? WHERE id = ?`;
        db.run(sql, [summary, status, articleId], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ changes: this.changes });
            }
        });
    });
}

function updateArticleStatus(articleId, status) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE job_articles SET status = ? WHERE id = ?`;
        db.run(sql, [status, articleId], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ changes: this.changes });
            }
        });
    });
}

function updateJobStatus(jobId, status) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE jobs SET status = ? WHERE id = ?`;
        db.run(sql, [status, jobId], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ changes: this.changes });
            }
        });
    });
}


function createUser(username, password) {
    return new Promise(async (resolve, reject) => {
        try {
            
            const hashedPassword = await bcrypt.hash(password, 10);
            
            db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], function(err) {
                if (err) {
                    
                    reject(err);
                }
                else {
                    
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

function getTopicByUserId(userId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM topics WHERE user_id = ?', [userId], (err, row) => {
            if (err) {
                reject(err);
            }
            else {
                resolve(row);
            }
        });
    });
}

function upsertTopic(userId, { main_topic, include_keywords, exclude_keywords }) {
    return new Promise((resolve, reject) => {
        const sql = `
            INSERT INTO topics (user_id, main_topic, include_keywords, exclude_keywords)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                main_topic = excluded.main_topic,
                include_keywords = excluded.include_keywords,
                exclude_keywords = excluded.exclude_keywords;
        `;
        db.run(sql, [userId, main_topic, include_keywords, exclude_keywords], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ changes: this.changes });
            }
        });
    });
}

module.exports = { db, createUser, getUserByUsername, getTopicByUserId, upsertTopic, createJob, addArticlesToJob, getJob, getJobArticles, getPendingArticles, getPendingArticlesCountForJob, updateArticle, updateArticleStatus, updateJobStatus };
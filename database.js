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

let db;

function init() {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(DBSOURCE, (err) => {
            if (err) {
                console.error(err.message);
                reject(err);
            } else {
                console.log('Connected to the SQLite database.');
                db.serialize(() => {
                    db.run(`CREATE TABLE IF NOT EXISTS articles (
                        link TEXT PRIMARY KEY,
                        open_count INTEGER DEFAULT 0,
                        title TEXT,
                        summary TEXT,
                        date TEXT,
                        cached_at DATETIME
                    )`, (err) => {
                        if (err) {
                            console.error('Error creating articles table:', err.message);
                            return reject(err);
                        }
                        console.log('Table "articles" is ready.');
                    });
                    db.run(`CREATE TABLE IF NOT EXISTS users (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        username TEXT UNIQUE,
                        password TEXT
                    )`, (err) => {
                        if (err) {
                            console.error('Error creating users table:', err.message);
                            return reject(err);
                        }
                        console.log('Table "users" is ready.');
                    });
                    db.run(`CREATE TABLE IF NOT EXISTS topics (
                        user_id INTEGER PRIMARY KEY,
                        main_topic TEXT,
                        include_keywords TEXT,
                        exclude_keywords TEXT,
                        FOREIGN KEY (user_id) REFERENCES users (id)
                    )`, (err) => {
                        if (err) {
                            console.error('Error creating topics table:', err.message);
                            return reject(err);
                        }
                        console.log('Table "topics" is ready.');
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
                            return reject(err);
                        }
                        console.log('Table "jobs" is ready.');
                    });
                    db.run(`
                        CREATE TABLE IF NOT EXISTS job_articles (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            job_id TEXT,
                            link TEXT,
                            title TEXT,
                            content TEXT,
                            summary TEXT,
                            reason TEXT,
                            status TEXT DEFAULT 'pending',
                            FOREIGN KEY (job_id) REFERENCES jobs (id)
                        )
                    `, (err) => {
                        if (err) {
                            console.error('Error creating job_articles table:', err.message);
                            return reject(err);
                        }
                        console.log('Table "job_articles" is ready.');
                    });
                     // migrations
                     db.run("ALTER TABLE job_articles ADD COLUMN content TEXT", (err) => {
                        if (err) {
                            if (!err.message.includes("duplicate column name")) {
                                console.error('Error adding content column to job_articles:', err.message);
                            }
                        } else {
                            console.log('Column "content" added to "job_articles" or already exists.');
                        }
                    });
                    db.run("ALTER TABLE job_articles ADD COLUMN summary TEXT", (err) => {
                        if (err) {
                            if (!err.message.includes("duplicate column name")) {
                                console.error('Error adding summary column to job_articles:', err.message);
                            }
                        } else {
                            console.log('Column "summary" added to "job_articles" or already exists.');
                        }
                    });
                    db.run("ALTER TABLE job_articles ADD COLUMN reason TEXT", (err) => {
                        if (err) {
                            if (!err.message.includes("duplicate column name")) {
                                console.error('Error adding reason column to job_articles:', err.message);
                            }
                        } else {
                            console.log('Column "reason" added to "job_articles" or already exists.');
                        }
                        resolve();
                    });
                });
            }
        });
    });
}

function createJob(jobId, userId, status = 'pending') {
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO jobs (id, user_id, status) VALUES (?, ?, ?)`;
        db.run(sql, [jobId, userId, status], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ id: this.lastID });
            }
        });
    });
}

function addArticlesToJob(jobId, articles) {
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO job_articles (job_id, link, title, content, summary, reason) VALUES (?, ?, ?, ?, ?, ?)`;
        db.parallelize(() => {
            const stmt = db.prepare(sql);
            for (const article of articles) {
                stmt.run(jobId, article.link, article.title, article.content, article.summary, article.reason);
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

function clearDatabase() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('DELETE FROM job_articles', (err) => {
                if (err) return reject(err);
            });
            db.run('DELETE FROM jobs', (err) => {
                if (err) return reject(err);
            });
            db.run('DELETE FROM topics', (err) => {
                if (err) return reject(err);
            });
            db.run('DELETE FROM users', (err) => {
                if (err) return reject(err);
            });
            db.run('DELETE FROM articles', (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    });
}

module.exports = {
    init,
    createJob,
    addArticlesToJob,
    getJob,
    getJobArticles,
    getPendingArticles,
    getPendingArticlesCountForJob,
    updateArticle,
    updateArticleStatus,
    updateJobStatus,
    createUser,
    getUserByUsername,
    getTopicByUserId,
    upsertTopic,
    clearDatabase,
};

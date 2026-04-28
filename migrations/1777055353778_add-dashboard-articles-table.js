/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = pgm => {
    pgm.sql(`
        CREATE TABLE dashboard_articles (
            id SERIAL PRIMARY KEY,
            dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
            title TEXT,
            link TEXT NOT NULL,
            source_name TEXT,
            pub_date TIMESTAMP WITH TIME ZONE,
            relevance_score FLOAT,
            micro_summary TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(dashboard_id, link)
        );
        CREATE INDEX idx_dashboard_articles_dashboard_id ON dashboard_articles(dashboard_id);
        CREATE INDEX idx_dashboard_articles_created_at ON dashboard_articles(created_at);
    `);
};

exports.down = pgm => {
    pgm.sql(`
        DROP TABLE dashboard_articles;
    `);
};

/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = pgm => {
    pgm.sql(`
        -- 1. Create the new clusters table to group similar articles.
        CREATE TABLE clusters (
            id SERIAL PRIMARY KEY,
            representative_title TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- 2. Add columns to the articles table.
        -- cluster_id links an article to a cluster.
        -- source_name stores the name of the feed it came from (e.g., 'Spiegel Online').
        ALTER TABLE articles
            ADD COLUMN cluster_id INTEGER REFERENCES clusters(id) ON DELETE SET NULL,
            ADD COLUMN source_name TEXT;
    `);
};

exports.down = pgm => {
    pgm.sql(`
        -- Remove the added columns and table in reverse order of creation.
        ALTER TABLE articles
            DROP COLUMN cluster_id,
            DROP COLUMN source_name;

        DROP TABLE clusters;
    `);
};
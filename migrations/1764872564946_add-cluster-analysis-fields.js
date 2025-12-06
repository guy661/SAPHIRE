/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = pgm => {
    pgm.addColumns('clusters', {
        // A specific summary for the articles within this cluster
        summary: {
            type: 'TEXT'
        },
        // The overall sentiment of the cluster (e.g., 'Positive', 'Negative', 'Neutral')
        sentiment: {
            type: 'TEXT'
        },
        // The primary topic or focus of the cluster (e.g., 'Politics', 'Business', 'Technology')
        focus: {
            type: 'TEXT'
        },
        // The perceived political bias of the reporting (e.g., 'Left-leaning', 'Right-leaning', 'Neutral')
        bias: {
            type: 'TEXT'
        }
    });
};

exports.down = pgm => {
    pgm.dropColumns('clusters', ['summary', 'sentiment', 'focus', 'bias']);
};
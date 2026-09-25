'use strict';

// Netlify serverless entry point — wraps the whole Express app.
const serverless = require('serverless-http');
const app = require('../../server');

module.exports.handler = serverless(app);

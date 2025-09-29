// src/middleware/raw-body.js
const express = require('express');
const raw = express.raw({ type: 'application/json' });

module.exports = function stripeRawBody(req, res, next) {
    console.log('stripeRawBody middleware called');
    return raw(req, res, function (err) {
        if (err) {
            console.error('Error in express.raw middleware:', err);
            return next(err);
        }
        // express.raw() puts the Buffer in req.body; copy it where the webhook expects it
        req.rawBody = req.body;
        console.log('Raw body set on req.rawBody:', req.rawBody);
        next();
    });
};

/**
 * Raw Body Middleware - Capture raw body for Stripe webhook signature verification
 */
const express = require('express');

const RAW_BODY_CONFIG = {
    type: 'application/json',
    limit: '1mb',
    verify: (req, res, buf, encoding) => {
        if (buf && buf.length) {
            req.rawBody = buf;
        }
    }
};

function validateRawBody(buffer, endpoint) {
    if (!buffer) {
        console.error(`[raw-body] ${endpoint}: No body buffer`);
        return false;
    }

    if (!Buffer.isBuffer(buffer)) {
        console.error(`[raw-body] ${endpoint}: Body is not a Buffer`);
        return false;
    }

    if (buffer.length === 0) {
        console.error(`[raw-body] ${endpoint}: Empty buffer`);
        return false;
    }

    const maxSize = 1024 * 1024; // 1MB
    if (buffer.length > maxSize) {
        console.error(`[raw-body] ${endpoint}: Buffer too large (${buffer.length} bytes)`);
        return false;
    }

    return true;
}

/**
 * Middleware to capture raw body for Stripe webhook signature verification
 */
function stripeRawBody(req, res, next) {
    const endpoint = req.originalUrl || req.url || 'unknown';

    const raw = express.raw(RAW_BODY_CONFIG);

    try {
        return raw(req, res, function (err) {
            if (err) {
                console.error(`[raw-body] ${endpoint}: Error:`, err.message);

                return res.status(err.status || 400).json({
                    error: 'Invalid request body',
                    message: err.message || 'Failed to parse request body'
                });
            }

            if (!validateRawBody(req.rawBody, endpoint)) {
                return res.status(400).json({
                    error: 'Invalid request body',
                    message: 'Request body is missing, empty, or invalid'
                });
            }

            if (!req.body) {
                req.body = req.rawBody;
            }

            next();
        });

    } catch (error) {
        console.error(`[raw-body] ${endpoint}: Unexpected error:`, error.message);
        return res.status(500).json({
            error: 'Internal server error',
            message: 'Failed to process request body'
        });
    }
}

module.exports = stripeRawBody;

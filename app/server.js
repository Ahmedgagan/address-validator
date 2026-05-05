require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');

const app = express();
app.use(express.json());
app.use(cors());

/* =========================
   REDIS
========================= */
const redis = new Redis(process.env.REDIS_URL);

/* =========================
   MYSQL
========================= */
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 25
});

/* =========================
   AUTHORIZE
========================= */
const authorize = async (req, res, next) => {
    const license_key = req.body.license_key || req.query.license_key;
    const domain = req.body.domain || req.query.domain;

    if (!license_key || !domain) {
        return res.status(400).json({ error: 'Missing license or domain' });
    }

    const [rows] = await pool.execute(
        'SELECT id, monthly_limit FROM users WHERE license_key = ? AND origin_domain = ? AND status = "active"',
        [license_key, domain]
    );

    if (!rows.length) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    req.userId = rows[0].id;
    req.monthlyLimit = rows[0].monthly_limit;

    next();
};

/* =========================
   SESSION CHECK
========================= */
const checkSession = async (req, res, next) => {
    const token = req.query.session_token || req.body.session_token;

    if (!token) {
        return res.status(400).json({ error: 'Missing session token' });
    }

    const raw = await redis.get(`session:${token}`);
    if (!raw) {
        return res.status(403).json({ error: 'Invalid/expired session' });
    }

    const session = JSON.parse(raw);

    if (Date.now() > session.expiresAt) {
        return res.status(403).json({ error: 'Session expired' });
    }

    req.session = session;
    req.sessionToken = token;

    next();
};

/* =========================
   USAGE TRACKING
========================= */
const getMonthKey = () => new Date().toISOString().slice(0, 7);

const incrementUsage = async (licenseId, type) => {
    const month = getMonthKey();

    const field =
        type === 'autocomplete'
            ? 'autocomplete_count'
            : 'validate_count';

    await pool.execute(
        `
        INSERT INTO usage_counters (license_id, month_key, ${field})
        VALUES (?, ?, 1)
        ON DUPLICATE KEY UPDATE ${field} = ${field} + 1
        `,
        [licenseId, month]
    );
};

const getUsage = async (licenseId) => {
    const month = getMonthKey();

    const [rows] = await pool.execute(
        `
        SELECT autocomplete_count, validate_count
        FROM usage_counters
        WHERE license_id = ? AND month_key = ?
        `,
        [licenseId, month]
    );

    return rows[0] || { autocomplete_count: 0, validate_count: 0 };
};

/* =========================
   START SESSION
========================= */
app.get('/v1/start-session', authorize, async (req, res) => {
    const token = uuidv4();
    const now = Date.now();

    const session = {
        userId: req.userId,
        createdAt: now,
        expiresAt: now + 15 * 60 * 1000,
        autocompleteCount: 0,
        validateCount: 0
    };

    await redis.set(
        `session:${token}`,
        JSON.stringify(session),
        'EX',
        900
    );

    res.json({ session_token: token });
});

/* =========================
   AUTOCOMPLETE
========================= */
app.get('/v1/autocomplete', authorize, checkSession, async (req, res) => {
    try {
        let { input, session_token } = req.query;

        if (!input || input.trim().length < 3) {
            return res.json([]);
        }

        const normalized = input.trim().toLowerCase();

        // SESSION LIMIT
        if (req.session.autocompleteCount >= 20) {
            return res.status(429).json({ error: 'Session limit reached' });
        }

        // MONTHLY LIMIT
        const usage = await getUsage(req.userId);
        if (usage.autocomplete_count >= req.monthlyLimit) {
            return res.status(429).json({ error: 'Monthly limit exceeded' });
        }

        // CACHE
        const cacheKey = `ac:${normalized}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        // GOOGLE CALL
        const response = await axios.post(
            'https://places.googleapis.com/v1/places:autocomplete',
            {
                input: normalized,
                sessionToken: session_token,
                includedRegionCodes: ['in']
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY
                }
            }
        );

        const suggestions = response.data.suggestions || [];

        // UPDATE SESSION
        req.session.autocompleteCount++;
        await redis.set(
            `session:${req.sessionToken}`,
            JSON.stringify(req.session),
            'KEEPTTL'
        );

        // UPDATE USAGE
        await incrementUsage(req.userId, 'autocomplete');

        // CACHE STORE
        await redis.set(cacheKey, JSON.stringify(suggestions), 'EX', 300);

        res.json(suggestions);

    } catch (err) {
        res.status(500).json({ error: 'Autocomplete failed' });
    }
});

/* =========================
   VALIDATE
========================= */
app.post('/v1/validate', authorize, checkSession, async (req, res) => {
    try {
        const { place_id, session_token } = req.body;

        if (!place_id) {
            return res.status(400).json({ error: 'place_id required' });
        }

        if (req.session.validateCount >= 2) {
            return res.status(429).json({ error: 'Session validate limit' });
        }

        const usage = await getUsage(req.userId);
        if (usage.validate_count >= req.monthlyLimit) {
            return res.status(429).json({ error: 'Monthly limit exceeded' });
        }

        const response = await axios.get(
            `https://places.googleapis.com/v1/places/${place_id}`,
            {
                headers: {
                    'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
                    'X-Goog-FieldMask':
                        'addressComponents,formattedAddress'
                },
                params: { sessionToken: session_token }
            }
        );

        const components = response.data.addressComponents || [];
        const getComp = (t) =>
            components.find(c => c.types.includes(t))?.longText || '';

        const street = getComp('street_number');
        const building =
            getComp('premise') || getComp('point_of_interest');
        const route = getComp('route');

        const address_1 =
            `${building} ${street} ${route}`.trim() ||
            response.data.formattedAddress?.split(',')[0];

        // UPDATE SESSION
        req.session.validateCount++;
        await redis.set(
            `session:${req.sessionToken}`,
            JSON.stringify(req.session),
            'KEEPTTL'
        );

        // UPDATE USAGE
        await incrementUsage(req.userId, 'validate');

        res.json({
            address_1,
            city: getComp('locality'),
            state: getComp('administrative_area_level_1'),
            postcode: getComp('postal_code') || '',
            country: 'IN'
        });

    } catch (err) {
        res.status(500).json({ error: 'Validation failed' });
    }
});

/* ========================= */
app.listen(process.env.PORT || 3000);
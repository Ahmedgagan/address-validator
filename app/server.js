require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(cors()); // Required for WooCommerce frontend to communicate with your API

// Database Connection Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true
});

// Middleware: Verify License, Domain, and Usage Limits
const authorize = async (req, res, next) => {
    // In GET requests (autocomplete), params come from query. In POST, from body.
    const license_key = req.body.license_key || req.query.license_key;
    const domain = req.body.domain || req.query.domain;
    
    if (!license_key || !domain) {
        return res.status(400).json({ error: 'Missing license or domain' });
    }

    try {
        const [rows] = await pool.execute(
            'SELECT id FROM users WHERE license_key = ? AND origin_domain = ? AND status = "active"',
            [license_key, domain]
        );

        if (rows.length === 0) {
            return res.status(403).json({ error: 'Unauthorized license' });
        }

        // Optional: Add a check here to see if usage_logs count for this user > 1000
        req.userId = rows[0].id;
        next();
    } catch (err) {
        res.status(500).json({ error: 'Auth error' });
    }
};

/**
 * FEATURE 1: START SESSION
 * Generates a UUID for Google Session-based billing.
 * Frontend should call this when the checkout page loads.
 */
app.get('/v1/start-session', authorize, (req, res) => {
    res.json({ session_token: uuidv4() });
});

/**
 * FEATURE 2: AUTOCOMPLETE SUGGESTIONS
 * Provides the "Type-ahead" list as the user types.
 */
app.get('/v1/autocomplete', authorize, async (req, res) => {
    const { input, session_token } = req.query;

    try {
        const googleUrl = `https://googleapis.com`;
        const response = await axios.get(googleUrl, {
            params: {
                input,
                sessiontoken: session_token,
                key: process.env.GOOGLE_PLACES_API_KEY,
                components: 'country:in', // Restricted to India
                types: 'address'
            }
        });

        res.json(response.data.predictions);
    } catch (error) {
        res.status(500).json({ error: 'Autocomplete failed' });
    }
});

/**
 * FEATURE 3: VALIDATE & AUTOFILL
 * Gets full address details to fill WooCommerce fields and verify ZIP.
 */
app.post('/v1/validate', authorize, async (req, res) => {
    const { type, zip, place_id, session_token } = req.body;

    try {
        let result = {};

        // Zip only logic (remains as fallback)
        if (type === 'zip_only') {
            const response = await axios.get(`https://zippopotam.us{zip}`); // Changed to 'in' for India
            const data = response.data.places[0];
            result = {
                city: data['place name'],
                state: data['state'],
                country: 'IN'
            };
        }

        // Full Autocomplete Verify & Autofill Data
        if (type === 'full_verify' && place_id) {
            const googleUrl = `https://maps.googleapis.com/maps/api/place/details/json`;
            const response = await axios.get(googleUrl, {
                params: {
                    place_id,
                    sessiontoken: session_token, // Closes the session for billing
                    fields: 'address_components',
                    key: process.env.GOOGLE_PLACES_API_KEY
                }
            });

            const components = response.data.result.address_components;
            
            const getComp = (t) => components.find(c => c.types.includes(t))?.long_name || '';
            const googleZip = components.find(c => c.types.includes('postal_code'))?.short_name || '';

            result = {
                mismatch: zip ? (googleZip !== zip) : false,
                confirmed_zip: googleZip,
                autofill: {
                    address_1: `${getComp('house_number')} ${getComp('street_number')} ${getComp('route')}`.trim(),
                    city: getComp('locality') || getComp('postal_town'),
                    state: getComp('administrative_area_level_1'),
                    country: 'IN'
                }
            };
        }

        // Log Usage for your $5/month billing limit
        await pool.execute(
            'INSERT INTO usage_logs (license_id, request_type) VALUES (?, ?)',
            [req.userId, type]
        );

        res.json(result);

    } catch (error) {
        res.status(500).json({ error: 'Validation failed', details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SaaS Validator running on port ${PORT}`));
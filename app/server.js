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
        // 1. New Google Endpoint
        const googleUrl = `https://places.googleapis.com/v1/places:autocomplete`;

        // 2. Prepare the request body for the New API
        const requestBody = {
            input: input,
            sessionToken: session_token,
            includedRegionCodes: ['in'], // Restricted to India
            // Optional: You can add locationBias here if you want to prioritize a specific city like Dubai or Mumbai
        };

        // 3. Make the POST request to Google
        const response = await axios.post(googleUrl, requestBody, {
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY
            }
        });

        // The New API returns "suggestions" instead of "predictions"
        res.json(response.data.suggestions || []);

    } catch (error) {
        // Logs the exact reason for failure in your terminal
        const errorData = error.response ? error.response.data : error.message;
        console.error('Google Places New API Error:', errorData);

        res.status(500).json({
            error: 'Autocomplete failed',
            details: errorData
        });
    }
});

/**
 * FEATURE 3: VALIDATE & AUTOFILL
 * Gets full address details to fill WooCommerce fields and verify ZIP.
 */
app.post('/v1/validate', authorize, async (req, res) => {
    const { place_id, session_token } = req.body;

    if (!place_id) return res.status(400).json({ error: 'place_id is required' });

    try {
        // The V1 New API URL
        const googleUrl = `https://places.googleapis.com/v1/places/${place_id}`;

        const response = await axios.get(googleUrl, {
            headers: {
                'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
                // Using the most standard FieldMask
                'X-Goog-FieldMask': 'addressComponents,formattedAddress'
            },
            params: {
                // Google New API expects camelCase sessionToken in params
                'sessionToken': session_token 
            }
        });

        const components = response.data.addressComponents || [];
        const getComp = (type) => components.find(c => c.types.includes(type))?.longText || '';

        // Standardized mapping
        res.json({
            address_1: getComp('street_number') ? `${getComp('street_number')} ${getComp('route')}`.trim() : getComp('sublocality_level_1') || getComp('route'),
            city: getComp('locality'),
            state: getComp('administrative_area_level_1'),
            postcode: getComp('postal_code'),
            country: 'IN'
        });

    } catch (error) {
        // This will now print the FULL error detail from Google so we can see which argument is "invalid"
        console.error('Google API Error Response:', JSON.stringify(error.response?.data, null, 2));
        
        res.status(500).json({ 
            error: 'Failed to fetch address details',
            debug: error.response?.data?.error?.message || error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SaaS Validator running on port ${PORT}`));
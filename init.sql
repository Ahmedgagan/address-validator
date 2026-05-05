CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    license_key VARCHAR(100) UNIQUE NOT NULL,
    origin_domain VARCHAR(255) NOT NULL,
    status ENUM('active', 'suspended') DEFAULT 'active',
    plan VARCHAR(50) DEFAULT 'basic',
    monthly_limit INT DEFAULT 1000,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_license (license_key)
);

CREATE TABLE IF NOT EXISTS usage_counters (
    id INT AUTO_INCREMENT PRIMARY KEY,
    license_id INT NOT NULL,
    month_key VARCHAR(7) NOT NULL,
    autocomplete_count INT DEFAULT 0,
    validate_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY unique_usage (license_id, month_key),
    FOREIGN KEY (license_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Optional lightweight logs (debug only)
CREATE TABLE IF NOT EXISTS usage_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    license_id INT,
    request_type VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_license_time (license_id, created_at)
);

-- Seed test user
INSERT INTO users (license_key, origin_domain, monthly_limit)
VALUES ('test-key-123', 'yourdomain.com', 1000);

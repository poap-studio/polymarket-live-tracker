const url = require('url');

// Import the main handler
const mainHandler = require('./[...path]');

// Export function for /api/stats endpoint
module.exports = async (req, res) => {
    // Modify the URL to match the main handler expectations
    const originalUrl = req.url;
    req.url = '/stats' + (originalUrl.includes('?') ? originalUrl.substring(originalUrl.indexOf('?')) : '');
    
    // Call the main handler
    return await mainHandler(req, res);
};
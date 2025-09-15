const rateLimit = require('express-rate-limit');

const createRateLimiter = (windowMs, max, message) => {
    return rateLimit({
        windowMs: windowMs,
        max: max,
        message: {
            success: false,
            error: message || 'Слишком много запросов, попробуйте позже'
        },
        standardHeaders: true,
        legacyHeaders: false
    });
};

// Лимиты для разных эндпоинтов
const authLimiter = createRateLimiter(15 * 60 * 1000, 5, 'Слишком много попыток входа');
const apiLimiter = createRateLimiter(15 * 60 * 1000, 100, 'Слишком много запросов к API');
const uploadLimiter = createRateLimiter(60 * 60 * 1000, 10, 'Слишком много загрузок файлов');

module.exports = {
    authLimiter,
    apiLimiter,
    uploadLimiter
};

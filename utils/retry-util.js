/**
 * 通用重试工具
 * 提供指数型回退重试机制和智能HTTP错误判断
 */


/**
 * 指数型回退重试机制
 * @param {Function} fn 要执行的异步函数，接收当前尝试次数作为参数
 * @param {Object} options 配置选项
 * @param {number} options.maxRetries 最大重试次数，默认3次
 * @param {number} options.initialDelay 初始延迟时间（毫秒），默认1000ms
 * @param {number} options.maxDelay 最大延迟时间（毫秒），默认10000ms
 * @param {number} options.factor 延迟增长因子，默认2（每次翻倍）
 * @param {Function} options.shouldRetry 判断是否应该重试的函数，默认所有错误都重试
 * @param {Function} options.onRetry 重试时的回调函数
 * @returns {Promise} 返回函数执行结果
 * 
 * @example
 * const result = await exponentialBackoff(
 *   async (attempt) => await axios.get(url),
 *   {
 *     maxRetries: 3,
 *     initialDelay: 1000,
 *     shouldRetry: (error) => error.response?.status >= 500,
 *     onRetry: (attempt, maxRetries, delay, error) => {
 *       console.log(`重试 ${attempt}/${maxRetries}，延迟 ${delay}ms`);
 *     }
 *   }
 * );
 */
export async function exponentialBackoff(fn, options = {}) {
    const {
        maxRetries = 3,
        initialDelay = 1000,
        maxDelay = 10000,
        factor = 2,
        shouldRetry = () => true,
        onRetry = null,
    } = options;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // 执行函数，传入当前尝试次数
            return await fn(attempt);
        } catch (error) {
            lastError = error;

            // 如果已达到最大重试次数或不应该重试，则抛出错误
            if (attempt >= maxRetries || !shouldRetry(error)) {
                throw error;
            }

            // 计算延迟时间：initialDelay * (factor ^ attempt)
            const baseDelay = initialDelay * Math.pow(factor, attempt);
            const cappedDelay = Math.min(baseDelay, maxDelay);

            // 添加随机抖动（jitter），避免雷鸣群效应
            // 抖动范围为 ±30% 的延迟时间
            const jitter = (Math.random() - 0.5) * 0.6 * cappedDelay;
            const finalDelay = Math.max(0, cappedDelay + jitter);

            // 调用重试回调
            if (onRetry) {
                onRetry(attempt + 1, maxRetries, finalDelay, error);
            }

            // 等待后重试
            await new Promise(resolve => setTimeout(resolve, finalDelay));
        }
    }

    // 如果所有重试都失败，抛出最后一个错误
    throw lastError;
}

/**
 * 判断HTTP错误是否值得重试
 * @param {Error} error Axios错误对象
 * @returns {boolean} 如果应该重试返回true，否则返回false
 * 
 * 重试策略：
 * - 4xx客户端错误（除408超时）：不重试
 * - 404 Not Found：不重试
 * - 400 Bad Request：不重试
 * - 401/403 认证/权限错误：不重试
 * - 408 Request Timeout：重试
 * - 429 Too Many Requests：重试（限流）
 * - 5xx服务器错误：重试
 * - 网络错误（ECONNRESET, ETIMEDOUT等）：重试
 */
export function shouldRetryHttpError(error) {
    // 如果没有响应对象，可能是网络错误，应该重试
    if (!error.response) {
        // 常见的网络错误码
        const networkErrors = [
            'ECONNRESET',    // 连接被重置
            'ETIMEDOUT',     // 连接超时
            'ECONNABORTED',  // 连接被中止
            'ENOTFOUND',     // DNS查找失败
            'ENETUNREACH',   // 网络不可达
            'EAI_AGAIN',     // DNS临时失败
        ];

        if (error.code && networkErrors.includes(error.code)) {
            logger.debug(`[重试工具] 网络错误 ${error.code}，将重试`);
            return true;
        }

        // 其他无响应的错误也重试
        return true;
    }

    const status = error.response.status;

    // 408 Request Timeout - 应该重试
    if (status === 408) {
        logger.debug(`[重试工具] 408超时错误，将重试`);
        return true;
    }

    // 429 Too Many Requests - 应该重试（限流）
    if (status === 429) {
        logger.debug(`[重试工具] 429限流错误，将重试`);
        return true;
    }

    // 4xx客户端错误 - 不应该重试
    if (status >= 400 && status < 500) {
        logger.debug(`[重试工具] ${status}客户端错误，不重试`);
        return false;
    }

    // 5xx服务器错误 - 应该重试
    if (status >= 500) {
        logger.debug(`[重试工具] ${status}服务器错误，将重试`);
        return true;
    }

    // 其他情况默认重试
    return true;
}

/**
 * 带重试的Axios请求包装器
 * @param {Function} axiosRequest Axios请求函数
 * @param {Object} retryOptions 重试选项
 * @returns {Promise} 返回Axios响应
 * 
 * @example
 * const response = await retryAxiosRequest(
 *   () => axios.get('https://api.example.com/data'),
 *   { maxRetries: 3, initialDelay: 1000 }
 * );
 */
export async function retryAxiosRequest(axiosRequest, retryOptions = {}) {
    return exponentialBackoff(
        async (attempt) => {
            return await axiosRequest();
        },
        {
            maxRetries: 3,
            initialDelay: 1000,
            shouldRetry: shouldRetryHttpError,
            ...retryOptions,
        }
    );
}

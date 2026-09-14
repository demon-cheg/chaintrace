(function (window, $) {
    "use strict";

    const config = window.ChainTraceConfig;

    if (!$) {
        console.error(
            "ChainTrace API could not start: jQuery is unavailable."
        );

        return;
    }

    if (!config) {
        console.error(
            "ChainTrace API could not start: configuration is unavailable."
        );

        return;
    }

    const activeRequests = new Set();

    class ChainTraceApiError extends Error {
        constructor(message, code, details) {
            super(message);

            this.name = "ChainTraceApiError";
            this.code = code;
            this.details = details || {};
        }
    }

    function wait(milliseconds) {
        return new Promise((resolve) => {
            window.setTimeout(resolve, milliseconds);
        });
    }

    function normalizeAddress(address) {
        return String(address || "").trim();
    }

    function validateAddress(address) {
        return config.NETWORK.addressPattern.test(
            normalizeAddress(address)
        );
    }

    function extractAddress(entity) {
        if (!entity) {
            return null;
        }

        if (typeof entity === "string") {
            return entity;
        }

        return (
            entity.hash ||
            entity.address ||
            entity.address_hash ||
            null
        );
    }

    function normalizeIntegerString(value) {
        let candidate = value;

        if (
            candidate &&
            typeof candidate === "object" &&
            "value" in candidate
        ) {
            candidate = candidate.value;
        }

        if (
            candidate === null ||
            candidate === undefined ||
            candidate === ""
        ) {
            return "0";
        }

        const text = String(candidate).trim();

        if (/^\d+$/.test(text)) {
            return text;
        }

        return "0";
    }

    function normalizeTimestamp(value) {
        if (!value) {
            return null;
        }

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return null;
        }

        return date.toISOString();
    }

    function normalizeStatus(rawStatus) {
        const status = String(rawStatus || "")
            .toLowerCase()
            .trim();

        if (
            status === "ok" ||
            status === "success" ||
            status === "1"
        ) {
            return "success";
        }

        if (
            status === "error" ||
            status === "failed" ||
            status === "0"
        ) {
            return "failed";
        }

        return status || "pending";
    }

    function deriveMethod(transaction) {
        if (transaction.method) {
            return String(transaction.method);
        }

        if (transaction.decoded_input?.method_call) {
            return String(
                transaction.decoded_input.method_call
            );
        }

        const input =
            transaction.raw_input ||
            transaction.input ||
            "0x";

        if (input && input !== "0x") {
            return "Contract call";
        }

        return "Transfer";
    }

    function createRequestError(
        xhr,
        textStatus,
        errorThrown,
        url
    ) {
        const status = Number(xhr?.status || 0);

        const serverMessage =
            xhr?.responseJSON?.message ||
            xhr?.responseJSON?.error ||
            null;

        const details = {
            status,
            textStatus,
            errorThrown: String(errorThrown || ""),
            serverMessage,
            url
        };

        if (textStatus === "abort") {
            return new ChainTraceApiError(
                "The request was cancelled.",
                "REQUEST_CANCELLED",
                details
            );
        }

        if (textStatus === "timeout") {
            return new ChainTraceApiError(
                "The blockchain explorer took too long to respond.",
                "REQUEST_TIMEOUT",
                details
            );
        }

        if (status === 400 || status === 422) {
            return new ChainTraceApiError(
                serverMessage || "The wallet address is invalid.",
                "INVALID_REQUEST",
                details
            );
        }

        if (status === 403) {
            return new ChainTraceApiError(
                "The blockchain explorer rejected the browser request.",
                "REQUEST_FORBIDDEN",
                details
            );
        }

        if (status === 404) {
            return new ChainTraceApiError(
                "The requested blockchain data was not found.",
                "NOT_FOUND",
                details
            );
        }

        if (status === 429) {
            return new ChainTraceApiError(
                "The public API rate limit has been reached.",
                "RATE_LIMITED",
                details
            );
        }

        if (status >= 500) {
            return new ChainTraceApiError(
                "The blockchain explorer is temporarily unavailable.",
                "API_UNAVAILABLE",
                details
            );
        }

        if (status === 0) {
            return new ChainTraceApiError(
                "The blockchain explorer could not be reached. This may be a CORS or network error.",
                "NETWORK_ERROR",
                details
            );
        }

        return new ChainTraceApiError(
            serverMessage || "Unable to retrieve blockchain data.",
            "UNKNOWN_API_ERROR",
            details
        );
    }

    function shouldRetry(error, attempt) {
        if (attempt >= config.API.retryCount) {
            return false;
        }

        return [
            "REQUEST_TIMEOUT",
            "RATE_LIMITED",
            "API_UNAVAILABLE",
            "NETWORK_ERROR"
        ].includes(error.code);
    }

    function request(path, query, attempt) {
        const requestAttempt = attempt || 0;
        const url = `${config.NETWORK.apiBaseUrl}${path}`;

        return new Promise((resolve, reject) => {
            const xhr = $.ajax({
                url,
                method: "GET",
                data: query || {},
                dataType: "json",
                timeout: config.API.timeoutMilliseconds,
                cache: true
            });

            activeRequests.add(xhr);

            xhr.done((response) => {
                resolve(response);
            });

            xhr.fail(async (
                failedXhr,
                textStatus,
                errorThrown
            ) => {
                const error = createRequestError(
                    failedXhr,
                    textStatus,
                    errorThrown,
                    url
                );

                if (shouldRetry(error, requestAttempt)) {
                    const retryDelay =
                        config.API.retryDelayMilliseconds *
                        (requestAttempt + 1);

                    await wait(retryDelay);

                    request(
                        path,
                        query,
                        requestAttempt + 1
                    ).then(resolve, reject);

                    return;
                }

                reject(error);
            });

            xhr.always(() => {
                activeRequests.delete(xhr);
            });
        });
    }

    async function getAddressInformation(address) {
        try {
            return await request(
                `/addresses/${encodeURIComponent(address)}`
            );
        } catch (error) {
            if (error.code === "NOT_FOUND") {
                return {
                    hash: address,
                    coin_balance: "0",
                    is_contract: false,
                    name: null
                };
            }

            throw error;
        }
    }

    async function getTransactions(address) {
        const collectedTransactions = [];
        let nextPageParameters = null;

        for (
            let page = 0;
            page < config.API.maximumPages;
            page += 1
        ) {
            let response;

            try {
                response = await request(
                    `/addresses/${encodeURIComponent(address)}/transactions`,
                    nextPageParameters || {}
                );
            } catch (error) {
                if (
                    error.code === "NOT_FOUND" &&
                    page === 0
                ) {
                    return [];
                }

                throw error;
            }

            if (
                !response ||
                !Array.isArray(response.items)
            ) {
                throw new ChainTraceApiError(
                    "The explorer returned an unexpected response.",
                    "INVALID_RESPONSE",
                    {
                        page,
                        response
                    }
                );
            }

            collectedTransactions.push(
                ...response.items
            );

            nextPageParameters =
                response.next_page_params || null;

            if (
                !nextPageParameters ||
                collectedTransactions.length >=
                    config.API.transactionLimit
            ) {
                break;
            }
        }

        const uniqueTransactions = new Map();

        for (const transaction of collectedTransactions) {
            const key =
                transaction.hash ||
                `${transaction.block}-${transaction.position}`;

            if (!uniqueTransactions.has(key)) {
                uniqueTransactions.set(
                    key,
                    transaction
                );
            }
        }

        return Array
            .from(uniqueTransactions.values())
            .slice(0, config.API.transactionLimit);
    }

    function normalizeTransaction(transaction, walletAddress) {
        const normalizedWalletAddress =
            walletAddress.toLowerCase();

        const fromAddress =
            extractAddress(transaction.from);

        const directToAddress =
            extractAddress(transaction.to);

        const createdContractAddress =
            extractAddress(transaction.created_contract);

        const toAddress =
            directToAddress ||
            createdContractAddress;

        const normalizedFrom =
            fromAddress?.toLowerCase() || null;

        const normalizedTo =
            toAddress?.toLowerCase() || null;

        let direction = "unknown";

        if (
            normalizedFrom === normalizedWalletAddress &&
            normalizedTo === normalizedWalletAddress
        ) {
            direction = "self";
        } else if (
            normalizedFrom === normalizedWalletAddress
        ) {
            direction = "out";
        } else if (
            normalizedTo === normalizedWalletAddress
        ) {
            direction = "in";
        }

        const counterparty =
            direction === "out"
                ? toAddress
                : direction === "in"
                    ? fromAddress
                    : toAddress || fromAddress;

        const rawInput =
            transaction.raw_input ||
            transaction.input ||
            "0x";

        const isContractInteraction = Boolean(
            transaction.to?.is_contract ||
            transaction.created_contract ||
            transaction.method ||
            (
                rawInput &&
                rawInput !== "0x"
            )
        );

        const feeValue =
            transaction.fee?.value ??
            transaction.transaction_fee ??
            "0";

        return {
            hash: transaction.hash || null,

            from: fromAddress,
            to: toAddress,
            counterparty,

            direction,
            classification:
                isContractInteraction
                    ? "contract"
                    : "transfer",

            isContractInteraction,

            valueWei: normalizeIntegerString(
                transaction.value
            ),

            feeWei: normalizeIntegerString(
                feeValue
            ),

            gasUsed: normalizeIntegerString(
                transaction.gas_used
            ),

            gasPriceWei: normalizeIntegerString(
                transaction.gas_price
            ),

            method: deriveMethod(transaction),
            status: normalizeStatus(transaction.status),

            timestamp: normalizeTimestamp(
                transaction.timestamp
            ),

            blockNumber:
                transaction.block ??
                transaction.block_number ??
                null,

            confirmations:
                Number(transaction.confirmations || 0),

            position:
                transaction.position ?? null,

            revertReason:
                transaction.revert_reason || null,

            tokenTransferCount:
                Array.isArray(transaction.token_transfers)
                    ? transaction.token_transfers.length
                    : 0
        };
    }

    async function getWalletAnalysis(address) {
        const normalizedAddress =
            normalizeAddress(address);

        if (!validateAddress(normalizedAddress)) {
            throw new ChainTraceApiError(
                "Enter a valid 42-character Ethereum address.",
                "INVALID_ADDRESS",
                {
                    address: normalizedAddress
                }
            );
        }

        const [
            addressInformation,
            rawTransactions
        ] = await Promise.all([
            getAddressInformation(normalizedAddress),
            getTransactions(normalizedAddress)
        ]);

        const transactions = rawTransactions.map(
            (transaction) => normalizeTransaction(
                transaction,
                normalizedAddress
            )
        );

        return {
            network: {
                id: config.NETWORK.id,
                name: config.NETWORK.name,
                nativeSymbol:
                    config.NETWORK.nativeSymbol
            },

            address:
                addressInformation.hash ||
                normalizedAddress,

            name:
                addressInformation.name ||
                addressInformation.ens_domain_name ||
                null,

            balanceWei: normalizeIntegerString(
                addressInformation.coin_balance ??
                addressInformation.balance
            ),

            isContract: Boolean(
                addressInformation.is_contract
            ),

            transactions,

            transactionLimit:
                config.API.transactionLimit,

            fetchedAt: new Date().toISOString(),

            source: {
                id: "blockscout",
                name: "Blockscout",
                apiUrl:
                    config.NETWORK.apiBaseUrl,
                explorerUrl:
                    config.NETWORK.explorerBaseUrl
            }
        };
    }

    function cancelAllRequests() {
        for (const xhr of activeRequests) {
            xhr.abort();
        }

        activeRequests.clear();
    }

    function getWalletExplorerUrl(address) {
        return (
            `${config.NETWORK.explorerBaseUrl}` +
            `/address/${encodeURIComponent(address)}`
        );
    }

    function getTransactionExplorerUrl(hash) {
        return (
            `${config.NETWORK.explorerBaseUrl}` +
            `/tx/${encodeURIComponent(hash)}`
        );
    }

    window.ChainTraceApi = Object.freeze({
        Error: ChainTraceApiError,

        normalizeAddress,
        validateAddress,

        getWalletAnalysis,
        cancelAllRequests,

        getWalletExplorerUrl,
        getTransactionExplorerUrl
    });
})(window, window.jQuery);
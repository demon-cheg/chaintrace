(function (window) {
    "use strict";

    const config = {
        APP: {
            name: "ChainTrace",
            version: "1.0.0"
        },

        NETWORK: {
            id: "ethereum",
            name: "Ethereum Mainnet",
            shortName: "Ethereum",
            nativeSymbol: "ETH",

            explorerBaseUrl: "https://eth.blockscout.com",
            apiBaseUrl: "https://eth.blockscout.com/api/v2",

            addressPattern: /^0x[a-fA-F0-9]{40}$/
        },

        API: {
            transactionLimit: 100,
            pageSize: 50,
            maximumPages: 2,

            timeoutMilliseconds: 20000,
            retryCount: 1,
            retryDelayMilliseconds: 700
        },

        CACHE: {
            databaseName: "chaintrace-cache",
            databaseVersion: 1,
            walletStoreName: "wallet-analyses",

            lifetimeMilliseconds: 10 * 60 * 1000,
            maximumEntries: 15
        },

        DEMO: {
            address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
            dataPath: "./assets/data/demo-wallet.json"
        },

        UI: {
            minimumWarpDurationMilliseconds: 1400,
            toastDurationMilliseconds: 2400,
            recentWalletLimit: 4
        }
    };

    function deepFreeze(value, visited) {
        if (
            value === null ||
            typeof value !== "object" ||
            Object.isFrozen(value)
        ) {
            return value;
        }

        const seen = visited || new WeakSet();

        if (seen.has(value)) {
            return value;
        }

        seen.add(value);

        for (const propertyName of Object.getOwnPropertyNames(value)) {
            deepFreeze(value[propertyName], seen);
        }

        return Object.freeze(value);
    }

    window.ChainTraceConfig = deepFreeze(config);
})(window);
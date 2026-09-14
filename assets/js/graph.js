(function (window, document) {
    "use strict";

    const echarts = window.echarts;
    const config = window.ChainTraceConfig;

    if (!echarts || !config) {
        console.error(
            "ChainTrace graph could not start: dependencies are unavailable."
        );

        return;
    }

    const STAR_SYMBOL =
        "path://M0,-10L2.2,-2.2L10,0L2.2,2.2L0,10L-2.2,2.2L-10,0L-2.2,-2.2Z";

    const COLORS = {
        text: "#f1f4fa",
        secondary: "#9aa4b5",
        muted: "#5e6878",
        border: "rgba(188,201,255,.13)",

        core: "#8f9aff",
        incoming: "#56dbae",
        outgoing: "#9692ff",
        contract: "#e8ba72",
        failed: "#ed747c",
        neutral: "#71809b"
    };

    const state = {
        analysis: null,
        model: null,

        filter: "all",
        period: "all",

        graphChart: null,
        directionChart: null,
        activityChart: null,

        transactionByHash: new Map(),
        selectionHandler: null
    };

    function clamp(value, minimum, maximum) {
        return Math.min(
            Math.max(value, minimum),
            maximum
        );
    }

    function hashCode(value) {
        let hash = 2166136261;

        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }

        return hash >>> 0;
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    function shortAddress(address, start, end) {
        if (!address) {
            return "UNKNOWN";
        }

        const startLength = start ?? 7;
        const endLength = end ?? 5;

        if (
            address.length <=
            startLength + endLength + 1
        ) {
            return address;
        }

        return (
            address.slice(0, startLength) +
            "…" +
            address.slice(-endLength)
        );
    }

    function weiToEth(weiValue) {
        const value = String(weiValue || "0");

        if (!/^\d+$/.test(value)) {
            return 0;
        }

        const padded =
            value.length <= 18
                ? value.padStart(19, "0")
                : value;

        const whole = padded.slice(0, -18) || "0";
        const fraction = padded.slice(-18).slice(0, 10);

        const result =
            Number(whole) +
            Number(`0.${fraction}`);

        return Number.isFinite(result)
            ? result
            : 0;
    }

    function formatEth(value) {
        const amount = Number(value || 0);

        if (amount === 0) {
            return "0 ETH";
        }

        if (amount < 0.000001) {
            return "<0.000001 ETH";
        }

        if (amount < 0.01) {
            return `${amount.toFixed(6)} ETH`;
        }

        if (amount < 1) {
            return `${amount.toFixed(4)} ETH`;
        }

        if (amount < 1000) {
            return (
                amount.toLocaleString("en-US", {
                    maximumFractionDigits: 3
                }) +
                " ETH"
            );
        }

        return (
            new Intl.NumberFormat("en-US", {
                notation: "compact",
                maximumFractionDigits: 2
            }).format(amount) +
            " ETH"
        );
    }

    function formatAge(timestamp) {
        if (!timestamp) {
            return "UNKNOWN";
        }

        const difference =
            Date.now() -
            new Date(timestamp).getTime();

        if (!Number.isFinite(difference)) {
            return "UNKNOWN";
        }

        const seconds = Math.max(
            0,
            Math.floor(difference / 1000)
        );

        if (seconds < 60) {
            return `${seconds}S AGO`;
        }

        const minutes = Math.floor(seconds / 60);

        if (minutes < 60) {
            return `${minutes}M AGO`;
        }

        const hours = Math.floor(minutes / 60);

        if (hours < 24) {
            return `${hours}H AGO`;
        }

        const days = Math.floor(hours / 24);

        if (days < 30) {
            return `${days}D AGO`;
        }

        const months = Math.floor(days / 30);

        if (months < 12) {
            return `${months}MO AGO`;
        }

        return `${Math.floor(months / 12)}Y AGO`;
    }

    function formatDateTime(timestamp) {
        if (!timestamp) {
            return "UNKNOWN";
        }

        return new Intl.DateTimeFormat("en-GB", {
            dateStyle: "medium",
            timeStyle: "medium",
            timeZone: "UTC"
        }).format(new Date(timestamp));
    }

    function getSectorCode(address) {
        const hash = hashCode(
            String(address || "unknown").toLowerCase()
        );

        return `CT-${hash
            .toString(16)
            .toUpperCase()
            .padStart(8, "0")
            .slice(0, 6)}`;
    }

    function getTransactionColor(transaction) {
        if (transaction.status === "failed") {
            return COLORS.failed;
        }

        if (transaction.isContractInteraction) {
            return COLORS.contract;
        }

        if (transaction.direction === "in") {
            return COLORS.incoming;
        }

        if (transaction.direction === "out") {
            return COLORS.outgoing;
        }

        return COLORS.neutral;
    }

    function matchesFilter(transaction) {
        if (state.filter === "all") {
            return true;
        }

        if (state.filter === "contract") {
            return transaction.isContractInteraction;
        }

        if (state.filter === "failed") {
            return transaction.status === "failed";
        }

        return transaction.direction === state.filter;
    }

    function buildModel(analysis) {
        const groups = new Map();

        const metrics = {
            balanceEth: weiToEth(
                analysis.balanceWei
            ),

            receivedEth: 0,
            sentEth: 0,
            gasEth: 0,

            incomingCount: 0,
            outgoingCount: 0,
            selfCount: 0,

            contractCount: 0,
            failedCount: 0,

            transactionCount:
                analysis.transactions.length,

            counterpartyCount: 0
        };

        state.transactionByHash.clear();

        analysis.transactions.forEach(
            (transaction, index) => {
                const valueEth = weiToEth(
                    transaction.valueWei
                );

                const feeEth = weiToEth(
                    transaction.feeWei
                );

                if (transaction.direction === "in") {
                    metrics.receivedEth += valueEth;
                    metrics.incomingCount += 1;
                }

                if (transaction.direction === "out") {
                    metrics.sentEth += valueEth;
                    metrics.gasEth += feeEth;
                    metrics.outgoingCount += 1;
                }

                if (transaction.direction === "self") {
                    metrics.selfCount += 1;
                    metrics.gasEth += feeEth;
                }

                if (transaction.isContractInteraction) {
                    metrics.contractCount += 1;
                }

                if (transaction.status === "failed") {
                    metrics.failedCount += 1;
                }

                if (transaction.hash) {
                    state.transactionByHash.set(
                        transaction.hash,
                        transaction
                    );
                }

                const counterparty =
                    transaction.counterparty ||
                    `UNKNOWN-${index}`;

                const key =
                    counterparty.toLowerCase();

                if (!groups.has(key)) {
                    groups.set(key, {
                        key,
                        address: transaction.counterparty,
                        transactions: [],
                        totalValueEth: 0,
                        incomingCount: 0,
                        outgoingCount: 0,
                        contractCount: 0
                    });
                }

                const group = groups.get(key);

                group.transactions.push(transaction);
                group.totalValueEth += valueEth;

                if (transaction.direction === "in") {
                    group.incomingCount += 1;
                }

                if (transaction.direction === "out") {
                    group.outgoingCount += 1;
                }

                if (transaction.isContractInteraction) {
                    group.contractCount += 1;
                }
            }
        );

        const sortedGroups = Array
            .from(groups.values())
            .sort((first, second) => {
                if (
                    second.transactions.length !==
                    first.transactions.length
                ) {
                    return (
                        second.transactions.length -
                        first.transactions.length
                    );
                }

                return (
                    second.totalValueEth -
                    first.totalValueEth
                );
            });

        metrics.counterpartyCount =
            sortedGroups.filter(
                (group) => Boolean(group.address)
            ).length;

        return {
            analysis,
            groups: sortedGroups,
            metrics,
            sector: getSectorCode(analysis.address)
        };
    }

    function getFilteredGroups() {
        return state.model.groups
            .map((group) => ({
                ...group,

                filteredTransactions:
                    group.transactions.filter(
                        matchesFilter
                    )
            }))
            .filter(
                (group) =>
                    group.filteredTransactions.length > 0
            );
    }

    function getGroupDirectionColor(group) {
        if (
            group.filteredTransactions.some(
                (transaction) =>
                    transaction.status === "failed"
            )
        ) {
            return COLORS.failed;
        }

        if (
            group.filteredTransactions.some(
                (transaction) =>
                    transaction.isContractInteraction
            )
        ) {
            return COLORS.contract;
        }

        const incoming =
            group.filteredTransactions.filter(
                (transaction) =>
                    transaction.direction === "in"
            ).length;

        const outgoing =
            group.filteredTransactions.filter(
                (transaction) =>
                    transaction.direction === "out"
            ).length;

        if (incoming > outgoing) {
            return COLORS.incoming;
        }

        if (outgoing > incoming) {
            return COLORS.outgoing;
        }

        return COLORS.core;
    }

    function getStarSize(transaction) {
        const value = weiToEth(
            transaction.valueWei
        );

        const valueScale =
            Math.log10(value + 1) * 4.1;

        const contractScale =
            transaction.isContractInteraction
                ? 1.8
                : 0;

        return clamp(
            5.5 + valueScale + contractScale,
            5.5,
            18
        );
    }

    function buildConstellationData() {
        const groups = getFilteredGroups();

        const nodes = [];
        const links = [];

        const walletNodeId = "observed-wallet";

        nodes.push({
            id: walletNodeId,
            name: shortAddress(
                state.analysis.address
            ),

            nodeType: "wallet",
            address: state.analysis.address,

            x: 0,
            y: 0,

            fixed: true,
            draggable: false,

            symbol: STAR_SYMBOL,
            symbolSize: 47,

            itemStyle: {
                color: COLORS.core,
                borderColor: "#ccd2ff",
                borderWidth: 1,

                shadowBlur: 34,
                shadowColor:
                    "rgba(143,154,255,.7)"
            },

            label: {
                show: true,
                position: "bottom",
                distance: 14,

                color: COLORS.text,
                fontFamily:
                    "Cascadia Code, Consolas, monospace",

                fontSize: 8,
                fontWeight: 600
            }
        });

        const goldenAngle =
            Math.PI * (3 - Math.sqrt(5));

        groups.forEach((group, groupIndex) => {
            const groupHash = hashCode(
                group.key
            );

            const jitter =
                (
                    groupHash % 1000 /
                    1000 -
                    0.5
                ) * 0.28;

            const angle =
                groupIndex * goldenAngle +
                jitter;

            const ringIndex =
                groupIndex % 4;

            const distance =
                320 +
                ringIndex * 112 +
                Math.floor(groupIndex / 12) * 45;

            const groupX =
                Math.cos(angle) * distance;

            const groupY =
                Math.sin(angle) *
                distance *
                0.64;

            const transactions =
                group.filteredTransactions;

            const hasCluster =
                transactions.length > 1;

            let parentNodeId =
                walletNodeId;

            if (hasCluster) {
                const clusterNodeId =
                    `cluster:${group.key}`;

                const clusterColor =
                    getGroupDirectionColor(group);

                nodes.push({
                    id: clusterNodeId,

                    name: shortAddress(
                        group.address,
                        6,
                        4
                    ),

                    nodeType: "counterparty",
                    address: group.address,

                    transactionCount:
                        transactions.length,

                    latestTransactionHash:
                        transactions[0]?.hash ||
                        null,

                    x: groupX,
                    y: groupY,

                    draggable: true,

                    symbol: "diamond",

                    symbolSize: clamp(
                        7 +
                        Math.sqrt(
                            transactions.length
                        ) * 2.6,
                        9,
                        18
                    ),

                    itemStyle: {
                        color: clusterColor,
                        borderColor:
                            "rgba(255,255,255,.3)",

                        borderWidth: 0.7,
                        shadowBlur: 12,
                        shadowColor: clusterColor
                    },

                    label: {
                        show: false
                    }
                });

                links.push({
                    source: walletNodeId,
                    target: clusterNodeId,

                    linkType: "cluster",
                    transactionCount:
                        transactions.length,

                    lineStyle: {
                        color: clusterColor,
                        width: clamp(
                            0.5 +
                            Math.sqrt(
                                transactions.length
                            ) * 0.22,
                            0.7,
                            1.8
                        ),

                        opacity: 0.18,
                        curveness:
                            jitter * 0.08
                    }
                });

                parentNodeId =
                    clusterNodeId;
            }

            transactions.forEach(
                (transaction, transactionIndex) => {
                    const transactionHash =
                        transaction.hash ||
                        `${group.key}-${transactionIndex}`;

                    const transactionSeed =
                        hashCode(transactionHash);

                    const localAngle =
                        transactionIndex *
                            goldenAngle +
                        (
                            transactionSeed % 360
                        ) *
                            Math.PI /
                            180;

                    const localDistance =
                        hasCluster
                            ? (
                                27 +
                                Math.sqrt(
                                    transactionIndex + 1
                                ) * 18 +
                                transactionSeed % 17
                            )
                            : 0;

                    const starX =
                        groupX +
                        Math.cos(localAngle) *
                            localDistance;

                    const starY =
                        groupY +
                        Math.sin(localAngle) *
                            localDistance *
                            0.72;

                    const color =
                        getTransactionColor(
                            transaction
                        );

                    const starNodeId =
                        `transaction:${transactionHash}`;

                    nodes.push({
                        id: starNodeId,

                        name: shortAddress(
                            transactionHash,
                            7,
                            5
                        ),

                        nodeType: "transaction",

                        transactionHash:
                            transaction.hash,

                        transactionIndex,

                        direction:
                            transaction.direction,

                        method:
                            transaction.method,

                        valueEth: weiToEth(
                            transaction.valueWei
                        ),

                        x: starX,
                        y: starY,

                        draggable: true,

                        symbol: STAR_SYMBOL,
                        symbolSize:
                            getStarSize(transaction),

                        itemStyle: {
                            color,

                            borderColor:
                                transaction
                                    .isContractInteraction
                                    ? COLORS.contract
                                    : "rgba(255,255,255,.35)",

                            borderWidth:
                                transaction
                                    .isContractInteraction
                                    ? 1
                                    : 0.45,

                            shadowBlur:
                                transaction.status ===
                                "failed"
                                    ? 15
                                    : 10,

                            shadowColor: color
                        },

                        label: {
                            show: false
                        }
                    });

                    links.push({
                        source: parentNodeId,
                        target: starNodeId,

                        linkType: "transaction",
                        transactionHash:
                            transaction.hash,

                        direction:
                            transaction.direction,

                        lineStyle: {
                            color,
                            width: 0.7,
                            opacity: 0.38,

                            curveness:
                                (
                                    transactionSeed %
                                    11 -
                                    5
                                ) *
                                0.006,

                            type:
                                transaction.status ===
                                "failed"
                                    ? "dashed"
                                    : "solid"
                        }
                    });
                }
            );
        });

        return {
            nodes,
            links,
            groupCount: groups.length,
            transactionCount:
                nodes.filter(
                    (node) =>
                        node.nodeType ===
                        "transaction"
                ).length
        };
    }

    function tooltipOptions() {
        return {
            trigger: "item",
            confine: true,

            backgroundColor:
                "rgba(5,8,13,.94)",

            borderColor:
                "rgba(188,201,255,.16)",

            borderWidth: 1,
            padding: 0,

            textStyle: {
                color: COLORS.text,
                fontFamily:
                    "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
            },

            extraCssText:
                "border-radius:2px;" +
                "box-shadow:0 20px 55px rgba(0,0,0,.34);" +
                "backdrop-filter:blur(16px);"
        };
    }

    function formatGraphTooltip(parameters) {
        const data = parameters.data;

        if (
            parameters.dataType === "edge"
        ) {
            return "";
        }

        if (data.nodeType === "wallet") {
            return `
                <div style="padding:11px 13px;min-width:190px">
                    <span style="
                        color:#5e6878;
                        font-family:monospace;
                        font-size:7px;
                        letter-spacing:.08em
                    ">
                        OBSERVED WALLET
                    </span>

                    <strong style="
                        display:block;
                        margin-top:7px;
                        font-family:monospace;
                        font-size:10px
                    ">
                        ${escapeHtml(
                            shortAddress(
                                data.address,
                                11,
                                8
                            )
                        )}
                    </strong>
                </div>
            `;
        }

        if (data.nodeType === "counterparty") {
            return `
                <div style="padding:11px 13px;min-width:190px">
                    <span style="
                        color:#5e6878;
                        font-family:monospace;
                        font-size:7px;
                        letter-spacing:.08em
                    ">
                        COUNTERPARTY CLUSTER
                    </span>

                    <strong style="
                        display:block;
                        margin-top:7px;
                        font-family:monospace;
                        font-size:10px
                    ">
                        ${escapeHtml(
                            shortAddress(
                                data.address,
                                11,
                                8
                            )
                        )}
                    </strong>

                    <span style="
                        display:block;
                        margin-top:5px;
                        color:#9aa4b5;
                        font-size:9px
                    ">
                        ${data.transactionCount}
                        connected transactions
                    </span>
                </div>
            `;
        }

        const transaction =
            state.transactionByHash.get(
                data.transactionHash
            );

        if (!transaction) {
            return "";
        }

        return `
            <div style="padding:11px 13px;min-width:205px">
                <span style="
                    color:${escapeHtml(
                        getTransactionColor(
                            transaction
                        )
                    )};
                    font-family:monospace;
                    font-size:7px;
                    font-weight:700;
                    letter-spacing:.08em
                ">
                    ${escapeHtml(
                        transaction.direction.toUpperCase()
                    )}
                    TRANSACTION
                </span>

                <strong style="
                    display:block;
                    margin-top:7px;
                    font-size:15px;
                    font-weight:570
                ">
                    ${escapeHtml(
                        formatEth(
                            weiToEth(
                                transaction.valueWei
                            )
                        )
                    )}
                </strong>

                <span style="
                    display:block;
                    margin-top:5px;
                    color:#9aa4b5;
                    font-family:monospace;
                    font-size:8px
                ">
                    ${escapeHtml(
                        transaction.method
                    )}
                    ·
                    ${escapeHtml(
                        formatAge(
                            transaction.timestamp
                        )
                    )}
                </span>
            </div>
        `;
    }

    function renderConstellation() {
        const graphData =
            buildConstellationData();

        state.graphChart.setOption(
            {
                backgroundColor: "transparent",

                animation: true,
                animationDuration: 1150,
                animationDurationUpdate: 620,
                animationEasing: "cubicOut",
                animationEasingUpdate: "cubicOut",

                tooltip: {
                    ...tooltipOptions(),
                    formatter: formatGraphTooltip
                },

                graphic:
                    graphData.transactionCount === 0
                        ? [
                            {
                                type: "text",
                                left: "center",
                                top: "52%",

                                style: {
                                    text:
                                        "NO TRANSACTION STARS IN THIS FILTER",

                                    fill: COLORS.muted,
                                    font:
                                        "8px Cascadia Code, Consolas, monospace"
                                }
                            }
                        ]
                        : [],

                series: [
                    {
                        type: "graph",
                        layout: "none",

                        left: "4%",
                        right: "4%",
                        top: "19%",
                        bottom: "17%",

                        data: graphData.nodes,
                        links: graphData.links,

                        roam: true,
                        draggable: true,

                        scaleLimit: {
                            min: 0.45,
                            max: 6
                        },

                        lineStyle: {
                            opacity: 0.3,
                            width: 0.7
                        },

                        label: {
                            show: false
                        },

                        labelLayout: {
                            hideOverlap: true
                        },

                        emphasis: {
                            focus: "adjacency",

                            label: {
                                show: true,
                                position: "right",
                                distance: 7,

                                color: COLORS.text,
                                fontFamily:
                                    "Cascadia Code, Consolas, monospace",

                                fontSize: 7
                            },

                            itemStyle: {
                                borderWidth: 1.4
                            },

                            lineStyle: {
                                opacity: 0.9
                            }
                        },

                        blur: {
                            itemStyle: {
                                opacity: 0.15
                            },

                            lineStyle: {
                                opacity: 0.035
                            },

                            label: {
                                show: false
                            }
                        }
                    }
                ]
            },
            true
        );

        updateFieldInformation(graphData);

        return graphData;
    }

    function renderDirectionChart() {
        const metrics = state.model.metrics;

        const data = [
            {
                name: "IN",
                value: metrics.incomingCount,
                itemStyle: {
                    color: COLORS.incoming
                }
            },
            {
                name: "OUT",
                value: metrics.outgoingCount,
                itemStyle: {
                    color: COLORS.outgoing
                }
            },
            {
                name: "SELF",
                value: metrics.selfCount,
                itemStyle: {
                    color: COLORS.neutral
                }
            }
        ].filter((item) => item.value > 0);

        state.directionChart.setOption(
            {
                backgroundColor: "transparent",
                animationDuration: 750,

                tooltip: {
                    ...tooltipOptions(),

                    formatter(parameters) {
                        return `
                            <div style="padding:8px 10px">
                                <strong style="
                                    font-family:monospace;
                                    font-size:8px
                                ">
                                    ${parameters.name}
                                </strong>

                                <span style="
                                    display:block;
                                    margin-top:3px;
                                    color:#9aa4b5;
                                    font-size:8px
                                ">
                                    ${parameters.value}
                                    transactions
                                </span>
                            </div>
                        `;
                    }
                },

                graphic: [
                    {
                        type: "text",
                        left: "center",
                        top: "37%",

                        style: {
                            text: String(
                                metrics.transactionCount
                            ),

                            fill: COLORS.text,
                            font:
                                "600 15px Cascadia Code, Consolas, monospace",

                            textAlign: "center"
                        }
                    },
                    {
                        type: "text",
                        left: "center",
                        top: "57%",

                        style: {
                            text: "TX",
                            fill: COLORS.muted,
                            font:
                                "6px Cascadia Code, Consolas, monospace",

                            textAlign: "center"
                        }
                    }
                ],

                series: [
                    {
                        type: "pie",

                        radius: [
                            "49%",
                            "66%"
                        ],

                        center: [
                            "50%",
                            "53%"
                        ],

                        padAngle: 3,
                        minAngle: 4,

                        label: {
                            show: false
                        },

                        labelLine: {
                            show: false
                        },

                        itemStyle: {
                            borderColor: "transparent",
                            borderRadius: 1
                        },

                        emphasis: {
                            scaleSize: 3
                        },

                        data
                    }
                ]
            },
            true
        );
    }

    function buildActivityData() {
        const now = new Date();

        let transactions =
            state.analysis.transactions.filter(
                (transaction) =>
                    Boolean(transaction.timestamp)
            );

        if (state.period !== "all") {
            const days = Number(state.period);

            const cutoff =
                now.getTime() -
                days * 24 * 60 * 60 * 1000;

            transactions = transactions.filter(
                (transaction) =>
                    new Date(
                        transaction.timestamp
                    ).getTime() >= cutoff
            );
        }

        const buckets = new Map();

        function ensureBucket(key) {
            if (!buckets.has(key)) {
                buckets.set(key, {
                    key,
                    incoming: 0,
                    outgoing: 0
                });
            }

            return buckets.get(key);
        }

        if (state.period !== "all") {
            const days = Number(state.period);

            for (
                let offset = days - 1;
                offset >= 0;
                offset -= 1
            ) {
                const date = new Date(
                    now.getTime() -
                    offset *
                        24 *
                        60 *
                        60 *
                        1000
                );

                ensureBucket(
                    date.toISOString().slice(0, 10)
                );
            }
        }

        for (const transaction of transactions) {
            const key =
                transaction.timestamp.slice(0, 10);

            const bucket = ensureBucket(key);

            if (transaction.direction === "in") {
                bucket.incoming += 1;
            }

            if (transaction.direction === "out") {
                bucket.outgoing += 1;
            }
        }

        return Array
            .from(buckets.values())
            .sort((first, second) =>
                first.key.localeCompare(second.key)
            )
            .slice(-36);
    }

    function renderActivityChart() {
        const buckets = buildActivityData();

        const labels = buckets.map((bucket) => {
            return new Intl.DateTimeFormat(
                "en-US",
                {
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC"
                }
            ).format(
                new Date(
                    `${bucket.key}T00:00:00Z`
                )
            );
        });

        state.activityChart.setOption(
            {
                backgroundColor: "transparent",
                animationDuration: 760,

                grid: {
                    left: 25,
                    right: 10,
                    top: 16,
                    bottom: 22
                },

                tooltip: {
                    ...tooltipOptions(),
                    trigger: "axis"
                },

                xAxis: {
                    type: "category",
                    boundaryGap: false,
                    data: labels,

                    axisLine: {
                        lineStyle: {
                            color: COLORS.border
                        }
                    },

                    axisTick: {
                        show: false
                    },

                    axisLabel: {
                        color: COLORS.muted,
                        fontSize: 6,
                        hideOverlap: true
                    }
                },

                yAxis: {
                    type: "value",
                    minInterval: 1,

                    axisLine: {
                        show: false
                    },

                    axisTick: {
                        show: false
                    },

                    axisLabel: {
                        color: COLORS.muted,
                        fontSize: 6
                    },

                    splitLine: {
                        lineStyle: {
                            color: COLORS.border,
                            type: "dashed"
                        }
                    }
                },

                series: [
                    {
                        name: "IN",
                        type: "line",

                        data: buckets.map(
                            (bucket) =>
                                bucket.incoming
                        ),

                        smooth: 0.35,
                        showSymbol: false,

                        lineStyle: {
                            color: COLORS.incoming,
                            width: 1
                        },

                        areaStyle: {
                            color:
                                new echarts.graphic
                                    .LinearGradient(
                                        0,
                                        0,
                                        0,
                                        1,
                                        [
                                            {
                                                offset: 0,
                                                color:
                                                    "rgba(86,219,174,.13)"
                                            },
                                            {
                                                offset: 1,
                                                color:
                                                    "rgba(86,219,174,0)"
                                            }
                                        ]
                                    )
                        }
                    },
                    {
                        name: "OUT",
                        type: "line",

                        data: buckets.map(
                            (bucket) =>
                                bucket.outgoing
                        ),

                        smooth: 0.35,
                        showSymbol: false,

                        lineStyle: {
                            color: COLORS.outgoing,
                            width: 1
                        },

                        areaStyle: {
                            color:
                                new echarts.graphic
                                    .LinearGradient(
                                        0,
                                        0,
                                        0,
                                        1,
                                        [
                                            {
                                                offset: 0,
                                                color:
                                                    "rgba(150,146,255,.12)"
                                            },
                                            {
                                                offset: 1,
                                                color:
                                                    "rgba(150,146,255,0)"
                                            }
                                        ]
                                    )
                        }
                    }
                ]
            },
            true
        );
    }

    function setText(id, value) {
        const element =
            document.getElementById(id);

        if (element) {
            element.textContent = value;
        }
    }

    function updateMetricRail() {
        const metrics = state.model.metrics;

        setText(
            "wallet-short-address",
            shortAddress(state.analysis.address, 10, 7)
        );

        setText(
            "metric-balance",
            formatEth(metrics.balanceEth)
        );

        setText(
            "metric-received",
            formatEth(metrics.receivedEth)
        );

        setText(
            "metric-sent",
            formatEth(metrics.sentEth)
        );

        setText(
            "metric-gas",
            formatEth(metrics.gasEth)
        );

        setText(
            "metric-counterparties",
            String(metrics.counterpartyCount)
        );

        setText(
            "metric-transactions",
            String(metrics.transactionCount)
        );

        setText(
            "data-source",
            `${state.analysis.source.name.toUpperCase()} / LIVE`
        );

        setText(
            "data-age",
            "JUST NOW"
        );

        const walletLink =
            document.getElementById(
                "wallet-explorer-link"
            );

        if (walletLink && window.ChainTraceApi) {
            walletLink.href =
                window.ChainTraceApi
                    .getWalletExplorerUrl(
                        state.analysis.address
                    );
        }
    }

    function updateFieldInformation(graphData) {
        setText(
            "field-sector",
            state.model.sector
        );

        setText(
            "field-stars",
            String(graphData.transactionCount)
        );

        setText(
            "field-clusters",
            String(graphData.groupCount)
        );

        setText(
            "field-contracts",
            String(
                state.model.metrics.contractCount
            )
        );

        setText(
            "field-failed",
            String(
                state.model.metrics.failedCount
            )
        );
    }

    function renderTransactionStream() {
        const stream =
            document.getElementById(
                "transaction-stream"
            );

        if (!stream) {
            return;
        }

        stream.replaceChildren();

        state.analysis.transactions
            .slice(0, 8)
            .forEach((transaction) => {
                const item =
                    document.createElement("li");

                const direction =
                    document.createElement("span");

                direction.className =
                    `stream-direction is-${transaction.direction}`;

                direction.textContent =
                    transaction.direction.toUpperCase();

                const address =
                    document.createElement("span");

                address.className =
                    "stream-address";

                address.textContent =
                    shortAddress(
                        transaction.counterparty,
                        7,
                        5
                    );

                const value =
                    document.createElement("span");

                value.className =
                    "stream-value";

                value.textContent =
                    formatEth(
                        weiToEth(
                            transaction.valueWei
                        )
                    );

                item.append(
                    direction,
                    address,
                    value
                );

                item.addEventListener(
                    "click",
                    () => {
                        showTransactionInspector(
                            transaction
                        );
                    }
                );

                stream.append(item);
            });
    }

    function showTransactionInspector(transaction) {
        if (!transaction) {
            return;
        }

        const inspector =
            document.getElementById(
                "transaction-inspector"
            );

        if (!inspector) {
            return;
        }

        setText(
            "inspector-direction",
            `${transaction.direction.toUpperCase()} TRANSACTION`
        );

        setText(
            "inspector-value",
            formatEth(
                weiToEth(transaction.valueWei)
            )
        );

        setText(
            "inspector-status",
            transaction.status.toUpperCase()
        );

        setText(
            "inspector-method",
            transaction.method
        );

        setText(
            "inspector-from",
            shortAddress(
                transaction.from,
                10,
                7
            )
        );

        setText(
            "inspector-to",
            shortAddress(
                transaction.to,
                10,
                7
            )
        );

        setText(
            "inspector-fee",
            formatEth(
                weiToEth(transaction.feeWei)
            )
        );

        setText(
            "inspector-block",
            String(
                transaction.blockNumber ?? "—"
            )
        );

        setText(
            "inspector-time",
            formatDateTime(
                transaction.timestamp
            )
        );

        setText(
            "inspector-hash",
            shortAddress(
                transaction.hash,
                12,
                9
            )
        );

        const hashElement =
            document.getElementById(
                "inspector-hash"
            );

        if (hashElement) {
            hashElement.title =
                transaction.hash || "";
        }

        const link =
            document.getElementById(
                "transaction-explorer-link"
            );

        if (
            link &&
            transaction.hash &&
            window.ChainTraceApi
        ) {
            link.href =
                window.ChainTraceApi
                    .getTransactionExplorerUrl(
                        transaction.hash
                    );
        }

        inspector.hidden = false;

        document.body.classList.add(
            "inspector-open"
        );

        if (
            typeof state.selectionHandler ===
            "function"
        ) {
            state.selectionHandler(transaction);
        }
    }

    function closeTransactionInspector() {
        const inspector =
            document.getElementById(
                "transaction-inspector"
            );

        if (inspector) {
            inspector.hidden = true;
        }

        document.body.classList.remove(
            "inspector-open"
        );
    }

    function handleGraphClick(parameters) {
        const data = parameters.data;

        if (!data) {
            return;
        }

        if (data.nodeType === "transaction") {
            showTransactionInspector(
                state.transactionByHash.get(
                    data.transactionHash
                )
            );

            return;
        }

        if (
            data.nodeType === "counterparty" &&
            data.latestTransactionHash
        ) {
            showTransactionInspector(
                state.transactionByHash.get(
                    data.latestTransactionHash
                )
            );
        }
    }

    function ensureCharts() {
        const graphElement =
            document.getElementById(
                "transaction-space"
            );

        const directionElement =
            document.getElementById(
                "direction-chart"
            );

        const activityElement =
            document.getElementById(
                "activity-chart"
            );

        if (
            !graphElement ||
            !directionElement ||
            !activityElement
        ) {
            throw new Error(
                "ChainTrace chart containers are missing."
            );
        }

        if (!state.graphChart) {
            state.graphChart = echarts.init(
                graphElement,
                null,
                {
                    renderer: "canvas",
                    useDirtyRect: true
                }
            );

            state.graphChart.on(
                "click",
                handleGraphClick
            );
        }

        if (!state.directionChart) {
            state.directionChart = echarts.init(
                directionElement,
                null,
                {
                    renderer: "canvas",
                    useDirtyRect: true
                }
            );
        }

        if (!state.activityChart) {
            state.activityChart = echarts.init(
                activityElement,
                null,
                {
                    renderer: "canvas",
                    useDirtyRect: true
                }
            );
        }
    }

    function render(analysis) {
        if (
            !analysis ||
            !Array.isArray(analysis.transactions)
        ) {
            throw new TypeError(
                "A valid ChainTrace wallet analysis is required."
            );
        }

        state.analysis = analysis;
        state.model = buildModel(analysis);

        ensureCharts();

        const constellation =
            renderConstellation();

        renderDirectionChart();
        renderActivityChart();
        renderTransactionStream();
        updateMetricRail();

        window.requestAnimationFrame(resize);

        return {
            ...state.model,
            constellation
        };
    }

    function setFilter(filter) {
        if (
            ![
                "all",
                "in",
                "out",
                "contract",
                "failed"
            ].includes(filter)
        ) {
            return;
        }

        state.filter = filter;

        document
            .querySelectorAll(".graph-filter")
            .forEach((button) => {
                const isActive =
                    button.dataset.filter ===
                    filter;

                button.classList.toggle(
                    "is-active",
                    isActive
                );

                button.setAttribute(
                    "aria-pressed",
                    String(isActive)
                );
            });

        if (state.model) {
            renderConstellation();
        }
    }

    function setPeriod(period) {
        const normalizedPeriod =
            String(period);

        if (
            ![
                "7",
                "30",
                "all"
            ].includes(normalizedPeriod)
        ) {
            return;
        }

        state.period = normalizedPeriod;

        document
            .querySelectorAll(
                ".period-filter button"
            )
            .forEach((button) => {
                button.classList.toggle(
                    "is-active",
                    button.dataset.period ===
                        normalizedPeriod
                );
            });

        if (state.model) {
            renderActivityChart();
        }
    }

    function recenter() {
        if (state.model) {
            renderConstellation();
        }
    }

    function resize() {
        state.graphChart?.resize();
        state.directionChart?.resize();
        state.activityChart?.resize();
    }

    function onSelection(handler) {
        state.selectionHandler =
            typeof handler === "function"
                ? handler
                : null;
    }

    function getModel() {
        return state.model;
    }

    function dispose() {
        state.graphChart?.dispose();
        state.directionChart?.dispose();
        state.activityChart?.dispose();

        state.graphChart = null;
        state.directionChart = null;
        state.activityChart = null;

        state.analysis = null;
        state.model = null;

        state.transactionByHash.clear();

        closeTransactionInspector();
    }

    function bindInterface() {
        document
            .querySelectorAll(".graph-filter")
            .forEach((button) => {
                button.addEventListener(
                    "click",
                    () => {
                        setFilter(
                            button.dataset.filter
                        );
                    }
                );
            });

        document
            .querySelectorAll(
                ".period-filter button"
            )
            .forEach((button) => {
                button.addEventListener(
                    "click",
                    () => {
                        setPeriod(
                            button.dataset.period
                        );
                    }
                );
            });

        document
            .getElementById("recenter-graph")
            ?.addEventListener(
                "click",
                recenter
            );

        document
            .getElementById("close-inspector")
            ?.addEventListener(
                "click",
                closeTransactionInspector
            );
    }

    let resizeFrame = 0;

    window.addEventListener(
        "resize",
        () => {
            window.cancelAnimationFrame(
                resizeFrame
            );

            resizeFrame =
                window.requestAnimationFrame(
                    resize
                );
        },
        {
            passive: true
        }
    );

    bindInterface();

    window.ChainTraceGraph = Object.freeze({
        render,
        resize,
        dispose,

        setFilter,
        setPeriod,
        recenter,

        onSelection,
        getModel,

        showTransactionInspector,
        closeTransactionInspector,

        formatEth,
        formatAge,
        formatDateTime,
        shortAddress,
        weiToEth,
        getSectorCode
    });
})(window, document);
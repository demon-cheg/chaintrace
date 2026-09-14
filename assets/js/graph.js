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

    const STELLAR = Object.freeze({
        minSize: 4,
        maxSize: 80,
        tabletMaxSize: 68,
        mobileMaxSize: 56,

        dustMaxSize: 7,
        starMaxSize: 18,
        giantMaxSize: 36,
        pulsarMaxSize: 58,

        collisionPadding: 11
    });

    const state = {
        analysis: null,
        model: null,

        filter: "all",
        period: "all",

        graphChart: null,
        directionChart: null,
        activityChart: null,

        transactionByHash: new Map(),
        stellarByTransaction: new WeakMap(),
        nodeIndexByHash: new Map(),
        animatedElements: [],
        responsiveMaxSize: null,
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

        state.stellarByTransaction =
            buildStellarProfiles(
                analysis.transactions
            );

        state.nodeIndexByHash.clear();
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

    function getMaximumRenderedStarSize() {
        if (window.innerWidth <= 680) {
            return STELLAR.mobileMaxSize;
        }
    
        if (window.innerWidth <= 1180) {
            return STELLAR.tabletMaxSize;
        }
    
        return STELLAR.maxSize;
    }

    function getStellarClass(canonicalSize) {
        if (canonicalSize <= STELLAR.dustMaxSize) {
            return "dust";
        }
    
        if (canonicalSize <= STELLAR.starMaxSize) {
            return "star";
        }
    
        if (canonicalSize <= STELLAR.giantMaxSize) {
            return "giant";
        }
    
        if (canonicalSize <= STELLAR.pulsarMaxSize) {
            return "pulsar";
        }
    
        return "singularity";
    }

    function getStellarLabel(stellarClass) {
        return {
            dust: "COSMIC DUST",
            star: "VALUE STAR",
            giant: "GIANT",
            pulsar: "PULSAR",
            singularity: "SINGULARITY"
        }[stellarClass] || "VALUE STAR";
    }

    function getPercentile(sortedValues, value) {
        if (sortedValues.length <= 1) {
            return value > 0 ? 0.5 : 0;
        }
    
        let low = 0;
        let high = sortedValues.length;
    
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
    
            if (sortedValues[middle] <= value) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
    
        return clamp(
            (low - 1) / (sortedValues.length - 1),
            0,
            1
        );
    }

    function buildStellarProfiles(transactions) {
        const profiles = new WeakMap();
    
        const entries = transactions.map(
            (transaction) => ({
                transaction,
                valueEth: Math.max(
                    0,
                    weiToEth(transaction.valueWei)
                )
            })
        );
    
        const sortedValues = entries
            .map((entry) => entry.valueEth)
            .sort((first, second) => first - second);
    
        const positiveValues = sortedValues.filter(
            (value) => value > 0
        );
    
        const minimumPositive = positiveValues[0] || 0;
    
        const maximumPositive =
            positiveValues[positiveValues.length - 1] || 0;
    
        const minimumLog =
            minimumPositive > 0
                ? Math.log10(minimumPositive)
                : 0;
    
        const maximumLog =
            maximumPositive > 0
                ? Math.log10(maximumPositive)
                : minimumLog;
    
        const logSpan = maximumLog - minimumLog;
    
        entries.forEach((entry) => {
            const percentile = getPercentile(
                sortedValues,
                entry.valueEth
            );
    
            let intensity = 0;
    
            if (entry.valueEth > 0) {
                if (logSpan < 0.000001) {
                    intensity = 0.23;
                } else {
                    const logarithmicPosition = clamp(
                        (
                            Math.log10(entry.valueEth) -
                            minimumLog
                        ) / logSpan,
                        0,
                        1
                    );
    
                    /*
                     * Real value ratio is dominant. Percentile only
                     * separates dense groups of similar transfers.
                     */
                    intensity = clamp(
                        logarithmicPosition * 0.84 +
                            percentile * 0.16,
                        0,
                        1
                    );
                }
            }
    
            let canonicalSize =
                STELLAR.minSize +
                (
                    STELLAR.maxSize -
                    STELLAR.minSize
                ) * Math.pow(intensity, 1.48);
    
            if (
                logSpan >= 0.000001 &&
                entry.valueEth === maximumPositive
            ) {
                intensity = 1;
                canonicalSize = STELLAR.maxSize;
            }
    
            canonicalSize = clamp(
                canonicalSize,
                STELLAR.minSize,
                STELLAR.maxSize
            );
    
            const stellarClass =
                getStellarClass(canonicalSize);
    
            profiles.set(entry.transaction, {
                valueEth: entry.valueEth,
                percentile,
                intensity,
                canonicalSize,
                stellarClass,
                label: getStellarLabel(stellarClass)
            });
        });
    
        return profiles;
    }

    function getStellarProfile(transaction) {
        return (
            state.stellarByTransaction.get(transaction) || {
                valueEth: weiToEth(transaction.valueWei),
                percentile: 0,
                intensity: 0,
                canonicalSize: STELLAR.minSize,
                stellarClass: "dust",
                label: getStellarLabel("dust")
            }
        );
    }

    function getRenderedStarSize(profile) {
        const maximum =
            getMaximumRenderedStarSize();
    
        const normalized = clamp(
            (
                profile.canonicalSize -
                STELLAR.minSize
            ) /
            (
                STELLAR.maxSize -
                STELLAR.minSize
            ),
            0,
            1
        );
    
        return (
            STELLAR.minSize +
            normalized *
                (maximum - STELLAR.minSize)
        );
    }

    function colorWithAlpha(hexColor, alpha) {
        const normalized = String(hexColor)
            .replace("#", "")
            .trim();
    
        if (normalized.length !== 6) {
            return hexColor;
        }
    
        const red = parseInt(normalized.slice(0, 2), 16);
        const green = parseInt(normalized.slice(2, 4), 16);
        const blue = parseInt(normalized.slice(4, 6), 16);
    
        return `rgba(${red},${green},${blue},${alpha})`;
    }

    function radialGradient(stops) {
        return new echarts.graphic.RadialGradient(
            0.5,
            0.5,
            0.72,
            stops,
            false
        );
    }

    function getStellarVisual(transaction) {
        const profile =
            getStellarProfile(transaction);
    
        const size =
            getRenderedStarSize(profile);
    
        const semanticColor =
            getTransactionColor(transaction);
    
        let accent = semanticColor;
        let core = "#ffffff";
    
        if (profile.stellarClass === "dust") {
            accent = "#7885a8";
            core = "#dce3ff";
        }
    
        if (profile.stellarClass === "giant") {
            accent =
                transaction.isContractInteraction
                    ? "#ffd18a"
                    : "#8ee9ff";
        }
    
        if (profile.stellarClass === "pulsar") {
            accent =
                transaction.direction === "out"
                    ? "#c8a5ff"
                    : "#73efff";
    
            core = "#fff7d6";
        }
    
        if (profile.stellarClass === "singularity") {
            accent =
                transaction.isContractInteraction
                    ? "#ffca78"
                    : (
                        transaction.direction === "in"
                            ? "#68f0cc"
                            : "#b786ff"
                    );
    
            core = "#02030a";
        }
    
        if (transaction.status === "failed") {
            accent = COLORS.failed;
            core = "#fff0f1";
        }
    
        let fill;
    
        if (profile.stellarClass === "singularity") {
            fill = radialGradient([
                {offset: 0, color: "#010207"},
                {offset: 0.3, color: core},
                {offset: 0.42, color: accent},
                {offset: 0.49, color: "#fff9e9"},
                {offset: 0.58, color: accent},
                {
                    offset: 0.76,
                    color: colorWithAlpha(accent, 0.42)
                },
                {offset: 1, color: "#050712"}
            ]);
        } else {
            fill = radialGradient([
                {offset: 0, color: core},
                {offset: 0.2, color: "#ffffff"},
                {offset: 0.48, color: accent},
                {
                    offset: 0.78,
                    color: colorWithAlpha(accent, 0.72)
                },
                {
                    offset: 1,
                    color: colorWithAlpha(accent, 0.16)
                }
            ]);
        }
    
        const shadowBlur = clamp(
            2 +
                Math.pow(profile.intensity, 1.12) *
                    68,
            2,
            70
        );
    
        return {
            profile,
            size,
            accent,
            semanticColor,
            fill,
    
            symbol:
                profile.stellarClass === "singularity"
                    ? "circle"
                    : STAR_SYMBOL,
    
            shadowBlur,
    
            borderWidth: clamp(
                0.35 + profile.intensity * 2.4,
                0.35,
                2.75
            ),
    
            linkWidth: clamp(
                0.35 +
                    Math.pow(profile.intensity, 1.35) *
                        4.7,
                0.35,
                5.05
            ),
    
            linkOpacity: clamp(
                0.2 +
                    Math.sqrt(profile.intensity) *
                        0.62,
                0.2,
                0.82
            )
        };
    }

    function createHaloNodes(starNode, visual) {
        const stellarClass =
            visual.profile.stellarClass;
    
        if (
            stellarClass !== "giant" &&
            stellarClass !== "pulsar" &&
            stellarClass !== "singularity"
        ) {
            return [];
        }
    
        const outerScale =
            stellarClass === "singularity"
                ? 2.15
                : (
                    stellarClass === "pulsar"
                        ? 1.82
                        : 1.48
                );
    
        const base = {
            name: "",
            nodeType: "halo",
            transactionHash:
                starNode.transactionHash,
            stellarClass,
    
            x: starNode.x,
            y: starNode.y,
    
            fixed: true,
            draggable: false,
            cursor: "default",
    
            symbol: "circle",
    
            label: {
                show: false
            },
    
            tooltip: {
                show: false
            },
    
            emphasis: {
                disabled: true,
                label: {
                    show: false
                }
            }
        };
    
        const halos = [
            {
                ...base,
    
                id:
                    `halo:outer:${starNode.transactionHash}`,
    
                haloRole: "outer",
    
                symbolSize:
                    visual.size * outerScale,
    
                itemStyle: {
                    color: radialGradient([
                        {
                            offset: 0,
                            color: "rgba(0,0,0,0)"
                        },
                        {
                            offset: 0.48,
                            color: colorWithAlpha(
                                visual.accent,
                                0.05
                            )
                        },
                        {
                            offset: 0.64,
                            color: colorWithAlpha(
                                visual.accent,
                                stellarClass ===
                                "singularity"
                                    ? 0.48
                                    : 0.3
                            )
                        },
                        {
                            offset: 0.72,
                            color:
                                "rgba(255,255,255,.12)"
                        },
                        {
                            offset: 0.84,
                            color: colorWithAlpha(
                                visual.accent,
                                0.055
                            )
                        },
                        {
                            offset: 1,
                            color: "rgba(0,0,0,0)"
                        }
                    ]),
    
                    shadowBlur:
                        stellarClass ===
                        "singularity"
                            ? 34
                            : 18,
    
                    shadowColor:
                        colorWithAlpha(
                            visual.accent,
                            0.58
                        )
                },
    
                animationDelay:
                    hashCode(
                        starNode.transactionHash ||
                        starNode.id
                    ) % 700
            }
        ];
    
        if (stellarClass === "singularity") {
            halos.push({
                ...base,
    
                id:
                    `halo:inner:${starNode.transactionHash}`,
    
                haloRole: "inner",
    
                symbolSize:
                    visual.size * 1.42,
    
                itemStyle: {
                    color: radialGradient([
                        {
                            offset: 0,
                            color: "rgba(0,0,0,0)"
                        },
                        {
                            offset: 0.48,
                            color: "rgba(0,0,0,0)"
                        },
                        {
                            offset: 0.55,
                            color: "#fff8df"
                        },
                        {
                            offset: 0.61,
                            color: colorWithAlpha(
                                visual.accent,
                                0.92
                            )
                        },
                        {
                            offset: 0.72,
                            color: colorWithAlpha(
                                visual.accent,
                                0.06
                            )
                        },
                        {
                            offset: 1,
                            color: "rgba(0,0,0,0)"
                        }
                    ]),
    
                    shadowBlur: 24,
                    shadowColor:
                        colorWithAlpha(
                            visual.accent,
                            0.8
                        )
                },
    
                animationDelay:
                    (
                        hashCode(
                            starNode.transactionHash ||
                            starNode.id
                        ) % 700
                    ) + 240
            });
        }
    
        return halos;
    }

    function layoutGroupTransactions(
        groupX,
        groupY,
        transactions,
        hasCluster,
        groupSeed
    ) {
        const goldenAngle =
            Math.PI * (3 - Math.sqrt(5));
    
        const placed = [];
    
        return transactions.map(
            (transaction, index) => {
                const visual =
                    getStellarVisual(transaction);
    
                if (
                    !hasCluster &&
                    transactions.length === 1
                ) {
                    const position = {
                        transaction,
                        visual,
                        x: groupX,
                        y: groupY
                    };
    
                    placed.push(position);
                    return position;
                }
    
                const seed = hashCode(
                    transaction.hash ||
                    `${groupSeed}-${index}`
                );
    
                let angle =
                    index * goldenAngle +
                    (seed % 360) *
                        Math.PI /
                        180;
    
                let radius =
                    46 +
                    visual.size * 0.76 +
                    Math.sqrt(index + 1) * 31 +
                    seed % 19;
    
                let x = groupX;
                let y = groupY;
    
                for (
                    let attempt = 0;
                    attempt < 64;
                    attempt += 1
                ) {
                    x =
                        groupX +
                        Math.cos(angle) * radius;
    
                    y =
                        groupY +
                        Math.sin(angle) *
                            radius *
                            0.76;
    
                    const hasCollision =
                        placed.some((other) => {
                            const required =
                                (
                                    visual.size +
                                    other.visual.size
                                ) *
                                    0.82 +
                                13;
    
                            return (
                                Math.hypot(
                                    x - other.x,
                                    y - other.y
                                ) < required
                            );
                        });
    
                    if (!hasCollision) {
                        break;
                    }
    
                    angle += goldenAngle * 0.37;
                    radius += 5.5 + attempt * 0.18;
                }
    
                const position = {
                    transaction,
                    visual,
                    x,
                    y
                };
    
                placed.push(position);
                return position;
            }
        );
    }

    function resolveNodeCollisions(nodes) {
        const collisionNodes = nodes.filter(
            (node) =>
                node.nodeType === "transaction" ||
                node.nodeType === "counterparty"
        );
    
        for (
            let iteration = 0;
            iteration < 34;
            iteration += 1
        ) {
            for (
                let firstIndex = 0;
                firstIndex < collisionNodes.length;
                firstIndex += 1
            ) {
                const first =
                    collisionNodes[firstIndex];
    
                for (
                    let secondIndex = firstIndex + 1;
                    secondIndex < collisionNodes.length;
                    secondIndex += 1
                ) {
                    const second =
                        collisionNodes[secondIndex];
    
                    let deltaX = second.x - first.x;
                    let deltaY = second.y - first.y;
    
                    let distance =
                        Math.hypot(deltaX, deltaY);
    
                    const minimumDistance =
                        (
                            first.collisionRadius +
                            second.collisionRadius
                        ) *
                            1.58 +
                        STELLAR.collisionPadding;
    
                    if (distance >= minimumDistance) {
                        continue;
                    }
    
                    if (distance < 0.001) {
                        const fallbackAngle =
                            (
                                hashCode(
                                    first.id + second.id
                                ) % 360
                            ) *
                            Math.PI /
                            180;
    
                        deltaX = Math.cos(fallbackAngle);
                        deltaY = Math.sin(fallbackAngle);
                        distance = 1;
                    }
    
                    const overlap =
                        minimumDistance - distance;
    
                    const normalX = deltaX / distance;
                    const normalY = deltaY / distance;
    
                    const firstMobility =
                        first.nodeType ===
                        "counterparty"
                            ? 0.24
                            : 0.5;
    
                    const secondMobility =
                        second.nodeType ===
                        "counterparty"
                            ? 0.24
                            : 0.5;
    
                    first.x -=
                        normalX *
                        overlap *
                        firstMobility;
    
                    first.y -=
                        normalY *
                        overlap *
                        firstMobility;
    
                    second.x +=
                        normalX *
                        overlap *
                        secondMobility;
    
                    second.y +=
                        normalY *
                        overlap *
                        secondMobility;
                }
            }
    
            collisionNodes.forEach((node) => {
                node.x +=
                    (node.anchorX - node.x) *
                    0.018;
    
                node.y +=
                    (node.anchorY - node.y) *
                    0.018;
            });
        }
    }

    function stopStellarAnimations() {
        state.animatedElements.forEach(
            (element) => {
                element?.stopAnimation?.();
            }
        );
    
        state.animatedElements.length = 0;
    }

    function startStellarAnimations(graphData) {
        stopStellarAnimations();
    
        if (
            window.matchMedia(
                "(prefers-reduced-motion: reduce)"
            ).matches
        ) {
            return;
        }
    
        window.requestAnimationFrame(() => {
            if (!state.graphChart) {
                return;
            }
    
            const seriesModel =
                state.graphChart
                    .getModel()
                    ?.getSeriesByIndex(0);
    
            const seriesData =
                seriesModel?.getData();
    
            if (!seriesData) {
                return;
            }
    
            graphData.nodes.forEach(
                (node, dataIndex) => {
                    if (node.nodeType !== "halo") {
                        return;
                    }
    
                    const element =
                        seriesData.getItemGraphicEl(
                            dataIndex
                        );
    
                    if (
                        !element ||
                        typeof element.animate !==
                            "function"
                    ) {
                        return;
                    }
    
                    const amplitude =
                        node.stellarClass ===
                        "singularity"
                            ? 0.105
                            : (
                                node.stellarClass ===
                                "pulsar"
                                    ? 0.14
                                    : 0.07
                            );
    
                    const duration =
                        node.stellarClass ===
                        "singularity"
                            ? 2600
                            : (
                                node.stellarClass ===
                                "pulsar"
                                    ? 1550
                                    : 2300
                            );
    
                    element.stopAnimation?.();
    
                    const animator =
                        element.animate("", true);
    
                    animator
                        .when(0, {
                            scaleX: 1 - amplitude,
                            scaleY: 1 - amplitude
                        })
                        .when(
                            duration / 2,
                            {
                                scaleX:
                                    1 + amplitude,
                                scaleY:
                                    1 + amplitude
                            }
                        )
                        .when(duration, {
                            scaleX: 1 - amplitude,
                            scaleY: 1 - amplitude
                        });
    
                    animator.delay?.(
                        node.animationDelay || 0
                    );
    
                    animator.start(
                        "sinusoidalInOut"
                    );
    
                    state.animatedElements.push(
                        element
                    );
                }
            );
        });
    }

    function buildConstellationData() {
        const groups = getFilteredGroups();
    
        const coreNodes = [];
        const links = [];
        const visualByNodeId = new Map();
    
        const walletNodeId = "observed-wallet";
    
        coreNodes.push({
            id: walletNodeId,
            name: shortAddress(
                state.analysis.address
            ),
    
            nodeType: "wallet",
            address: state.analysis.address,
    
            x: 0,
            y: 0,
    
            anchorX: 0,
            anchorY: 0,
            collisionRadius: 31,
    
            fixed: true,
            draggable: false,
    
            symbol: STAR_SYMBOL,
            symbolSize: 47,
    
            itemStyle: {
                color: radialGradient([
                    {offset: 0, color: "#ffffff"},
                    {offset: 0.24, color: "#dfe4ff"},
                    {offset: 0.6, color: COLORS.core},
                    {
                        offset: 1,
                        color:
                            colorWithAlpha(
                                COLORS.core,
                                0.25
                            )
                    }
                ]),
    
                borderColor: "#ccd2ff",
                borderWidth: 1.2,
    
                shadowBlur: 38,
                shadowColor:
                    "rgba(143,154,255,.78)"
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
            const groupHash =
                hashCode(group.key);
    
            const jitter =
                (
                    groupHash % 1000 /
                    1000 -
                    0.5
                ) * 0.34;
    
            const angle =
                groupIndex * goldenAngle +
                jitter;
    
            const transactions =
                [...group.filteredTransactions]
                    .sort((first, second) => {
                        return (
                            getStellarProfile(second)
                                .canonicalSize -
                            getStellarProfile(first)
                                .canonicalSize
                        );
                    });
    
            const maximumStarSize =
                transactions.reduce(
                    (maximum, transaction) =>
                        Math.max(
                            maximum,
                            getRenderedStarSize(
                                getStellarProfile(
                                    transaction
                                )
                            )
                        ),
                    STELLAR.minSize
                );
    
            const ringIndex = groupIndex % 5;
    
            const distance =
                350 +
                ringIndex * 148 +
                Math.floor(groupIndex / 10) *
                    74 +
                Math.min(
                    125,
                    maximumStarSize * 0.9 +
                        Math.sqrt(
                            transactions.length
                        ) * 16
                );
    
            const groupX =
                Math.cos(angle) * distance;
    
            const groupY =
                Math.sin(angle) *
                distance *
                0.67;
    
            const hasCluster =
                transactions.length > 1;
    
            const aggregateIntensity =
                transactions.reduce(
                    (maximum, transaction) =>
                        Math.max(
                            maximum,
                            getStellarProfile(
                                transaction
                            ).intensity
                        ),
                    0
                );
    
            let parentNodeId = walletNodeId;
    
            if (hasCluster) {
                const clusterNodeId =
                    `cluster:${group.key}`;
    
                const clusterColor =
                    getGroupDirectionColor(group);
    
                const clusterSize = clamp(
                    9 +
                        Math.sqrt(
                            transactions.length
                        ) * 2.8 +
                        aggregateIntensity * 3,
                    10,
                    23
                );
    
                coreNodes.push({
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
    
                    anchorX: groupX,
                    anchorY: groupY,
    
                    collisionRadius:
                        clusterSize / 2 + 5,
    
                    draggable: true,
    
                    symbol: "diamond",
                    symbolSize: clusterSize,
    
                    itemStyle: {
                        color: radialGradient([
                            {
                                offset: 0,
                                color: "#ffffff"
                            },
                            {
                                offset: 0.36,
                                color: clusterColor
                            },
                            {
                                offset: 1,
                                color:
                                    colorWithAlpha(
                                        clusterColor,
                                        0.38
                                    )
                            }
                        ]),
    
                        borderColor:
                            "rgba(255,255,255,.42)",
    
                        borderWidth: 0.9,
    
                        shadowBlur:
                            12 +
                            aggregateIntensity * 12,
    
                        shadowColor:
                            colorWithAlpha(
                                clusterColor,
                                0.62
                            )
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
                            0.65 +
                                Math.sqrt(
                                    transactions.length
                                ) * 0.2 +
                                aggregateIntensity * 2.6,
                            0.7,
                            4
                        ),
    
                        opacity:
                            0.15 +
                            aggregateIntensity * 0.27,
    
                        curveness:
                            jitter * 0.09,
    
                        shadowBlur:
                            aggregateIntensity > 0.76
                                ? 8
                                : 0,
    
                        shadowColor:
                            colorWithAlpha(
                                clusterColor,
                                0.5
                            )
                    }
                });
    
                parentNodeId = clusterNodeId;
            }
    
            const positions =
                layoutGroupTransactions(
                    groupX,
                    groupY,
                    transactions,
                    hasCluster,
                    group.key
                );
    
            positions.forEach(
                (position, transactionIndex) => {
                    const transaction =
                        position.transaction;
    
                    const visual =
                        position.visual;
    
                    const transactionHash =
                        transaction.hash ||
                        `${group.key}-${transactionIndex}`;
    
                    const transactionSeed =
                        hashCode(transactionHash);
    
                    const starNodeId =
                        `transaction:${transactionHash}`;
    
                    const starNode = {
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
    
                        valueEth:
                            visual.profile.valueEth,
    
                        valuePercentile:
                            visual.profile.percentile,
    
                        valueIntensity:
                            visual.profile.intensity,
    
                        stellarClass:
                            visual.profile.stellarClass,
    
                        stellarLabel:
                            visual.profile.label,
    
                        canonicalSize:
                            visual.profile
                                .canonicalSize,
    
                        x: position.x,
                        y: position.y,
    
                        anchorX: position.x,
                        anchorY: position.y,
    
                        collisionRadius:
                            visual.size / 2,
    
                        draggable: true,
                        cursor: "pointer",
    
                        symbol: visual.symbol,
                        symbolSize: visual.size,
    
                        itemStyle: {
                            color: visual.fill,
    
                            borderColor:
                                visual.semanticColor,
    
                            borderWidth:
                                visual.borderWidth,
    
                            shadowBlur:
                                visual.shadowBlur,
    
                            shadowColor:
                                colorWithAlpha(
                                    visual.accent,
                                    0.7
                                )
                        },
    
                        label: {
                            show: false
                        },
    
                        emphasis: {
                            scale:
                                visual.profile
                                    .stellarClass ===
                                "dust"
                                    ? 2.15
                                    : (
                                        visual.profile
                                            .stellarClass ===
                                        "singularity"
                                            ? 1.08
                                            : 1.28
                                    ),
    
                            itemStyle: {
                                borderWidth:
                                    visual.borderWidth +
                                    1.1,
    
                                shadowBlur:
                                    visual.shadowBlur +
                                    20
                            }
                        }
                    };
    
                    coreNodes.push(starNode);
    
                    visualByNodeId.set(
                        starNodeId,
                        visual
                    );
    
                    links.push({
                        source: parentNodeId,
                        target: starNodeId,
    
                        linkType: "transaction",
                        transactionHash:
                            transaction.hash,
    
                        direction:
                            transaction.direction,
    
                        valueEth:
                            visual.profile.valueEth,
    
                        stellarClass:
                            visual.profile.stellarClass,
    
                        lineStyle: {
                            color:
                                visual.semanticColor,
    
                            width:
                                visual.linkWidth,
    
                            opacity:
                                visual.linkOpacity,
    
                            curveness:
                                (
                                    transactionSeed %
                                    17 -
                                    8
                                ) * 0.008,
    
                            type:
                                transaction.status ===
                                "failed"
                                    ? "dashed"
                                    : "solid",
    
                            shadowBlur:
                                visual.profile
                                    .intensity > 0.68
                                    ? (
                                        3 +
                                        visual.profile
                                            .intensity * 11
                                    )
                                    : 0,
    
                            shadowColor:
                                colorWithAlpha(
                                    visual.accent,
                                    0.55
                                )
                        }
                    });
                }
            );
        });
    
        resolveNodeCollisions(coreNodes);
    
        const nodes = [];
    
        coreNodes.forEach((node) => {
            if (
                node.nodeType ===
                "transaction"
            ) {
                const visual =
                    visualByNodeId.get(node.id);
    
                if (visual) {
                    nodes.push(
                        ...createHaloNodes(
                            node,
                            visual
                        )
                    );
                }
            }
    
            nodes.push(node);
        });
    
        state.nodeIndexByHash.clear();
    
        nodes.forEach((node, index) => {
            if (
                node.nodeType ===
                    "transaction" &&
                node.transactionHash
            ) {
                state.nodeIndexByHash.set(
                    node.transactionHash,
                    index
                );
            }
        });
    
        return {
            nodes,
            links,
            groupCount: groups.length,
    
            transactionCount:
                coreNodes.filter(
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

        if (data.nodeType === "halo") {
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
                        data.stellarLabel ||
                        "VALUE STAR"
                    )}
                    · VALUE MAGNITUDE
                    ${Math.round(
                        clamp(
                            data.valuePercentile || 0,
                            0,
                            1
                        ) * 100
                    )} / 100
                </span>

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
        stopStellarAnimations();

        const graphData =
            buildConstellationData();

        state.responsiveMaxSize =
            getMaximumRenderedStarSize();

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
                        cursor: "grab",

                        scaleLimit: {
                            min: 0.42,
                            max: 7
                        },

                        edgeSymbol: [
                            "none",
                            "circle"
                        ],

                        edgeSymbolSize: [
                            0,
                            2.8
                        ],

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
                            scale: 1.18,

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
        startStellarAnimations(graphData);

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
    
                item.dataset.transactionHash =
                    transaction.hash || "";
    
                item.tabIndex = 0;
                item.setAttribute("role", "button");
    
                item.setAttribute(
                    "aria-label",
                    `${transaction.direction} transaction, ${value.textContent}, open details`
                );
    
                item.append(
                    direction,
                    address,
                    value
                );
    
                const focusStar = () => {
                    if (transaction.hash) {
                        highlightTransactionNode(
                            transaction.hash,
                            true
                        );
                    }
                };
    
                const releaseStar = () => {
                    if (transaction.hash) {
                        highlightTransactionNode(
                            transaction.hash,
                            false
                        );
                    }
                };
    
                const openTransaction = () => {
                    showTransactionInspector(
                        transaction
                    );
    
                    focusStar();
                };
    
                item.addEventListener(
                    "mouseenter",
                    focusStar
                );
    
                item.addEventListener(
                    "mouseleave",
                    releaseStar
                );
    
                item.addEventListener(
                    "focus",
                    focusStar
                );
    
                item.addEventListener(
                    "blur",
                    releaseStar
                );
    
                item.addEventListener(
                    "click",
                    openTransaction
                );
    
                item.addEventListener(
                    "keydown",
                    (event) => {
                        if (
                            event.key !== "Enter" &&
                            event.key !== " "
                        ) {
                            return;
                        }
    
                        event.preventDefault();
                        openTransaction();
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

    function setStreamTransactionFocus(
        transactionHash,
        focused
    ) {
        document
            .querySelectorAll(
                "#transaction-stream li[data-transaction-hash]"
            )
            .forEach((item) => {
                if (
                    item.dataset.transactionHash !==
                    transactionHash
                ) {
                    return;
                }
    
                item.style.transition =
                    "opacity 160ms ease, " +
                    "transform 160ms ease, " +
                    "background-color 160ms ease";
    
                item.style.opacity =
                    focused ? "1" : "";
    
                item.style.transform =
                    focused
                        ? "translateX(-3px)"
                        : "";
    
                item.style.backgroundColor =
                    focused
                        ? "rgba(143,154,255,.08)"
                        : "";
            });
    }

    function highlightTransactionNode(
        transactionHash,
        highlighted
    ) {
        const dataIndex =
            state.nodeIndexByHash.get(
                transactionHash
            );
    
        if (
            dataIndex === undefined ||
            !state.graphChart
        ) {
            return;
        }
    
        state.graphChart.dispatchAction({
            type:
                highlighted
                    ? "highlight"
                    : "downplay",
    
            seriesIndex: 0,
            dataIndex
        });
    }

    function handleGraphMouseOver(parameters) {
        const data = parameters.data;
    
        if (
            parameters.dataType !== "node" ||
            data?.nodeType !== "transaction"
        ) {
            return;
        }
    
        setStreamTransactionFocus(
            data.transactionHash,
            true
        );
    }

    function handleGraphMouseOut(parameters) {
        const data = parameters.data;
    
        if (
            parameters.dataType !== "node" ||
            data?.nodeType !== "transaction"
        ) {
            return;
        }
    
        setStreamTransactionFocus(
            data.transactionHash,
            false
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

            state.graphChart.on(
                "mouseover",
                handleGraphMouseOver
            );

            state.graphChart.on(
                "mouseout",
                handleGraphMouseOut
            );

            state.graphChart
                .getZr()
                .on("click", (event) => {
                    if (!event.target) {
                        closeTransactionInspector();
                    }
                });
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

        const nextMaximumSize =
            getMaximumRenderedStarSize();

        if (
            state.model &&
            state.responsiveMaxSize !== null &&
            nextMaximumSize !==
                state.responsiveMaxSize
        ) {
            renderConstellation();
        }
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
        stopStellarAnimations();

        state.graphChart?.dispose();
        state.directionChart?.dispose();
        state.activityChart?.dispose();

        state.graphChart = null;
        state.directionChart = null;
        state.activityChart = null;

        state.analysis = null;
        state.model = null;

        state.transactionByHash.clear();
        state.nodeIndexByHash.clear();
        state.stellarByTransaction =
            new WeakMap();

        state.responsiveMaxSize = null;

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
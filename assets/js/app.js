/* global jQuery */

(function ($, window, document) {
    "use strict";

    const config = window.ChainTraceConfig;
    const api = window.ChainTraceApi;
    const graph = window.ChainTraceGraph;
    const space = window.ChainTraceSpace;

    const state = {
        phase: "landing",
        runId: 0,
        address: null,
        data: null,
        lastAddress: null,
        progressFrame: null,
        ageTimer: null,
        resizeTimer: null
    };

    let elements = {};

    const FLIGHT_DURATION =
        config?.UI?.MIN_WARP_DURATION ??
        config?.UI?.minWarpDuration ??
        1650;

    function cacheElements() {
        elements = {
            body: $("body"),
            siteHeader: $("#site-header"),

            landing: $("#landing-view"),
            form: $("#wallet-form"),
            input: $("#wallet-address"),
            clearAddress: $("#clear-address"),
            analyzeButton: $("#analyze-button"),
            demoButton: $("#demo-button"),
            addressError: $("#address-error"),

            flight: $("#flight-view"),
            flightTitle: $("#flight-title"),
            flightStatus: $("#flight-status"),
            flightProgress: $("#flight-progress-bar"),
            sectorCode: $("#sector-code"),

            universe: $("#universe-view"),
            backButton: $("#back-button"),

            walletShortAddress: $("#wallet-short-address"),
            dataSource: $("#data-source"),
            dataAge: $("#data-age"),
            walletExplorerLink: $("#wallet-explorer-link"),

            errorView: $("#error-view"),
            errorTitle: $("#error-title"),
            errorMessage: $("#error-message"),
            retryButton: $("#retry-button"),
            errorDemoButton: $("#error-demo-button"),

            toast: $("#toast"),
            toastMessage: $("#toast-message")
        };
    }

    function verifyDependencies() {
        const missing = [];

        if (typeof $ !== "function") {
            missing.push("jQuery");
        }

        if (!config) {
            missing.push("ChainTraceConfig");
        }

        if (!api) {
            missing.push("ChainTraceApi");
        }

        if (!graph) {
            missing.push("ChainTraceGraph");
        }

        if (!space) {
            missing.push("ChainTraceSpace");
        }

        if (missing.length > 0) {
            throw new Error(
                `ChainTrace dependencies are unavailable: ${missing.join(", ")}`
            );
        }
    }

    function wait(milliseconds) {
        return new Promise(resolve => {
            window.setTimeout(resolve, milliseconds);
        });
    }

    function nextFrame() {
        return new Promise(resolve => {
            window.requestAnimationFrame(() => {
                window.requestAnimationFrame(resolve);
            });
        });
    }

    function createError(code, message) {
        const error = new Error(message);
        error.code = code;

        return error;
    }

    function normalizeAddress(rawAddress) {
        const raw = String(rawAddress ?? "").trim();

        if (!raw) {
            throw createError(
                "INVALID_ADDRESS",
                "Enter an Ethereum wallet address."
            );
        }

        let normalized;

        try {
            normalized = api.normalizeAddress(raw);
        } catch (error) {
            throw createError(
                "INVALID_ADDRESS",
                "This does not look like a valid Ethereum address."
            );
        }

        let validationResult = true;

        try {
            validationResult = api.validateAddress(normalized);
        } catch (error) {
            validationResult = false;
        }

        if (
            validationResult === false ||
            validationResult?.valid === false ||
            !/^0x[a-fA-F0-9]{40}$/.test(normalized)
        ) {
            throw createError(
                "INVALID_ADDRESS",
                "Use a complete Ethereum address beginning with 0x."
            );
        }

        return normalized;
    }

    function getSectorCode(address) {
        if (typeof graph.getSectorCode === "function") {
            return graph.getSectorCode(address);
        }

        const clean = address.slice(2).toUpperCase();

        return `${clean.slice(0, 3)}-${clean.slice(-4)}`;
    }

    function getShortAddress(address) {
        if (typeof graph.shortAddress === "function") {
            return graph.shortAddress(address);
        }

        return `${address.slice(0, 6)}…${address.slice(-4)}`;
    }

    function setBusy(busy) {
        elements.input.prop("disabled", busy);
        elements.analyzeButton.prop("disabled", busy);
        elements.demoButton.prop("disabled", busy);
        elements.clearAddress.prop("disabled", busy);

        elements.form.attr("aria-busy", String(busy));
    }

    function setInlineError(message = "") {
        elements.addressError.text(message);
        elements.input.attr("aria-invalid", message ? "true" : "false");
    }

    function syncClearButton() {
        const hasValue = elements.input.val().trim().length > 0;

        elements.clearAddress.prop("hidden", !hasValue);
    }

    function setProgress(value) {
        const progress = Math.min(1, Math.max(0, value));

        elements.flightProgress.css(
            "transform",
            `scaleX(${progress})`
        );

        elements.flightProgress.css(
            "--flight-progress",
            `${Math.round(progress * 100)}%`
        );

        elements.flightProgress.attr(
            "aria-valuenow",
            Math.round(progress * 100)
        );
    }

    function getFlightStatus(progress) {
        if (progress < 0.16) {
            return "Resolving wallet coordinates";
        }

        if (progress < 0.36) {
            return "Reading the latest blocks";
        }

        if (progress < 0.58) {
            return "Tracing value paths";
        }

        if (progress < 0.78) {
            return "Grouping counterparties";
        }

        return "Building transaction constellation";
    }

    function stopProgress() {
        if (state.progressFrame !== null) {
            window.cancelAnimationFrame(state.progressFrame);
            state.progressFrame = null;
        }
    }

    function startProgress() {
        stopProgress();

        const startedAt = performance.now();
        let currentStatus = "";

        function update(timestamp) {
            if (state.phase !== "loading") {
                return;
            }

            const elapsed = timestamp - startedAt;
            const normalized = elapsed / Math.max(FLIGHT_DURATION, 1);

            /*
             * До завершения API-запроса прогресс может дойти только до 92%.
             * Поэтому длинный запрос не создаёт ложного ощущения завершения.
             */
            const progress = Math.min(
                0.92,
                0.04 + (1 - Math.exp(-normalized * 2.8)) * 0.9
            );

            const status = getFlightStatus(progress);

            setProgress(progress);

            if (status !== currentStatus) {
                currentStatus = status;
                elements.flightStatus.text(status);
            }

            state.progressFrame =
                window.requestAnimationFrame(update);
        }

        setProgress(0.025);

        state.progressFrame =
            window.requestAnimationFrame(update);
    }

    async function finishProgress() {
        stopProgress();

        elements.flightStatus.text(
            "Constellation synchronized"
        );

        setProgress(1);

        await wait(220);
    }

    function beginFlight(address) {
        state.phase = "loading";

        setBusy(true);
        setInlineError("");

        elements.errorView.prop("hidden", true);
        elements.universe.prop("hidden", true);
        elements.flight.prop("hidden", false);

        elements.flightTitle.text("Entering data space");
        elements.flightStatus.text("Resolving wallet coordinates");
        elements.sectorCode.text(getSectorCode(address));

        elements.siteHeader.prop("hidden", true);

        elements.body
            .attr("data-view", "flight")
            .removeClass("space-data space-arriving");

        space.launch(address);
        startProgress();
    }

    function updateAddressBar(address) {
        const url = new URL(window.location.href);

        url.searchParams.set("address", address);

        window.history.replaceState(
            {
                chainTrace: true,
                address
            },
            "",
            url
        );
    }

    function clearAddressBar() {
        const url = new URL(window.location.href);

        url.searchParams.delete("address");

        window.history.replaceState(
            {
                chainTrace: true,
                address: null
            },
            "",
            url
        );
    }

    function updateWalletHeader(data) {
        const address = data.address;
        const sourceName = data.source?.name || "Blockscout";

        elements.walletShortAddress.text(
            getShortAddress(address)
        );

        elements.walletShortAddress.attr(
            "title",
            address
        );

        elements.dataSource.text(sourceName);

        try {
            elements.walletExplorerLink.attr(
                "href",
                api.getWalletExplorerUrl(address)
            );
        } catch (error) {
            elements.walletExplorerLink.attr(
                "href",
                `https://eth.blockscout.com/address/${address}`
            );
        }

        updateDataAge(data.fetchedAt);

        window.clearInterval(state.ageTimer);

        state.ageTimer = window.setInterval(() => {
            updateDataAge(data.fetchedAt);
        }, 30_000);
    }

    function updateDataAge(fetchedAt) {
        const timestamp = new Date(fetchedAt).getTime();

        if (!Number.isFinite(timestamp)) {
            elements.dataAge.text("live");
            return;
        }

        const seconds = Math.max(
            0,
            Math.floor((Date.now() - timestamp) / 1000)
        );

        if (seconds < 15) {
            elements.dataAge.text("live · now");
            return;
        }

        if (seconds < 60) {
            elements.dataAge.text(`live · ${seconds}s ago`);
            return;
        }

        const minutes = Math.floor(seconds / 60);

        if (minutes < 60) {
            elements.dataAge.text(`cached · ${minutes}m ago`);
            return;
        }

        const hours = Math.floor(minutes / 60);

        elements.dataAge.text(`cached · ${hours}h ago`);
    }

    async function revealUniverse(data, runId) {
        elements.landing.prop("hidden", true);
        elements.universe.prop("hidden", false);

        updateWalletHeader(data);

        await nextFrame();

        if (runId !== state.runId) {
            return;
        }

        const renderResult = graph.render(data);

        if (runId !== state.runId) {
            return;
        }

        state.data = data;
        state.phase = "universe";

        space.arrive(data.address);

        elements.body.attr("data-view", "universe");
        elements.universe.attr("aria-hidden", "false");

        document.title =
            `${getShortAddress(data.address)} — ChainTrace`;

        updateAddressBar(data.address);
        setBusy(false);

        await wait(620);

        if (runId === state.runId) {
            elements.flight.prop("hidden", true);
        }

        return renderResult;
    }

    function getErrorPresentation(error) {
        const code = String(
            error?.code || error?.status || ""
        ).toUpperCase();

        if (code.includes("INVALID")) {
            return {
                title: "Invalid coordinates",
                message:
                    "The entered value is not a complete Ethereum wallet address."
            };
        }

        if (
            code.includes("429") ||
            code.includes("RATE")
        ) {
            return {
                title: "Data source is busy",
                message:
                    "Blockscout temporarily limited the request. Wait a moment and try again."
            };
        }

        if (
            code.includes("403") ||
            code.includes("FORBIDDEN")
        ) {
            return {
                title: "Access was declined",
                message:
                    "The public data source rejected this request. Retry or open the demo constellation."
            };
        }

        if (
            code.includes("TIMEOUT") ||
            code.includes("ETIMEDOUT")
        ) {
            return {
                title: "Signal timed out",
                message:
                    "The blockchain data source responded too slowly. The wallet can be retried safely."
            };
        }

        if (
            code.includes("NETWORK") ||
            code.includes("CORS") ||
            code === "0"
        ) {
            return {
                title: "Signal unavailable",
                message:
                    "ChainTrace could not reach Blockscout. Check the connection and retry."
            };
        }

        return {
            title: "Constellation unavailable",
            message:
                error?.message ||
                "The wallet data could not be visualized."
        };
    }

    function showFailure(error, runId) {
        if (runId !== state.runId) {
            return;
        }

        stopProgress();

        state.phase = "error";

        const presentation = getErrorPresentation(error);

        try {
            graph.dispose();
        } catch (disposeError) {
            // The graph may not have been created yet.
        }

        space.reset();

        elements.flight.prop("hidden", true);
        elements.universe.prop("hidden", true);
        elements.landing.prop("hidden", true);
        elements.errorView.prop("hidden", false);
        elements.siteHeader.prop("hidden", false);

        elements.errorTitle.text(presentation.title);
        elements.errorMessage.text(presentation.message);

        elements.body
            .attr("data-view", "error")
            .removeClass(
                "space-warping space-arriving space-data"
            );

        setBusy(false);

        document.title = "Signal unavailable — ChainTrace";
    }

    async function analyze(rawAddress) {
        let address;

        try {
            address = normalizeAddress(rawAddress);
        } catch (error) {
            setInlineError(error.message);
            elements.input.trigger("focus");
            return;
        }

        const runId = ++state.runId;

        state.address = address;
        state.lastAddress = address;
        state.data = null;

        elements.input.val(address);
        syncClearButton();

        /*
         * Если предыдущий запрос ещё жив, он больше не должен
         * влиять на интерфейс.
         */
        try {
            api.cancelAllRequests();
        } catch (error) {
            // There may be no active request.
        }

        beginFlight(address);

        const startedAt = performance.now();

        try {
            const data = await api.getWalletAnalysis(address);

            if (runId !== state.runId) {
                return;
            }

            const elapsed = performance.now() - startedAt;
            const remainingFlight = Math.max(
                0,
                FLIGHT_DURATION - elapsed
            );

            if (remainingFlight > 0) {
                await wait(remainingFlight);
            }

            if (runId !== state.runId) {
                return;
            }

            await finishProgress();

            if (runId !== state.runId) {
                return;
            }

            await revealUniverse(data, runId);
        } catch (error) {
            if (runId !== state.runId) {
                return;
            }

            const code = String(error?.code || "").toUpperCase();

            if (code.includes("ABORT")) {
                return;
            }

            showFailure(error, runId);
        }
    }

    function resetToLanding(options = {}) {
        ++state.runId;

        stopProgress();
        window.clearInterval(state.ageTimer);

        try {
            api.cancelAllRequests();
        } catch (error) {
            // There may be no active request.
        }

        try {
            graph.dispose();
        } catch (error) {
            // The graph may already be disposed.
        }

        space.reset();

        state.phase = "landing";
        state.address = null;
        state.data = null;

        elements.flight.prop("hidden", true);
        elements.universe.prop("hidden", true);
        elements.errorView.prop("hidden", true);
        elements.landing.prop("hidden", false);
        elements.siteHeader.prop("hidden", false);

        elements.universe.attr("aria-hidden", "true");

        elements.body
            .attr("data-view", "landing")
            .removeClass(
                "space-warping space-arriving space-data"
            );

        setBusy(false);
        setInlineError("");
        setProgress(0);

        document.title = "ChainTrace — Ethereum data space";

        if (options.clearUrl !== false) {
            clearAddressBar();
        }

        window.requestAnimationFrame(() => {
            elements.input.trigger("focus");
        });
    }

    function showToast(message) {
        if (!elements.toast.length) {
            return;
        }

        elements.toastMessage.text(message);
        elements.toast.prop("hidden", false);
        elements.toast.addClass("is-visible");

        window.clearTimeout(showToast.timer);

        showToast.timer = window.setTimeout(() => {
            elements.toast.removeClass("is-visible");

            window.setTimeout(() => {
                elements.toast.prop("hidden", true);
            }, 250);
        }, 2200);
    }

    function bindEvents() {
        elements.form.on("submit", function (event) {
            event.preventDefault();

            if (state.phase === "loading") {
                return;
            }

            analyze(elements.input.val());
        });

        elements.input.on("input", function () {
            setInlineError("");
            syncClearButton();
        });

        elements.input.on("keydown", function (event) {
            if (event.key === "Escape") {
                elements.input.val("");
                syncClearButton();
                setInlineError("");
            }
        });

        elements.clearAddress.on("click", function (event) {
            event.preventDefault();

            elements.input.val("");
            setInlineError("");
            syncClearButton();
            elements.input.trigger("focus");
        });

        elements.demoButton.on("click", function (event) {
            event.preventDefault();

            elements.input.val(config.DEMO.address);
            syncClearButton();

            analyze(config.DEMO.address);
        });

        elements.errorDemoButton.on("click", function (event) {
            event.preventDefault();

            elements.input.val(config.DEMO.address);
            syncClearButton();

            analyze(config.DEMO.address);
        });

        elements.retryButton.on("click", function (event) {
            event.preventDefault();

            if (state.lastAddress) {
                analyze(state.lastAddress);
                return;
            }

            resetToLanding();
        });

        elements.backButton.on("click", function (event) {
            event.preventDefault();
            resetToLanding();
        });

        $(document).on("keydown", function (event) {
            if (event.key !== "Escape") {
                return;
            }

            if (state.phase === "universe") {
                graph.closeTransactionInspector();
            }
        });

        $(window).on("resize", function () {
            window.clearTimeout(state.resizeTimer);

            state.resizeTimer = window.setTimeout(() => {
                if (state.phase === "universe") {
                    graph.resize();
                }
            }, 100);
        });

        $(window).on("popstate", function () {
            const url = new URL(window.location.href);
            const address = url.searchParams.get("address");

            if (address) {
                elements.input.val(address);
                syncClearButton();
                analyze(address);
                return;
            }

            resetToLanding({
                clearUrl: false
            });
        });
    }

    function openAddressFromUrl() {
        const url = new URL(window.location.href);
        const address = url.searchParams.get("address");

        if (!address) {
            return;
        }

        elements.input.val(address);
        syncClearButton();

        window.setTimeout(() => {
            analyze(address);
        }, 180);
    }

    function boot() {
        cacheElements();

        try {
            verifyDependencies();
        } catch (error) {
            console.error(error);
            return;
        }

        bindEvents();

        elements.flight.prop("hidden", true);
        elements.universe.prop("hidden", true);
        elements.errorView.prop("hidden", true);
        elements.landing.prop("hidden", false);
        elements.siteHeader.prop("hidden", false);

        elements.body.attr("data-view", "landing");

        setBusy(false);
        setProgress(0);
        syncClearButton();

        openAddressFromUrl();
    }

    window.ChainTraceApp = Object.freeze({
        analyze,
        reset: resetToLanding,
        showToast,

        getState() {
            return {
                phase: state.phase,
                address: state.address,
                hasData: Boolean(state.data)
            };
        }
    });

    $(boot);
})(window.jQuery, window, document);
(function (window, document) {
    "use strict";

    const canvas = document.getElementById("ambient-canvas");

    if (!canvas) {
        return;
    }

    const context = canvas.getContext("2d", {
        alpha: true,
        desynchronized: true
    });

    if (!context) {
        return;
    }

    const reducedMotionQuery = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
    );

    const FRAME_INTERVAL = 1000 / 30;
    const MAX_DPR = 1.5;

    const state = {
        width: 0,
        height: 0,
        dpr: 1,

        stars: [],
        connections: [],

        seed: hashString(String(Date.now())),
        destinationSeed: null,

        velocity: 0.008,
        targetVelocity: 0.008,

        warp: 0,
        targetWarp: 0,

        centerX: 0.5,
        centerY: 0.5,
        targetCenterX: 0.5,
        targetCenterY: 0.5,

        pointerX: 0,
        pointerY: 0,
        renderedPointerX: 0,
        renderedPointerY: 0,

        mode: "idle",
        isLight: false,
        isVisible: true,
        destroyed: false
    };

    const palette = {
        dark: {
            primary: [211, 220, 255],
            accent: [137, 149, 255],
            secondary: [113, 191, 224],
            incoming: [77, 214, 168],
            line: [132, 145, 199]
        },

        light: {
            primary: [44, 53, 78],
            accent: [88, 105, 232],
            secondary: [48, 126, 168],
            incoming: [21, 155, 115],
            line: [76, 89, 132]
        }
    };

    let animationFrameId = 0;
    let previousFrameTime = 0;
    let resizeTimer = 0;
    let arrivalTimer = 0;
    let random = mulberry32(state.seed);

    function clamp(value, minimum, maximum) {
        return Math.min(Math.max(value, minimum), maximum);
    }

    function lerp(current, target, amount) {
        return current + (target - current) * amount;
    }

    function hashString(value) {
        let hash = 2166136261;

        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }

        return hash >>> 0;
    }

    function mulberry32(seed) {
        return function () {
            let value = seed += 0x6D2B79F5;

            value = Math.imul(value ^ value >>> 15, value | 1);
            value ^= value + Math.imul(value ^ value >>> 7, value | 61);

            return ((value ^ value >>> 14) >>> 0) / 4294967296;
        };
    }

    function getWorldBounds() {
        const minimumDimension = Math.max(
            1,
            Math.min(state.width, state.height)
        );

        return {
            x: (state.width / minimumDimension) * 1.12,
            y: (state.height / minimumDimension) * 1.12
        };
    }

    function chooseTone(rng, isConstellation) {
        const chance = rng();

        if (isConstellation && chance > 0.66) {
            return "accent";
        }

        if (chance > 0.965) {
            return "incoming";
        }

        if (chance > 0.89) {
            return "secondary";
        }

        if (chance > 0.81) {
            return "accent";
        }

        return "primary";
    }

    function createStar(rng, options) {
        const settings = options || {};
        const bounds = getWorldBounds();
        const isConstellation = Boolean(settings.isConstellation);

        return {
            x: settings.x ?? ((rng() * 2 - 1) * bounds.x),
            y: settings.y ?? ((rng() * 2 - 1) * bounds.y),
            z: settings.z ?? (0.24 + rng() * 1.18),

            radius:
                settings.radius ??
                (
                    isConstellation
                        ? 0.72 + rng() * 0.72
                        : 0.28 + rng() * 0.72
                ),

            alpha:
                settings.alpha ??
                (
                    isConstellation
                        ? 0.3 + rng() * 0.32
                        : 0.12 + rng() * 0.43
                ),

            phase: rng() * Math.PI * 2,
            twinkleSpeed: 0.35 + rng() * 0.9,

            tone:
                settings.tone ??
                chooseTone(rng, isConstellation),

            isConstellation,
            hasGlow:
                isConstellation
                    ? rng() > 0.48
                    : rng() > 0.91
        };
    }

    function buildStarField(seed) {
        random = mulberry32(seed);

        state.stars = [];
        state.connections = [];

        const pixelArea = state.width * state.height;

        const ordinaryStarCount = Math.round(
            clamp(pixelArea / 17000, 52, 122)
        );

        for (let index = 0; index < ordinaryStarCount; index += 1) {
            state.stars.push(createStar(random));
        }

        const constellationCount =
            state.width < 600
                ? 2
                : state.width < 1000
                    ? 3
                    : 4;

        const bounds = getWorldBounds();

        for (
            let constellationIndex = 0;
            constellationIndex < constellationCount;
            constellationIndex += 1
        ) {
            const pointCount = 4 + Math.floor(random() * 3);

            const centerX =
                (random() * 2 - 1) *
                bounds.x *
                0.68;

            const centerY =
                (random() * 2 - 1) *
                bounds.y *
                0.64;

            const centerZ = 0.52 + random() * 0.48;
            const pointIndexes = [];

            for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
                const angle =
                    random() * Math.PI * 2 +
                    pointIndex * 0.58;

                const distance =
                    0.035 +
                    random() * 0.105;

                const starIndex = state.stars.length;

                state.stars.push(
                    createStar(random, {
                        x:
                            centerX +
                            Math.cos(angle) * distance,
                        y:
                            centerY +
                            Math.sin(angle) * distance,
                        z:
                            centerZ +
                            (random() - 0.5) * 0.025,
                        isConstellation: true
                    })
                );

                pointIndexes.push(starIndex);
            }

            for (
                let pointIndex = 1;
                pointIndex < pointIndexes.length;
                pointIndex += 1
            ) {
                state.connections.push([
                    pointIndexes[pointIndex - 1],
                    pointIndexes[pointIndex]
                ]);
            }

            if (pointIndexes.length >= 5 && random() > 0.35) {
                state.connections.push([
                    pointIndexes[1],
                    pointIndexes[pointIndexes.length - 1]
                ]);
            }
        }
    }

    function resetStar(star) {
        const bounds = getWorldBounds();

        star.x = (random() * 2 - 1) * bounds.x;
        star.y = (random() * 2 - 1) * bounds.y;
        star.z = 1.28 + random() * 0.24;
        star.phase = random() * Math.PI * 2;
    }

    function getPalette() {
        return state.isLight
            ? palette.light
            : palette.dark;
    }

    function rgba(color, alpha) {
        return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
    }

    function projectStar(star, timestamp) {
        const minimumDimension = Math.min(
            state.width,
            state.height
        );

        const focalLength = minimumDimension * 0.61;

        const pointerOffsetX =
            state.renderedPointerX * 9;

        const pointerOffsetY =
            state.renderedPointerY * 7;

        const centerX =
            state.width * state.centerX +
            pointerOffsetX;

        const centerY =
            state.height * state.centerY +
            pointerOffsetY;

        const safeZ = Math.max(star.z, 0.075);
        const scale = focalLength / safeZ;

        const x = centerX + star.x * scale;
        const y = centerY + star.y * scale;

        const depthIntensity = clamp(
            1.2 - safeZ * 0.46,
            0.35,
            1
        );

        const twinkle =
            0.78 +
            Math.sin(
                timestamp * 0.001 * star.twinkleSpeed +
                star.phase
            ) * 0.22;

        const radius = clamp(
            star.radius * (1.02 / safeZ),
            0.3,
            star.isConstellation ? 2.2 : 1.65
        );

        const alpha = clamp(
            star.alpha *
            depthIntensity *
            twinkle *
            (1 + state.warp * 0.12),
            0.03,
            0.82
        );

        return {
            x,
            y,
            radius,
            alpha,
            visible:
                x > -40 &&
                x < state.width + 40 &&
                y > -40 &&
                y < state.height + 40
        };
    }

    function drawConnections(positions) {
        if (state.warp > 0.74) {
            return;
        }

        const colors = getPalette();
        const visibility = 1 - state.warp;

        context.lineWidth = 0.55;

        for (const connection of state.connections) {
            const from = positions[connection[0]];
            const to = positions[connection[1]];

            if (
                !from ||
                !to ||
                !from.visible ||
                !to.visible
            ) {
                continue;
            }

            const distance = Math.hypot(
                to.x - from.x,
                to.y - from.y
            );

            if (distance > 220) {
                continue;
            }

            const alpha =
                clamp(
                    0.065 * (1 - distance / 250),
                    0.012,
                    0.055
                ) *
                visibility;

            context.beginPath();
            context.moveTo(from.x, from.y);
            context.lineTo(to.x, to.y);
            context.strokeStyle = rgba(colors.line, alpha);
            context.stroke();
        }
    }

    function drawWarpTrail(star, position, deltaTime) {
        if (
            state.warp < 0.08 ||
            !position.visible
        ) {
            return;
        }

        const minimumDimension = Math.min(
            state.width,
            state.height
        );

        const focalLength = minimumDimension * 0.61;
        const previousZ = Math.max(
            star.z + state.velocity * deltaTime * 3.2,
            0.08
        );

        const centerX =
            state.width * state.centerX +
            state.renderedPointerX * 9;

        const centerY =
            state.height * state.centerY +
            state.renderedPointerY * 7;

        const previousX =
            centerX +
            star.x * (focalLength / previousZ);

        const previousY =
            centerY +
            star.y * (focalLength / previousZ);

        const colors = getPalette();
        const color = colors[star.tone] || colors.primary;

        context.beginPath();
        context.moveTo(previousX, previousY);
        context.lineTo(position.x, position.y);

        context.strokeStyle = rgba(
            color,
            position.alpha * state.warp * 0.28
        );

        context.lineWidth = clamp(
            position.radius * 0.48,
            0.35,
            0.85
        );

        context.stroke();
    }

    function drawStar(star, position) {
        if (!position.visible) {
            return;
        }

        const colors = getPalette();
        const color = colors[star.tone] || colors.primary;

        if (star.hasGlow && position.alpha > 0.22) {
            context.beginPath();

            context.arc(
                position.x,
                position.y,
                position.radius * 3.8,
                0,
                Math.PI * 2
            );

            context.fillStyle = rgba(
                color,
                position.alpha * 0.055
            );

            context.fill();
        }

        context.beginPath();

        context.arc(
            position.x,
            position.y,
            position.radius,
            0,
            Math.PI * 2
        );

        context.fillStyle = rgba(
            color,
            position.alpha
        );

        context.fill();
    }

    function update(deltaTime) {
        const velocitySmoothing =
            1 - Math.exp(-3.5 * deltaTime);

        const warpSmoothing =
            1 - Math.exp(-4.2 * deltaTime);

        const centerSmoothing =
            1 - Math.exp(-1.65 * deltaTime);

        const pointerSmoothing =
            1 - Math.exp(-3.2 * deltaTime);

        state.velocity = lerp(
            state.velocity,
            state.targetVelocity,
            velocitySmoothing
        );

        state.warp = lerp(
            state.warp,
            state.targetWarp,
            warpSmoothing
        );

        state.centerX = lerp(
            state.centerX,
            state.targetCenterX,
            centerSmoothing
        );

        state.centerY = lerp(
            state.centerY,
            state.targetCenterY,
            centerSmoothing
        );

        state.renderedPointerX = lerp(
            state.renderedPointerX,
            state.pointerX,
            pointerSmoothing
        );

        state.renderedPointerY = lerp(
            state.renderedPointerY,
            state.pointerY,
            pointerSmoothing
        );

        for (const star of state.stars) {
            star.z -= state.velocity * deltaTime;

            if (star.z <= 0.07) {
                resetStar(star);
            }
        }
    }

    function render(timestamp, deltaTime) {
        context.clearRect(
            0,
            0,
            state.width,
            state.height
        );

        const positions = state.stars.map(
            (star) => projectStar(star, timestamp)
        );

        drawConnections(positions);

        for (
            let index = 0;
            index < state.stars.length;
            index += 1
        ) {
            const star = state.stars[index];
            const position = positions[index];

            drawWarpTrail(star, position, deltaTime);
            drawStar(star, position);
        }
    }

    function animationLoop(timestamp) {
        if (state.destroyed) {
            return;
        }

        animationFrameId = window.requestAnimationFrame(
            animationLoop
        );

        if (
            !state.isVisible ||
            reducedMotionQuery.matches
        ) {
            return;
        }

        if (
            previousFrameTime &&
            timestamp - previousFrameTime < FRAME_INTERVAL
        ) {
            return;
        }

        const deltaTime = previousFrameTime
            ? clamp(
                (timestamp - previousFrameTime) / 1000,
                0.001,
                0.05
            )
            : 1 / 30;

        previousFrameTime = timestamp;

        update(deltaTime);
        render(timestamp, deltaTime);
    }

    function resizeCanvas() {
        state.width = window.innerWidth;
        state.height = window.innerHeight;
        state.dpr = Math.min(
            window.devicePixelRatio || 1,
            MAX_DPR
        );

        canvas.width = Math.round(
            state.width * state.dpr
        );

        canvas.height = Math.round(
            state.height * state.dpr
        );

        canvas.style.width = `${state.width}px`;
        canvas.style.height = `${state.height}px`;

        context.setTransform(
            state.dpr,
            0,
            0,
            state.dpr,
            0,
            0
        );

        buildStarField(
            state.destinationSeed || state.seed
        );

        render(performance.now(), 0);
    }

    function onResize() {
        window.clearTimeout(resizeTimer);

        resizeTimer = window.setTimeout(
            resizeCanvas,
            120
        );
    }

    function onPointerMove(event) {
        if (event.pointerType === "touch") {
            return;
        }

        state.pointerX = clamp(
            event.clientX / state.width - 0.5,
            -0.5,
            0.5
        );

        state.pointerY = clamp(
            event.clientY / state.height - 0.5,
            -0.5,
            0.5
        );
    }

    function onPointerLeave() {
        state.pointerX = 0;
        state.pointerY = 0;
    }

    function onVisibilityChange() {
        state.isVisible = !document.hidden;
        previousFrameTime = 0;

        if (state.isVisible && reducedMotionQuery.matches) {
            render(performance.now(), 0);
        }
    }

    function updateTheme() {
        state.isLight =
            document.documentElement.dataset.theme === "light";

        if (reducedMotionQuery.matches) {
            render(performance.now(), 0);
        }
    }

    function onReducedMotionChange() {
        previousFrameTime = 0;

        if (reducedMotionQuery.matches) {
            state.velocity = 0;
            state.targetVelocity = 0;
            state.warp = 0;
            state.targetWarp = 0;

            render(performance.now(), 0);
        } else {
            state.targetVelocity = 0.008;
        }
    }

    function launch(destinationKey) {
        window.clearTimeout(arrivalTimer);

        const entropy = [
            destinationKey || "unknown",
            Date.now(),
            Math.random()
        ].join(":");

        state.destinationSeed = hashString(entropy);

        const destinationRandom = mulberry32(
            state.destinationSeed
        );

        state.mode = "warp";
        state.targetVelocity = reducedMotionQuery.matches
            ? 0
            : 0.92;

        state.targetWarp = reducedMotionQuery.matches
            ? 0
            : 1;

        state.targetCenterX =
            0.38 + destinationRandom() * 0.24;

        state.targetCenterY =
            0.39 + destinationRandom() * 0.22;

        document.body.classList.add("space-warping");
        document.body.classList.remove(
            "space-arriving",
            "space-data"
        );

        if (reducedMotionQuery.matches) {
            buildStarField(state.destinationSeed);
            render(performance.now(), 0);
        }
    }

    function arrive(destinationKey) {
        window.clearTimeout(arrivalTimer);

        if (!state.destinationSeed) {
            state.destinationSeed = hashString(
                destinationKey || String(Date.now())
            );
        }

        buildStarField(state.destinationSeed);

        const destinationRandom = mulberry32(
            state.destinationSeed
        );

        state.mode = "arriving";

        state.velocity = reducedMotionQuery.matches
            ? 0
            : Math.max(state.velocity, 0.24);

        state.targetVelocity = reducedMotionQuery.matches
            ? 0
            : 0.008;

        state.targetWarp = 0;

        state.targetCenterX =
            0.48 + destinationRandom() * 0.04;

        state.targetCenterY =
            0.48 + destinationRandom() * 0.04;

        document.body.classList.remove("space-warping");
        document.body.classList.add("space-arriving");

        arrivalTimer = window.setTimeout(() => {
            state.mode = "data";

            document.body.classList.remove("space-arriving");
            document.body.classList.add("space-data");
        }, 900);

        if (reducedMotionQuery.matches) {
            render(performance.now(), 0);
        }
    }

    function reset() {
        window.clearTimeout(arrivalTimer);

        state.seed = hashString(
            `${Date.now()}:${Math.random()}`
        );

        state.destinationSeed = null;
        state.mode = "idle";

        state.velocity = reducedMotionQuery.matches
            ? 0
            : 0.008;

        state.targetVelocity = state.velocity;
        state.warp = 0;
        state.targetWarp = 0;

        state.centerX = 0.5;
        state.centerY = 0.5;
        state.targetCenterX = 0.5;
        state.targetCenterY = 0.5;

        buildStarField(state.seed);

        document.body.classList.remove(
            "space-warping",
            "space-arriving",
            "space-data"
        );

        render(performance.now(), 0);
    }

    function destroy() {
        state.destroyed = true;

        window.cancelAnimationFrame(animationFrameId);
        window.clearTimeout(resizeTimer);
        window.clearTimeout(arrivalTimer);

        window.removeEventListener("resize", onResize);
        window.removeEventListener(
            "pointermove",
            onPointerMove
        );

        document.documentElement.removeEventListener(
            "pointerleave",
            onPointerLeave
        );

        document.removeEventListener(
            "visibilitychange",
            onVisibilityChange
        );

        themeObserver.disconnect();
    }

    const themeObserver = new MutationObserver(
        updateTheme
    );

    themeObserver.observe(
        document.documentElement,
        {
            attributes: true,
            attributeFilter: ["data-theme"]
        }
    );

    window.addEventListener(
        "resize",
        onResize,
        { passive: true }
    );

    window.addEventListener(
        "pointermove",
        onPointerMove,
        { passive: true }
    );

    document.documentElement.addEventListener(
        "pointerleave",
        onPointerLeave
    );

    document.addEventListener(
        "visibilitychange",
        onVisibilityChange
    );

    if (typeof reducedMotionQuery.addEventListener === "function") {
        reducedMotionQuery.addEventListener(
            "change",
            onReducedMotionChange
        );
    }

    updateTheme();
    resizeCanvas();

    animationFrameId = window.requestAnimationFrame(
        animationLoop
    );

    window.ChainTraceSpace = Object.freeze({
        launch,
        arrive,
        reset,
        destroy
    });
})(window, document);
/**
 * Coordinates persistent local track overrides with the main-process isolated
 * audio player. SoundCloud remains responsible for queue state and metadata,
 * while Electron mutes the entire SoundCloud view during an override.
 */
export const trackOverrideScript = `
(function() {
    if (window.__soundcloudTrackOverridesLoaded) return;
    window.__soundcloudTrackOverridesLoaded = true;

    let currentTrackUrl = '';
    let overrideActive = false;
    let overrideFileName = '';
    let activationToken = 0;
    let handledEndedToken = -1;

    let overrideVolume = 1;
    let lastNonZeroVolume = 1;
    let draggingVolume = false;

    let localPosition = 0;
    let localDuration = 0;
    let localIsPlaying = false;

    const sourceLoopStates = new Map();

    let indicatorRefreshTimer = null;
    let indicatorGeneration = 0;

    function normalizeUrl(value) {
        if (!value) return '';

        try {
            const parsed = new URL(value, window.location.origin);
            parsed.search = '';
            parsed.hash = '';
            return parsed.origin + parsed.pathname.replace(/\\/+$/, '');
        } catch (_) {
            return String(value).split('?')[0].split('#')[0].replace(/\\/+$/, '');
        }
    }

    function getCurrentTrackUrl() {
        const link = document.querySelector('.playbackSoundBadge__titleLink');
        return normalizeUrl(link && link.href ? link.href : '');
    }

    function isTrackPageUrl(value) {
        if (!value) return false;

        try {
            const parsed = new URL(value, window.location.origin);
            if (parsed.hostname !== 'soundcloud.com' && parsed.hostname !== 'www.soundcloud.com') {
                return false;
            }

            const segments = parsed.pathname.split('/').filter(Boolean);
            if (segments.length < 2) return false;

            const nonTrackRoots = new Set([
                'discover',
                'stream',
                'you',
                'search',
                'charts',
                'upload',
                'settings',
                'messages',
                'notifications',
            ]);

            if (nonTrackRoots.has(segments[0].toLowerCase())) return false;
            if (segments[1].toLowerCase() === 'sets') return false;

            return true;
        } catch (_) {
            return false;
        }
    }

    function isSoundCloudPlaying() {
        const playButton = document.querySelector('.playControls__play');
        return Boolean(playButton && playButton.classList.contains('playing'));
    }

    function parseTime(value) {
        if (!value) return 0;

        return String(value)
            .split(':')
            .map(part => Number(part) || 0)
            .reduce((total, part) => total * 60 + part, 0);
    }

    function formatTime(seconds) {
        let value = Math.max(0, Math.floor(Number(seconds) || 0));
        const hours = Math.floor(value / 3600);
        value %= 3600;
        const minutes = Math.floor(value / 60);
        const secs = value % 60;

        if (hours > 0) {
            return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
        }

        return minutes + ':' + String(secs).padStart(2, '0');
    }

    function getSoundCloudPosition() {
        const elapsed = document.querySelector('.playbackTimeline__timePassed span:last-child');
        return parseTime(elapsed ? elapsed.textContent : '');
    }

    function clampVolume(value) {
        return Math.max(0, Math.min(1, Number(value) || 0));
    }

    function getVolumeRoot() {
        return (
            document.querySelector('.playControls__volume .volume') ||
            document.querySelector('.playControls__volume') ||
            document.querySelector('.volume')
        );
    }

    function readVolumeFromDom() {
        const root = getVolumeRoot();
        if (!root) return null;

        const rootClass = String(root.className || '').toLowerCase();
        const button = root.querySelector('button');
        const buttonLabel = String(
            (button && button.getAttribute('aria-label')) ||
            (button && button.getAttribute('title')) ||
            ''
        ).toLowerCase();

        if (
            rootClass.includes('muted') ||
            root.getAttribute('data-level') === '0' ||
            buttonLabel.includes('unmute')
        ) {
            return 0;
        }

        const range =
            root.querySelector('[role="slider"]') ||
            root.querySelector('input[type="range"]');

        if (range) {
            const now = Number(range.getAttribute('aria-valuenow') || range.value);
            const min = Number(range.getAttribute('aria-valuemin') || range.min || 0);
            const max = Number(range.getAttribute('aria-valuemax') || range.max || 100);

            if (Number.isFinite(now) && Number.isFinite(min) && Number.isFinite(max) && max > min) {
                return clampVolume((now - min) / (max - min));
            }
        }

        const progress = root.querySelector('.volume__sliderProgress');
        if (progress) {
            const inlineHeight = String(progress.style.height || '').trim();
            if (inlineHeight.endsWith('%')) {
                const percent = Number.parseFloat(inlineHeight);
                if (Number.isFinite(percent)) {
                    return clampVolume(percent / 100);
                }
            }
        }

        const background = root.querySelector('.volume__sliderBackground');
        if (progress && background) {
            const progressRect = progress.getBoundingClientRect();
            const backgroundRect = background.getBoundingClientRect();

            if (backgroundRect.height > 0 && progressRect.height >= 0) {
                const ratio = progressRect.height / backgroundRect.height;
                if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1.05) {
                    return clampVolume(ratio);
                }
            }
        }

        return null;
    }

    function setOverrideVolume(value) {
        const next = clampVolume(value);
        overrideVolume = next;
        if (next > 0.001) {
            lastNonZeroVolume = next;
        }
    }

    function refreshVolumeFromDom() {
        const value = readVolumeFromDom();
        if (value !== null) {
            setOverrideVolume(value);
        }
    }

    function setVolumeFromPointer(event) {
        const root = getVolumeRoot();
        if (!root) return false;

        const target = event.target instanceof Element ? event.target : null;
        if (!target || !target.closest('.volume, .playControls__volume')) {
            return false;
        }

        const slider =
            root.querySelector('.volume__sliderBackground') ||
            root.querySelector('.volume__sliderWrapper') ||
            root.querySelector('[role="slider"]');

        if (!slider) return false;

        const rect = slider.getBoundingClientRect();
        if (rect.height <= 4 || !Number.isFinite(event.clientY)) return false;

        setOverrideVolume(1 - (event.clientY - rect.top) / rect.height);
        return true;
    }

    document.addEventListener('pointerdown', event => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !target.closest('.volume, .playControls__volume')) return;

        draggingVolume = setVolumeFromPointer(event);

        if (!draggingVolume) {
            const volumeBefore = overrideVolume;
            setTimeout(() => {
                const value = readVolumeFromDom();
                if (value !== null) {
                    setOverrideVolume(value);
                } else {
                    setOverrideVolume(volumeBefore <= 0.001 ? lastNonZeroVolume : 0);
                }
            }, 0);
        }
    }, true);

    document.addEventListener('pointermove', event => {
        if (draggingVolume) {
            setVolumeFromPointer(event);
        }
    }, true);

    document.addEventListener('pointerup', () => {
        if (!draggingVolume) return;
        draggingVolume = false;
        setTimeout(refreshVolumeFromDom, 0);
    }, true);

    document.addEventListener('keydown', event => {
        const target = event.target instanceof Element ? event.target : null;
        if (target && target.closest('.volume, .playControls__volume')) {
            setTimeout(refreshVolumeFromDom, 0);
        }
    }, true);

    function protectSoundCloudFromEnding() {
        if (!overrideActive) return;

        const audios = Array.from(document.querySelectorAll('audio'));
        for (const audio of audios) {
            if (!sourceLoopStates.has(audio)) {
                sourceLoopStates.set(audio, Boolean(audio.loop));
            }

            audio.loop = true;
        }
    }

    function restoreSoundCloudLoopState() {
        for (const [audio, originalLoop] of sourceLoopStates.entries()) {
            try {
                audio.loop = originalLoop;
            } catch (_) {}
        }

        sourceLoopStates.clear();
    }

    function syncGlobalOverrideState() {
        window.__soundcloudLocalOverrideState = {
            active: overrideActive,
            trackUrl: currentTrackUrl,
            fileName: overrideFileName,
            position: localPosition,
            duration: localDuration,
            isPlaying: localIsPlaying,
            volume: overrideVolume,
        };
    }

    function renderLocalTime() {
        if (!overrideActive || localDuration <= 0) return;

        const elapsed = document.querySelector('.playbackTimeline__timePassed span:last-child');
        const duration = document.querySelector('.playbackTimeline__duration span:last-child');

        if (elapsed) elapsed.textContent = formatTime(localPosition);
        if (duration) duration.textContent = formatTime(localDuration);
    }

    function currentOverrideState() {
        return {
            position: getSoundCloudPosition(),
            volume: overrideVolume,
            isPlaying: isSoundCloudPlaying(),
        };
    }

    function getRepeatMode() {
        const repeat = document.querySelector('.repeatControl');
        if (!repeat) return 'none';

        const classes = String(repeat.className || '');
        const label = String(
            repeat.getAttribute('aria-label') ||
            repeat.getAttribute('title') ||
            ''
        ).toLowerCase();

        if (classes.includes('m-one') || label.includes('repeat one')) {
            return 'one';
        }

        if (classes.includes('m-all') || classes.includes('m-active') || label.includes('repeat all')) {
            return 'all';
        }

        return 'none';
    }

    async function restartCurrentOverride() {
        if (!overrideActive || !currentTrackUrl) return;

        const audios = Array.from(document.querySelectorAll('audio'));
        for (const audio of audios) {
            try {
                audio.currentTime = 0;
            } catch (_) {}
        }

        localPosition = 0;
        handledEndedToken = -1;

        const result = await window.soundcloudAPI.startTrackOverride(
            currentTrackUrl,
            {
                position: 0,
                volume: overrideVolume,
                isPlaying: true,
            }
        );

        overrideActive = Boolean(result && result.active);
        overrideFileName = (result && result.fileName) || overrideFileName;
        syncGlobalOverrideState();
        scheduleIndicatorRefresh();
    }

    function advanceAfterLocalEnd() {
        if (!overrideActive) return;

        if (getRepeatMode() === 'one') {
            restartCurrentOverride().catch(error => {
                console.error('[SoundCloud] Failed to repeat local override:', error);
            });
            return;
        }

        const nextButton = document.querySelector('.skipControl__next');
        if (nextButton) {
            nextButton.click();
            return;
        }

        overrideActive = false;
        overrideFileName = '';
        restoreSoundCloudLoopState();
        window.soundcloudAPI.stopTrackOverride();
        syncGlobalOverrideState();
        scheduleIndicatorRefresh();
    }

    async function activateOverride(trackUrl) {
        const normalized = normalizeUrl(trackUrl);
        const myToken = ++activationToken;

        restoreSoundCloudLoopState();

        currentTrackUrl = normalized;
        localPosition = 0;
        localDuration = 0;
        localIsPlaying = false;
        overrideFileName = '';
        handledEndedToken = -1;

        if (!normalized || !window.soundcloudAPI || !window.soundcloudAPI.startTrackOverride) {
            overrideActive = false;
            if (window.soundcloudAPI && window.soundcloudAPI.stopTrackOverride) {
                window.soundcloudAPI.stopTrackOverride();
            }
            syncGlobalOverrideState();
            scheduleIndicatorRefresh();
            return;
        }

        refreshVolumeFromDom();

        try {
            const result = await window.soundcloudAPI.startTrackOverride(
                normalized,
                currentOverrideState()
            );

            if (myToken !== activationToken) return;

            overrideActive = Boolean(result && result.active);
            overrideFileName = (result && result.fileName) || '';

            if (overrideActive) {
                protectSoundCloudFromEnding();
            }

            syncGlobalOverrideState();
            scheduleIndicatorRefresh();
        } catch (error) {
            console.error('[SoundCloud] Failed to activate local override:', error);
            overrideActive = false;
            overrideFileName = '';
            window.soundcloudAPI.stopTrackOverride();
            syncGlobalOverrideState();
            scheduleIndicatorRefresh();
        }
    }

    async function refreshCurrentTrack(force) {
        const nextUrl = getCurrentTrackUrl();

        if (!nextUrl) {
            if (currentTrackUrl) {
                activationToken++;
                currentTrackUrl = '';
                overrideActive = false;
                overrideFileName = '';
                localPosition = 0;
                localDuration = 0;
                localIsPlaying = false;
                restoreSoundCloudLoopState();
                window.soundcloudAPI.stopTrackOverride();
                syncGlobalOverrideState();
                scheduleIndicatorRefresh();
            }
            return;
        }

        if (force || nextUrl !== currentTrackUrl) {
            await activateOverride(nextUrl);
        }
    }

    function sendTransportUpdate() {
        if (!overrideActive || !window.soundcloudAPI || !window.soundcloudAPI.updateTrackOverride) {
            return;
        }

        protectSoundCloudFromEnding();

        window.soundcloudAPI.updateTrackOverride({
            volume: overrideVolume,
            isPlaying: isSoundCloudPlaying(),
        });
    }

    function sendSeekUpdate() {
        if (!overrideActive || !window.soundcloudAPI || !window.soundcloudAPI.updateTrackOverride) {
            return;
        }

        setTimeout(() => {
            const position = getSoundCloudPosition();
            window.soundcloudAPI.updateTrackOverride({
                position: position,
                volume: overrideVolume,
                isPlaying: isSoundCloudPlaying(),
            });
        }, 80);
    }

    document.addEventListener('click', event => {
        if (!overrideActive) return;

        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        if (
            target.closest('.waveform') ||
            target.closest('.playbackTimeline')
        ) {
            sendSeekUpdate();
        }
    }, true);

    if (window.soundcloudAPI && window.soundcloudAPI.onTrackOverrideStatus) {
        window.soundcloudAPI.onTrackOverrideStatus(status => {
            if (!status || normalizeUrl(status.trackUrl) !== currentTrackUrl || !overrideActive) {
                return;
            }

            localPosition = Number(status.position) || 0;
            localDuration = Number(status.duration) || 0;
            localIsPlaying = Boolean(status.isPlaying);

            syncGlobalOverrideState();
            renderLocalTime();

            if (status.ended && handledEndedToken !== activationToken) {
                handledEndedToken = activationToken;
                advanceAfterLocalEnd();
            }
        });
    }

    function makeOverrideBadge(id, label, fileName, compact) {
        const badge = document.createElement('span');
        badge.id = id;
        badge.textContent = label;
        badge.title = fileName ? 'Local override: ' + fileName : 'Local track override';
        badge.setAttribute('aria-hidden', 'true');

        Object.assign(badge.style, {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: compact ? '6px' : '0',
            padding: compact ? '1px 5px' : '3px 7px',
            minHeight: compact ? '14px' : '18px',
            border: '1px solid rgba(255, 85, 0, 0.9)',
            borderRadius: '999px',
            background: 'rgba(18, 18, 18, 0.92)',
            color: '#ff5500',
            fontSize: compact ? '8px' : '10px',
            fontWeight: '700',
            lineHeight: '1',
            letterSpacing: '0.04em',
            verticalAlign: 'middle',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            pointerEvents: 'auto',
            zIndex: '2147483647',
        });

        return badge;
    }

    function findVisibleTrackTitle() {
        const headings = Array.from(document.querySelectorAll('h1'));

        return headings.find(heading => {
            const rect = heading.getBoundingClientRect();
            const style = window.getComputedStyle(heading);

            return (
                rect.width > 0 &&
                rect.height > 0 &&
                rect.bottom > 0 &&
                rect.top < window.innerHeight &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                heading.textContent &&
                heading.textContent.trim().length > 0
            );
        }) || null;
    }

    function positionPageBadge(badge) {
        const title = findVisibleTrackTitle();
        if (!title || !badge) return false;

        const rect = title.getBoundingClientRect();
        const badgeRect = badge.getBoundingClientRect();

        let left = rect.right + 10;
        if (left + badgeRect.width > window.innerWidth - 12) {
            left = Math.max(12, rect.left);
        }

        const top = rect.top + Math.max(0, (rect.height - badgeRect.height) / 2);

        badge.style.left = Math.round(left) + 'px';
        badge.style.top = Math.round(top) + 'px';
        return true;
    }

    async function updateOverrideIndicators() {
        if (!window.soundcloudAPI || !window.soundcloudAPI.getTrackOverrideInfo) return;

        const generation = ++indicatorGeneration;
        const playingUrl = getCurrentTrackUrl();
        const pageUrl = normalizeUrl(window.location.href);

        const results = await Promise.all([
            playingUrl
                ? window.soundcloudAPI.getTrackOverrideInfo(playingUrl)
                : Promise.resolve(null),
            isTrackPageUrl(pageUrl)
                ? window.soundcloudAPI.getTrackOverrideInfo(pageUrl)
                : Promise.resolve(null),
        ]);

        if (generation !== indicatorGeneration) return;

        const playingInfo = results[0];
        const pageInfo = results[1];

        const oldPlayerBadge = document.getElementById('soundcloud-local-override-player');
        if (!playingInfo) {
            if (oldPlayerBadge) oldPlayerBadge.remove();
        } else {
            const titleLink = document.querySelector('.playbackSoundBadge__titleLink');
            if (titleLink && !oldPlayerBadge) {
                const badge = makeOverrideBadge(
                    'soundcloud-local-override-player',
                    'LOCAL',
                    playingInfo.fileName,
                    true
                );
                titleLink.insertAdjacentElement('afterend', badge);
            } else if (oldPlayerBadge) {
                oldPlayerBadge.title = playingInfo.fileName
                    ? 'Local override: ' + playingInfo.fileName
                    : 'Local track override';
            }
        }

        let pageBadge = document.getElementById('soundcloud-local-override-page');

        if (!pageInfo) {
            if (pageBadge) pageBadge.remove();
        } else {
            if (!pageBadge) {
                pageBadge = makeOverrideBadge(
                    'soundcloud-local-override-page',
                    'LOCAL OVERRIDE',
                    pageInfo.fileName,
                    false
                );
                pageBadge.style.position = 'fixed';
                pageBadge.style.marginLeft = '0';
                document.body.appendChild(pageBadge);
            } else {
                pageBadge.title = pageInfo.fileName
                    ? 'Local override: ' + pageInfo.fileName
                    : 'Local track override';
            }

            if (!positionPageBadge(pageBadge)) {
                pageBadge.style.display = 'none';
            } else {
                pageBadge.style.display = 'inline-flex';
            }
        }
    }

    function scheduleIndicatorRefresh() {
        if (indicatorRefreshTimer) {
            clearTimeout(indicatorRefreshTimer);
        }

        indicatorRefreshTimer = setTimeout(() => {
            indicatorRefreshTimer = null;
            updateOverrideIndicators().catch(error => {
                console.debug('[SoundCloud] Failed to refresh local override indicators:', error);
            });
        }, 100);
    }

    if (window.soundcloudAPI && window.soundcloudAPI.onTrackOverrideChanged) {
        window.soundcloudAPI.onTrackOverrideChanged(changedUrl => {
            const normalized = normalizeUrl(changedUrl);
            if (normalized && normalized === getCurrentTrackUrl()) {
                refreshCurrentTrack(true);
            }
            scheduleIndicatorRefresh();
        });
    }

    const observer = new MutationObserver(() => {
        const nextUrl = getCurrentTrackUrl();

        if (nextUrl && nextUrl !== currentTrackUrl) {
            refreshCurrentTrack(false);
        }

        if (overrideActive) {
            protectSoundCloudFromEnding();
            renderLocalTime();
        }

        scheduleIndicatorRefresh();
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'class', 'style', 'aria-valuenow'],
    });

    window.addEventListener('scroll', scheduleIndicatorRefresh, true);
    window.addEventListener('resize', scheduleIndicatorRefresh);
    window.addEventListener('popstate', scheduleIndicatorRefresh);
    window.addEventListener('hashchange', scheduleIndicatorRefresh);

    window.addEventListener('beforeunload', () => {
        observer.disconnect();
        restoreSoundCloudLoopState();
        if (window.soundcloudAPI && window.soundcloudAPI.stopTrackOverride) {
            window.soundcloudAPI.stopTrackOverride();
        }
    });

    setInterval(() => {
        const nextUrl = getCurrentTrackUrl();

        if (nextUrl !== currentTrackUrl) {
            refreshCurrentTrack(false);
            return;
        }

        if (overrideActive) {
            sendTransportUpdate();
            renderLocalTime();
        }
    }, 200);

    syncGlobalOverrideState();
    refreshCurrentTrack(false);
    scheduleIndicatorRefresh();
})();
`;

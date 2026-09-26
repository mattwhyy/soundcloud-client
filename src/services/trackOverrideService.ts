/**
 * Renderer-side local track override playback.
 *
 * The SoundCloud track remains the authoritative queue/metadata entry. When a
 * saved override exists, the original stream keeps driving SoundCloud's UI and
 * queue while its audio is muted and a local file is played in sync.
 */
export const trackOverrideScript = `
(function() {
    if (window.__soundcloudTrackOverridesLoaded) return;
    window.__soundcloudTrackOverridesLoaded = true;

    let currentTrackUrl = '';
    let localAudio = null;
    let localObjectUrl = null;
    let sourceAudio = null;
    const sourceAudioMuteStates = new Map();
    let activationToken = 0;

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
            marginLeft: compact ? '6px' : '10px',
            padding: compact ? '1px 5px' : '3px 7px',
            minHeight: compact ? '14px' : '18px',
            border: '1px solid rgba(255, 85, 0, 0.9)',
            borderRadius: '999px',
            background: 'rgba(255, 85, 0, 0.10)',
            color: '#ff5500',
            fontSize: compact ? '8px' : '10px',
            fontWeight: '700',
            lineHeight: '1',
            letterSpacing: '0.04em',
            verticalAlign: 'middle',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            pointerEvents: 'auto',
        });

        return badge;
    }

    let indicatorRefreshTimer = null;
    let indicatorGeneration = 0;

    async function updateOverrideIndicators() {
        if (!window.soundcloudAPI?.getTrackOverrideInfo) return;

        const generation = ++indicatorGeneration;
        const playingUrl = getCurrentTrackUrl();
        const pageUrl = normalizeUrl(window.location.href);

        const [playingInfo, pageInfo] = await Promise.all([
            playingUrl ? window.soundcloudAPI.getTrackOverrideInfo(playingUrl) : Promise.resolve(null),
            isTrackPageUrl(pageUrl)
                ? window.soundcloudAPI.getTrackOverrideInfo(pageUrl)
                : Promise.resolve(null),
        ]);

        if (generation !== indicatorGeneration) return;

        const oldPlayerBadge = document.getElementById('soundcloud-local-override-player');
        if (!playingInfo) {
            oldPlayerBadge?.remove();
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

        const oldPageBadge = document.getElementById('soundcloud-local-override-page');
        if (!pageInfo) {
            oldPageBadge?.remove();
        } else {
            const title =
                document.querySelector('main h1') ||
                document.querySelector('[role="main"] h1') ||
                document.querySelector('h1');

            if (title && !oldPageBadge) {
                const badge = makeOverrideBadge(
                    'soundcloud-local-override-page',
                    'LOCAL OVERRIDE',
                    pageInfo.fileName,
                    false
                );
                title.appendChild(badge);
            } else if (oldPageBadge) {
                oldPageBadge.title = pageInfo.fileName
                    ? 'Local override: ' + pageInfo.fileName
                    : 'Local track override';
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

    function isSoundCloudPlaying() {
        const playButton = document.querySelector('.playControls__play');
        return Boolean(playButton && playButton.classList.contains('playing'));
    }

    function getSoundCloudAudios() {
        return Array.from(document.querySelectorAll('audio'));
    }

    function getActiveSoundCloudAudio() {
        const audios = getSoundCloudAudios();

        return (
            audios.find(audio => !audio.paused && !audio.ended && audio.currentSrc) ||
            audios.find(audio => audio.currentSrc && audio.readyState >= 2) ||
            audios.find(audio => audio.currentSrc) ||
            audios[0] ||
            null
        );
    }

    function forceMuteSoundCloudAudio(audio) {
        if (!audio) return;

        if (!sourceAudioMuteStates.has(audio)) {
            sourceAudioMuteStates.set(audio, audio.muted);
        }

        // Do not change .volume here. SoundCloud is free to keep updating that
        // value and we use it as the source of truth for the local override.
        audio.muted = true;
    }

    function forceMuteAllSoundCloudAudio() {
        const audios = getSoundCloudAudios();
        for (const audio of audios) {
            forceMuteSoundCloudAudio(audio);
        }

        sourceAudio = getActiveSoundCloudAudio();
    }

    function clampVolume(value) {
        return Math.max(0, Math.min(1, Number(value) || 0));
    }

    function getSoundCloudVolume() {
        const root =
            document.querySelector('.playControls__volume .volume') ||
            document.querySelector('.playControls__volume') ||
            document.querySelector('.volume');

        const activeAudio = getActiveSoundCloudAudio();

        // SoundCloud normally reflects its slider on the active media element.
        // Prefer that over DOM geometry because the web UI changes frequently.
        if (activeAudio && Number.isFinite(activeAudio.volume) && activeAudio.volume < 0.999) {
            return clampVolume(activeAudio.volume);
        }

        if (!root) {
            return activeAudio && Number.isFinite(activeAudio.volume)
                ? clampVolume(activeAudio.volume)
                : 1;
        }

        if (root.classList.contains('muted') || root.getAttribute('data-level') === '0') {
            return 0;
        }

        const range =
            root.querySelector('[role="slider"]') ||
            root.querySelector('input[type="range"]');

        if (range) {
            const now = Number(range.getAttribute('aria-valuenow') ?? range.value);
            const min = Number(range.getAttribute('aria-valuemin') ?? range.min ?? 0);
            const max = Number(range.getAttribute('aria-valuemax') ?? range.max ?? 100);

            if (Number.isFinite(now) && Number.isFinite(min) && Number.isFinite(max) && max > min) {
                return clampVolume((now - min) / (max - min));
            }
        }

        const progress = root.querySelector('.volume__sliderProgress');
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

        const handle = root.querySelector('.volume__sliderHandle');
        if (handle && background) {
            const handleRect = handle.getBoundingClientRect();
            const backgroundRect = background.getBoundingClientRect();

            if (backgroundRect.height > 0) {
                const handleCenter = handleRect.top + handleRect.height / 2;
                const ratio = 1 - (handleCenter - backgroundRect.top) / backgroundRect.height;
                if (Number.isFinite(ratio)) {
                    return clampVolume(ratio);
                }
            }
        }

        const level = Number(root.getAttribute('data-level'));
        if (Number.isFinite(level)) {
            return clampVolume(level / 10);
        }

        return activeAudio && Number.isFinite(activeAudio.volume)
            ? clampVolume(activeAudio.volume)
            : 1;
    }

    function parseTime(value) {
        if (!value) return 0;
        return String(value)
            .split(':')
            .map(part => Number(part) || 0)
            .reduce((total, part) => total * 60 + part, 0);
    }

    function getSoundCloudPosition() {
        const activeAudio = getActiveSoundCloudAudio();
        if (activeAudio && Number.isFinite(activeAudio.currentTime)) {
            sourceAudio = activeAudio;
            return activeAudio.currentTime;
        }

        const elapsed = document.querySelector('.playbackTimeline__timePassed span:last-child');
        return parseTime(elapsed ? elapsed.textContent : '');
    }

    function restoreSourceAudio() {
        for (const [audio, wasMuted] of sourceAudioMuteStates.entries()) {
            try {
                audio.muted = wasMuted;
            } catch (_) {}
        }

        sourceAudioMuteStates.clear();
        sourceAudio = null;
    }

    function stopLocalOverride() {
        activationToken++;

        if (localAudio) {
            try {
                localAudio.pause();
                localAudio.src = '';
            } catch (_) {}
        }

        localAudio = null;
        restoreSourceAudio();

        if (localObjectUrl) {
            try {
                URL.revokeObjectURL(localObjectUrl);
            } catch (_) {}
        }
        localObjectUrl = null;
    }

    function attachSourceAudio() {
        // SoundCloud may retain or swap multiple audio elements. Muting only one
        // can leave an older stream faintly audible underneath the override.
        forceMuteAllSoundCloudAudio();

        if (localAudio) {
            localAudio.volume = getSoundCloudVolume();
        }
    }

    async function activateOverride(trackUrl) {
        stopLocalOverride();
        currentTrackUrl = normalizeUrl(trackUrl);
        const myToken = activationToken;

        if (!currentTrackUrl || !window.soundcloudAPI?.getTrackOverrideAudio) {
            return;
        }

        let override;
        try {
            override = await window.soundcloudAPI.getTrackOverrideAudio(currentTrackUrl);
        } catch (error) {
            console.error('[SoundCloud] Could not load local track override:', error);
            return;
        }

        if (myToken !== activationToken || !override || !override.data) {
            return;
        }

        try {
            let bytes;
            if (override.data instanceof ArrayBuffer) {
                bytes = new Uint8Array(override.data);
            } else if (ArrayBuffer.isView(override.data)) {
                bytes = new Uint8Array(
                    override.data.buffer,
                    override.data.byteOffset || 0,
                    override.data.byteLength
                );
            } else {
                bytes = new Uint8Array(override.data);
            }

            const blob = new Blob([bytes], {
                type: override.mimeType || 'application/octet-stream'
            });

            localObjectUrl = URL.createObjectURL(blob);
            localAudio = new Audio(localObjectUrl);
            localAudio.preload = 'auto';

            attachSourceAudio();

            const syncInitialPosition = () => {
                if (!localAudio) return;
                const position = getSoundCloudPosition();
                if (Number.isFinite(position) && position >= 0) {
                    try {
                        localAudio.currentTime = Math.min(position, localAudio.duration || position);
                    } catch (_) {}
                }

                if (isSoundCloudPlaying()) {
                    localAudio.play().catch(error => {
                        console.debug('[SoundCloud] Local override play was deferred:', error);
                    });
                }
            };

            if (localAudio.readyState >= 1) {
                syncInitialPosition();
            } else {
                localAudio.addEventListener('loadedmetadata', syncInitialPosition, { once: true });
            }

            console.log(
                '[SoundCloud] Playing local override for',
                currentTrackUrl,
                '(' + (override.fileName || 'local file') + ')'
            );
        } catch (error) {
            console.error('[SoundCloud] Failed to initialize local track override:', error);
            stopLocalOverride();
        }
    }

    async function refreshCurrentTrack(force) {
        const nextUrl = getCurrentTrackUrl();
        if (!nextUrl) {
            if (currentTrackUrl) {
                currentTrackUrl = '';
                stopLocalOverride();
            }
            return;
        }

        if (force || nextUrl !== currentTrackUrl) {
            await activateOverride(nextUrl);
        }
    }

    // SoundCloud remains the transport/queue authority. Mirror its current
    // playback state, seek position and volume to the local file.
    setInterval(() => {
        const nextUrl = getCurrentTrackUrl();

        if (nextUrl !== currentTrackUrl) {
            refreshCurrentTrack(false);
            return;
        }

        if (!localAudio) return;

        attachSourceAudio();

        const shouldPlay = isSoundCloudPlaying();
        if (shouldPlay && localAudio.paused && !localAudio.ended) {
            localAudio.play().catch(() => {});
        } else if (!shouldPlay && !localAudio.paused) {
            localAudio.pause();
        }

        const targetPosition = getSoundCloudPosition();
        if (
            Number.isFinite(targetPosition) &&
            Number.isFinite(localAudio.currentTime) &&
            Math.abs(localAudio.currentTime - targetPosition) > 1.25
        ) {
            try {
                localAudio.currentTime = Math.min(
                    targetPosition,
                    Number.isFinite(localAudio.duration) ? localAudio.duration : targetPosition
                );
            } catch (_) {}
        }
    }, 250);

    if (window.soundcloudAPI?.onTrackOverrideChanged) {
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
        scheduleIndicatorRefresh();
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href']
    });

    window.addEventListener('beforeunload', () => {
        observer.disconnect();
        stopLocalOverride();
    });

    refreshCurrentTrack(false);
    scheduleIndicatorRefresh();

    window.addEventListener('popstate', scheduleIndicatorRefresh);
    window.addEventListener('hashchange', scheduleIndicatorRefresh);
})();
`;
